import { mkdtempSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BGOSAdapter } from "../src/adapter.js";
import { BgosApi } from "../src/bgos-api.js";
import { BgosOutbound } from "../src/outbound.js";
import {
  BOARDS_LOOP_GUARD_LIMIT,
  BOARDS_RESULT_HEADER,
} from "../src/boards-marker.js";
import { BoardsOrchestrator } from "../src/boards-orchestrator.js";
import {
  buildReplyHandle,
  createInboundHandler,
  type DispatchArgs,
  type InboundHandlerDeps,
  type ReplyHandle,
} from "../src/inbound-handler.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

/**
 * The [[BGOS_BOARDS]] round trip wiring (Gobot port of the Hermes
 * test_boards_adapter.py suite): interception strips the marker and
 * schedules execution; the result comes back as ONE synthetic system turn
 * through the fork dispatch function; denial bodies verbatim; malformed
 * blocks answered, never silenced; and a per chat loop guard that refuses
 * ONCE then goes quiet until real inbound re-arms it.
 *
 * Canonical repo deltas vs the original mirror suite:
 *   - the attach op runs the agent supplied path through the outbound
 *     media guard (resolveAllowedMediaPath), so these tests pin
 *     GOBOT_MEDIA_ROOT to the temp dir and add a rejection case;
 *   - the button click reset is owned by BGOSAdapter.routeInboundClick
 *     (this repo has no createInboundClickHandler), so that test drives
 *     the adapter.
 */

const ASSISTANT_ID = 7;
const CHAT_ID = 42;
const BOARDS_ROOT = `/api/v1/integrations/assistants/${ASSISTANT_ID}/boards`;
const TOKEN = "pair_" + "x".repeat(30);

function block(payload: unknown): string {
  return `[[BGOS_BOARDS]]${JSON.stringify(payload)}[[/BGOS_BOARDS]]`;
}

function makeApi(baseUrl: string): BgosApi {
  return new BgosApi({
    baseUrl,
    pairingToken: TOKEN,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

const stubReplyHandle = { origin: "bgos" } as unknown as ReplyHandle;

function makeOrchestrator(
  api: BgosApi,
  dispatched: DispatchArgs[],
  opts: { dispatchAvailable?: boolean } = {},
): BoardsOrchestrator {
  return new BoardsOrchestrator({
    api,
    getTurnContext: () => {
      if (opts.dispatchAvailable === false) return null;
      return {
        dispatch: async (args) => {
          dispatched.push(args);
        },
        agentRoute: "general",
        userId: "u1",
        systemPrompt: "You are Echo.",
        replyHandle: stubReplyHandle,
      };
    },
    log: () => {},
  });
}

describe("BoardsOrchestrator (Gobot)", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it("strips the marker, executes the REST call, and dispatches a result turn", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
    server.stage("POST", `${BOARDS_ROOT}/Tasks/rows/query`, 200, {
      markdown: "| key | Title |\n| ab12cd34 | Fix login |",
    });

    const { cleanedText, hadBlocks } = boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      "Let me check the board.\n" +
        block({ op: "query", board: "Tasks", reqId: "q1", limit: 20 }),
    );
    expect(cleanedText).toBe("Let me check the board.");
    expect(hadBlocks).toBe(true);
    await boards.flush();

    // The REST call carried the plan's path, format knob and body.
    const calls = server.requests.filter((r) => r.method === "POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BOARDS_ROOT}/Tasks/rows/query?format=markdown`);
    expect(calls[0]!.body).toEqual({ limit: 20 });

    // ONE synthetic system turn, correlated by reqId, markdown verbatim.
    expect(dispatched).toHaveLength(1);
    const turn = dispatched[0]!;
    expect(turn.text.startsWith(BOARDS_RESULT_HEADER)).toBe(true);
    expect(turn.text).toContain("reqId=q1 op=query ok");
    expect(turn.text).toContain("| ab12cd34 | Fix login |");
    expect(turn.system).toBe(true);
    expect(turn.assistantId).toBe(ASSISTANT_ID);
    expect(turn.chatId).toBe(CHAT_ID);
  });

  it("passes a backend denial body through verbatim", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
    const denial = {
      error: "not_found_board",
      message: "No board matches this request.",
    };
    server.stage("PATCH", `${BOARDS_ROOT}/Tasks/rows/r9`, 403, denial);

    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({
        op: "update",
        board: "Tasks",
        row: "r9",
        cells: { status: "done" },
        reqId: "w1",
      }),
    );
    await boards.flush();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.text).toContain("reqId=w1 op=update error status=403");
    expect(dispatched[0]!.text).toContain(JSON.stringify(denial));
  });

  it("answers a malformed block without making any REST call", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);

    const { cleanedText, hadBlocks } = boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      "[[BGOS_BOARDS]]{not json}[[/BGOS_BOARDS]]",
    );
    expect(hadBlocks).toBe(true);
    expect(cleanedText).toBe("");
    await boards.flush();

    expect(server.requests).toHaveLength(0);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.text).toContain("malformed_request");
    expect(dispatched[0]!.text).toContain("error status=0");
  });

  it("correlates two calls to their own sections in request order", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "BOARDS-LIST" });
    server.stage("POST", `${BOARDS_ROOT}/Tasks/rows`, 201, { key: "r77" });

    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "a" }) +
        "\n" +
        block({ op: "insert", board: "Tasks", cells: { t: "x" }, reqId: "b" }),
    );
    await boards.flush();

    expect(dispatched).toHaveLength(1);
    const text = dispatched[0]!.text;
    const aAt = text.indexOf("reqId=a op=list ok");
    const listAt = text.indexOf("BOARDS-LIST");
    const bAt = text.indexOf("reqId=b op=insert ok");
    expect(aAt).toBeGreaterThanOrEqual(0);
    expect(listAt).toBeGreaterThan(aAt);
    expect(bAt).toBeGreaterThan(listAt);
  });

  it("refuses at the loop guard limit, then goes quiet", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);

    // Six chained result turns arm the guard.
    for (let i = 0; i < BOARDS_LOOP_GUARD_LIMIT; i++) {
      server.stage("GET", BOARDS_ROOT, 200, { markdown: `round ${i}` });
      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({ op: "list", reqId: `r${i}` }),
      );
      await boards.flush();
    }
    expect(dispatched).toHaveLength(BOARDS_LOOP_GUARD_LIMIT);

    // The next batch is refused ONCE, with no REST call executed.
    const requestsBefore = server.requests.length;
    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "refused" }),
    );
    await boards.flush();
    expect(server.requests).toHaveLength(requestsBefore);
    expect(dispatched).toHaveLength(BOARDS_LOOP_GUARD_LIMIT + 1);
    const refusal = dispatched[BOARDS_LOOP_GUARD_LIMIT]!.text;
    expect(refusal).toContain("loop_guard");
    expect(refusal).toContain("reqId=refused");

    // Beyond the refusal: QUIET. A guard that keeps replying becomes the
    // loop it exists to stop.
    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "dropped" }),
    );
    await boards.flush();
    expect(server.requests).toHaveLength(requestsBefore);
    expect(dispatched).toHaveLength(BOARDS_LOOP_GUARD_LIMIT + 1);
  });

  it("a loop guard reset re-arms board calls", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
    for (let i = 0; i < BOARDS_LOOP_GUARD_LIMIT + 1; i++) {
      if (i < BOARDS_LOOP_GUARD_LIMIT) {
        server.stage("GET", BOARDS_ROOT, 200, { markdown: `round ${i}` });
      }
      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({ op: "list", reqId: `r${i}` }),
      );
      await boards.flush();
    }
    // Guard has refused; a real inbound resets it.
    boards.resetLoopGuard(CHAT_ID);
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "after reset" });
    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "again" }),
    );
    await boards.flush();
    const last = dispatched[dispatched.length - 1]!;
    expect(last.text).toContain("reqId=again op=list ok");
    expect(last.text).toContain("after reset");
  });

  it("drops the batch with a log when no dispatch context exists", async () => {
    const dispatched: DispatchArgs[] = [];
    const boards = makeOrchestrator(makeApi(baseUrl), dispatched, {
      dispatchAvailable: false,
    });
    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "x" }),
    );
    await boards.flush();
    expect(dispatched).toHaveLength(0);
  });

  describe("attach", () => {
    let dir: string;
    const originalMediaRoot = process.env.GOBOT_MEDIA_ROOT;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "gobot-boards-"));
      // The attach op reads a local file through the outbound media guard;
      // pin the allowed root to this test's temp dir.
      process.env.GOBOT_MEDIA_ROOT = dir;
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      if (originalMediaRoot === undefined) delete process.env.GOBOT_MEDIA_ROOT;
      else process.env.GOBOT_MEDIA_ROOT = originalMediaRoot;
    });

    it("uploads a small file inline as content_base64", async () => {
      const dispatched: DispatchArgs[] = [];
      const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
      const filePath = join(dir, "report.txt");
      writeFileSync(filePath, "hello boards");
      server.stage(
        "POST",
        `${BOARDS_ROOT}/Tasks/rows/r1/attachments`,
        201,
        { attachmentId: 5 },
      );

      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({
          op: "attach",
          board: "Tasks",
          row: "r1",
          path: filePath,
          fieldKey: "proof",
          reqId: "at1",
        }),
      );
      await boards.flush();

      const post = server.requests[0]!;
      expect(post.url).toBe(`${BOARDS_ROOT}/Tasks/rows/r1/attachments`);
      const body = post.body as Record<string, unknown>;
      expect(body.name).toBe("report.txt");
      expect(body.field_key).toBe("proof");
      expect(
        Buffer.from(String(body.content_base64), "base64").toString("utf8"),
      ).toBe("hello boards");
      expect(dispatched[0]!.text).toContain("reqId=at1 op=attach ok");
      expect(dispatched[0]!.text).toContain('"attachmentId":5');
    });

    it("uses the presigned flow above the inline threshold and echoes the attachmentId", async () => {
      const dispatched: DispatchArgs[] = [];
      const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
      const filePath = join(dir, "big.bin");
      writeFileSync(filePath, Buffer.alloc(600 * 1024, 7));
      server.stage(
        "POST",
        `${BOARDS_ROOT}/Tasks/rows/r1/attachments`,
        201,
        { uploadUrl: `${baseUrl}/presigned-put`, attachmentId: 9 },
      );
      server.stage("PUT", "/presigned-put", 200, {});
      server.stage(
        "POST",
        `${BOARDS_ROOT}/Tasks/attachments/9/complete`,
        201,
        { ok: true },
      );

      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({
          op: "attach",
          board: "Tasks",
          row: "r1",
          path: filePath,
          reqId: "at2",
        }),
      );
      await boards.flush();

      const methods = server.requests.map((r) => `${r.method} ${r.url.split("?")[0]}`);
      expect(methods).toEqual([
        `POST ${BOARDS_ROOT}/Tasks/rows/r1/attachments`,
        "PUT /presigned-put",
        `POST ${BOARDS_ROOT}/Tasks/attachments/9/complete`,
      ]);
      const meta = server.requests[0]!.body as Record<string, unknown>;
      expect(meta.content_base64).toBeUndefined();
      // Parity with the inline path: the agent needs the id to mint a
      // download URL later.
      expect(dispatched[0]!.text).toContain("reqId=at2 op=attach ok");
      expect(dispatched[0]!.text).toContain('"attachmentId":9');
    });

    it("refuses a file over the 25 MB cap locally", async () => {
      const dispatched: DispatchArgs[] = [];
      const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
      const filePath = join(dir, "huge.bin");
      writeFileSync(filePath, "");
      truncateSync(filePath, 26 * 1024 * 1024); // sparse, no real bytes

      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({
          op: "attach",
          board: "Tasks",
          row: "r1",
          path: filePath,
          reqId: "at3",
        }),
      );
      await boards.flush();

      expect(server.requests).toHaveLength(0);
      expect(dispatched[0]!.text).toContain("reqId=at3 op=attach error status=0");
      expect(dispatched[0]!.text).toContain("file_too_large");
    });

    it("answers file_not_found for a missing path", async () => {
      const dispatched: DispatchArgs[] = [];
      const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({
          op: "attach",
          board: "Tasks",
          row: "r1",
          path: join(dir, "nope.bin"),
          reqId: "at4",
        }),
      );
      await boards.flush();
      expect(server.requests).toHaveLength(0);
      expect(dispatched[0]!.text).toContain("file_not_found");
    });

    it("refuses a path outside the media root (guard parity with outbound sends)", async () => {
      // SECURITY: without this, the attach op would be a route around the
      // resolveAllowedMediaPath allowlist that every other outbound file
      // send goes through (an agent could exfiltrate any host readable
      // file onto a board). The guard must run BEFORE any bytes are read
      // and the file must never reach the backend.
      const dispatched: DispatchArgs[] = [];
      const boards = makeOrchestrator(makeApi(baseUrl), dispatched);
      const outside = mkdtempSync(join(tmpdir(), "gobot-outside-"));
      const filePath = join(outside, "secret.txt");
      writeFileSync(filePath, "should never leave the host");
      try {
        boards.interceptOutbound(
          ASSISTANT_ID,
          CHAT_ID,
          block({
            op: "attach",
            board: "Tasks",
            row: "r1",
            path: filePath,
            reqId: "at5",
          }),
        );
        await boards.flush();
        expect(server.requests).toHaveLength(0);
        expect(dispatched[0]!.text).toContain(
          "reqId=at5 op=attach error status=0",
        );
        expect(dispatched[0]!.text).toContain("path_not_allowed");
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});

describe("ReplyHandle boards interception (Gobot)", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    // Keep saveLastId away from the real ~/.gobot cursor.
    tempHome = mkdtempSync(join(tmpdir(), "gobot-home-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  function makeDeps(
    dispatched: DispatchArgs[],
  ): { deps: InboundHandlerDeps; boards: BoardsOrchestrator } {
    const api = makeApi(baseUrl);
    const boards = makeOrchestrator(api, dispatched);
    const deps: InboundHandlerDeps = {
      outbound: new BgosOutbound(api),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        dispatched.push(args);
      },
      getSystemPrompt: () => "You are Echo.",
      boards,
    };
    return { deps, boards };
  }

  it("sendText posts the cleaned text and schedules the board call", async () => {
    const dispatched: DispatchArgs[] = [];
    const { deps, boards } = makeDeps(dispatched);
    server.stage("POST", "/api/v1/messages", 201, { id: 900 });
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "L" });

    const handle = buildReplyHandle(
      { outbound: deps.outbound, boards },
      { assistantId: ASSISTANT_ID, chatId: CHAT_ID },
    );
    const res = await handle.sendText(
      "On it.\n" + block({ op: "list", reqId: "q" }),
    );
    expect(res.id).toBe(900);
    await boards.flush();

    const post = server.requests.find(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(post).toBeDefined();
    expect((post!.body as Record<string, unknown>).text).toBe("On it.");
    expect(dispatched.some((d) => d.text.includes("reqId=q op=list ok"))).toBe(
      true,
    );
  });

  it("a boards-only reply posts no visible message", async () => {
    const dispatched: DispatchArgs[] = [];
    const { deps, boards } = makeDeps(dispatched);
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "L" });

    const handle = buildReplyHandle(
      { outbound: deps.outbound, boards },
      { assistantId: ASSISTANT_ID, chatId: CHAT_ID },
    );
    const res = await handle.sendText(block({ op: "list", reqId: "solo" }));
    expect(res.id).toBe(-1);
    await boards.flush();

    const messagePosts = server.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(messagePosts).toHaveLength(0);
    expect(dispatched).toHaveLength(1);
  });

  it("a real inbound message resets the loop guard", async () => {
    const dispatched: DispatchArgs[] = [];
    const { deps, boards } = makeDeps(dispatched);

    // Arm the guard into its quiet state.
    for (let i = 0; i < BOARDS_LOOP_GUARD_LIMIT + 1; i++) {
      if (i < BOARDS_LOOP_GUARD_LIMIT) {
        server.stage("GET", BOARDS_ROOT, 200, { markdown: `r${i}` });
      }
      boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({ op: "list", reqId: `r${i}` }),
      );
      await boards.flush();
    }
    const armedCount = dispatched.length;

    // A real inbound user message re-arms board calls.
    const handler = createInboundHandler(deps);
    await handler({
      assistantId: ASSISTANT_ID,
      userId: "u1",
      chatId: CHAT_ID,
      messageId: 1000,
      text: "how is the board looking?",
      files: [],
      messageType: "standard",
    });

    server.stage("GET", BOARDS_ROOT, 200, { markdown: "fresh" });
    boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "fresh" }),
    );
    await boards.flush();
    const last = dispatched[dispatched.length - 1]!;
    expect(dispatched.length).toBeGreaterThan(armedCount);
    expect(last.text).toContain("reqId=fresh op=list ok");
  });

  it("composes with the mission marker lane: prose + boards + mission in one reply", async () => {
    // The boards intercept runs BEFORE the outbound's mission stripping;
    // the delimiters are distinct and both lanes must fire off one reply
    // while the user sees only the prose.
    const dispatched: DispatchArgs[] = [];
    const { deps, boards } = makeDeps(dispatched);
    server.stage("POST", "/api/v1/messages", 201, { id: 901 });
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "L" });
    server.stage(
      "POST",
      `/api/v1/integrations/assistants/${ASSISTANT_ID}/missions`,
      201,
      { ok: true, mission: { id: 11 } },
    );

    const handle = buildReplyHandle(
      { outbound: deps.outbound, boards },
      { assistantId: ASSISTANT_ID, chatId: CHAT_ID },
    );
    const res = await handle.sendText(
      "Working on it.\n" +
        block({ op: "list", reqId: "mix" }) +
        "\n" +
        '[[BGOS_MISSION]]{"op":"create","title":"Board sweep"}[[/BGOS_MISSION]]',
    );
    expect(res.id).toBe(901);
    await boards.flush();
    // The mission queue is fire-and-forget; wait for its POST to land.
    await vi.waitFor(() => {
      expect(
        server.requests.some((r) => r.url.includes("/missions")),
      ).toBe(true);
    });

    const post = server.requests.find(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(post).toBeDefined();
    // The mission lane preserves surrounding bytes (its documented
    // behavior), so pin on marker absence rather than exact whitespace.
    const visible = String((post!.body as Record<string, unknown>).text);
    expect(visible).toContain("Working on it.");
    expect(visible).not.toContain("BGOS_BOARDS");
    expect(visible).not.toContain("BGOS_MISSION");
    expect(dispatched.some((d) => d.text.includes("reqId=mix op=list ok"))).toBe(
      true,
    );
  });

  it("composes with the mission marker lane: markers-only reply posts no bubble", async () => {
    // boards block + mission block and NO prose: boards strips its block
    // (leaving the mission block, so no {id: -1} short-circuit), then the
    // outbound's mission lane strips the rest and skips the empty bubble
    // ({id: 0}). Both lanes execute; the user sees nothing.
    const dispatched: DispatchArgs[] = [];
    const { deps, boards } = makeDeps(dispatched);
    server.stage("GET", BOARDS_ROOT, 200, { markdown: "L" });
    server.stage(
      "POST",
      `/api/v1/integrations/assistants/${ASSISTANT_ID}/missions`,
      201,
      { ok: true, mission: { id: 12 } },
    );

    const handle = buildReplyHandle(
      { outbound: deps.outbound, boards },
      { assistantId: ASSISTANT_ID, chatId: CHAT_ID },
    );
    const res = await handle.sendText(
      block({ op: "list", reqId: "silent" }) +
        "\n" +
        '[[BGOS_MISSION]]{"op":"create","title":"Quiet sweep"}[[/BGOS_MISSION]]',
    );
    expect(res.id).toBe(0);
    await boards.flush();
    await vi.waitFor(() => {
      expect(
        server.requests.some((r) => r.url.includes("/missions")),
      ).toBe(true);
    });

    const messagePosts = server.requests.filter(
      (r) => r.method === "POST" && r.url.startsWith("/api/v1/messages"),
    );
    expect(messagePosts).toHaveLength(0);
    expect(
      dispatched.some((d) => d.text.includes("reqId=silent op=list ok")),
    ).toBe(true);
  });

  it("a button click resets the loop guard (adapter routeInboundClick)", async () => {
    // Canonical repo delta: inbound clicks route through the adapter's
    // routeInboundClick (approval precedence + onButtonClick forward),
    // not a standalone handler; the reset lives there.
    const dispatched: DispatchArgs[] = [];
    const adapter = new BGOSAdapter({ baseUrl, pairingToken: TOKEN });
    adapter.setDispatch(async (args) => {
      dispatched.push(args);
    });
    (adapter as unknown as {
      assistantToRoute: Map<number, string>;
    }).assistantToRoute.set(ASSISTANT_ID, "general");

    for (let i = 0; i < BOARDS_LOOP_GUARD_LIMIT + 1; i++) {
      if (i < BOARDS_LOOP_GUARD_LIMIT) {
        server.stage("GET", BOARDS_ROOT, 200, { markdown: `r${i}` });
      }
      adapter.boards.interceptOutbound(
        ASSISTANT_ID,
        CHAT_ID,
        block({ op: "list", reqId: `r${i}` }),
      );
      await adapter.boards.flush();
    }

    await (adapter as unknown as {
      routeInboundClick: (c: unknown) => Promise<void>;
    }).routeInboundClick({
      assistantId: ASSISTANT_ID,
      userId: "u1",
      chatId: CHAT_ID,
      messageId: 1001,
      optionId: 3,
      callbackData: "pick:a",
      buttonText: "Option A",
    });

    server.stage("GET", BOARDS_ROOT, 200, { markdown: "after click" });
    adapter.boards.interceptOutbound(
      ASSISTANT_ID,
      CHAT_ID,
      block({ op: "list", reqId: "clicked" }),
    );
    await adapter.boards.flush();
    const last = dispatched[dispatched.length - 1]!;
    expect(last.text).toContain("reqId=clicked op=list ok");
  });

  it("stop() finishes even when a boards task never settles (bounded drain)", async () => {
    // stop() is also the self-update shutdown hook; a boards result turn
    // is a full agent turn and may chain, so the drain must race a
    // deadline instead of waiting forever.
    const adapter = new BGOSAdapter({ baseUrl, pairingToken: TOKEN });
    (adapter as unknown as { started: boolean }).started = true;
    (adapter as unknown as { boardsStopDrainMs: number }).boardsStopDrainMs = 50;
    (
      adapter.boards as unknown as { pending: Set<Promise<void>> }
    ).pending.add(new Promise<void>(() => {}));

    const outcome = await Promise.race([
      adapter.stop().then(() => "stopped" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(outcome).toBe("stopped");
  });
});
