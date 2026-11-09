/**
 * Another agent's message in a group or a channel wakes this agent, and the
 * agent's own message never does.
 *
 * The rows are shaped like the ones the BGOS backend sends, and each one goes
 * the whole way a real row goes: the socket's (or the poll's) normalizer,
 * then the inbound handler, then the dispatch to the agent.
 *
 *  - the live push (`inbound_message`): camelCase, `senderType: 'room_agent'`
 *    with the author's `senderAssistantId`, no human sender block, `userId`
 *    set to the RECEIVING agent's owner, and `groupContext.chatKind`;
 *  - the inbound poll (`GET /integrations/inbound`): snake_case keys with the
 *    same camelCase `senderType` and `senderAssistantId`, plus `chat_kind`.
 *
 * Each case runs on both lanes and in both a group (`room`) and a channel.
 * The own row case is the reply loop guard.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BoardsOrchestrator } from "../src/boards-orchestrator.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import {
  createInboundHandler,
  type DispatchArgs,
} from "../src/inbound-handler.js";
import type { InboundMessagePayload } from "../src/types.js";
import { loadAgentCursor } from "../src/last-id-store.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const OWN_ASSISTANT_ID = 1;
const OTHER_ASSISTANT_ID = 42;
const CHAT_ID = 300;

const SERVER_FRAMED =
  "You are in the group Launch.\n" +
  "Testbot, an agent seated here and not a person, wrote the message below.\n" +
  "@Mockbot can you check the build?";
const UNFRAMED = "@Mockbot can you check the build?";

/** Chained board result turns the loop guard has counted in the chat. */
const GUARD_COUNT = 3;

function loopGuard(boards: BoardsOrchestrator): Map<number, number> {
  return (boards as unknown as { consecutiveResults: Map<number, number> })
    .consecutiveResults;
}

const FRAMING_SENTENCE =
  "Testbot, an agent seated here and not a person, wrote the message below.";

/**
 * The server's own framing of another agent's row, as group-context.ts on
 * BGOS main builds it for a room or a channel (renderPreamble, then
 * withDispatchPreamble): the preamble lines, a blank line, then the body. The
 * server frames an empty body too, so it arrives as the preamble and the
 * blank line with nothing after them.
 *
 *  - By default the room was read: names, a backlog line (the push's shape;
 *    the poll sends no backlog) and the line naming the agent that wrote it.
 *  - `followUp`: the follow-up window's line as well.
 *  - `noRoster`: the poll could not read the room. No names and no backlog.
 *    A row it knows is a follow-up is still said to be another agent's
 *    (followUpWithoutRoster(true)); any other row gets no line naming the
 *    writer at all.
 */
function serverFramed(
  body: string,
  shape: { followUp?: boolean; noRoster?: boolean } = {},
): string {
  const lines = shape.noRoster
    ? ["[BGOS group]"]
    : ["[BGOS group: Launch]"];
  lines.push(
    "You are in a group, not a private chat. Everyone listed here reads what you say.",
  );
  if (!shape.noRoster) {
    lines.push(
      "People here: Ada.",
      "Agents here: Testbot, Mockbot (you).",
      "Said in this group since your last turn, oldest first:",
      "- Ada: ship it\n  once the checks pass",
      FRAMING_SENTENCE,
    );
  } else if (shape.followUp) {
    lines.push(
      "Another agent, an agent seated here and not a person, wrote the message below.",
    );
  }
  if (shape.followUp) {
    lines.push(
      "You were not named in this message. You were woken in this group by a " +
        "recent message, so you also see the next messages after it as a " +
        "follow-up. Reply only if it is meant for you; if it is not, stay " +
        "silent and send nothing.",
    );
  }
  lines.push(
    "Only this group is shared context. Your private chats with your owner, " +
      "your other chats and groups, and anything you know from work done " +
      "outside this group stay private. Do not repeat them, refer to them, " +
      "or act on them here unless someone in this group raises them first.",
  );
  return lines.join("\n") + "\n\n" + body;
}

type Lane = "push" | "poll";
type ChatKind = "room" | "channel";
const LANES: Lane[] = ["push", "poll"];
const CHAT_KINDS: ChatKind[] = ["room", "channel"];
const CASES = LANES.flatMap((lane) =>
  CHAT_KINDS.map((chatKind) => ({ lane, chatKind })),
);

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function pushFrame(chatKind: ChatKind, extra: Record<string, unknown>) {
  return {
    assistantId: OWN_ASSISTANT_ID,
    userId: "owner_1",
    chatId: CHAT_ID,
    messageId: 901,
    text: SERVER_FRAMED,
    files: [],
    messageType: "standard",
    groupContext: { chatKind, chatTitle: "Launch" },
    ...extra,
  };
}

function pollRow(chatKind: ChatKind, extra: Record<string, unknown>) {
  return {
    id: 901,
    message_id: 901,
    chat_id: CHAT_ID,
    text: SERVER_FRAMED,
    files: [],
    chat_kind: chatKind,
    groupContext: { chatKind, chatTitle: "Launch" },
    message_type: "standard",
    command_name: null,
    command_args: null,
    created_at: "2026-11-09T08:00:00.000Z",
    assistant_id: OWN_ASSISTANT_ID,
    agent_route: "general",
    user_id: "owner_1",
    ...extra,
  };
}

function roomAgent(author: number | undefined): Record<string, unknown> {
  return author === undefined
    ? { senderType: "room_agent" }
    : { senderType: "room_agent", senderAssistantId: author };
}

describe("another agent's message in a group or channel wakes the agent", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-room-agent-wake-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  /** Hand one row to the agent on the given lane, the way BGOS would. */
  async function deliver(
    lane: Lane,
    chatKind: ChatKind,
    extra: Record<string, unknown>,
    boards?: BoardsOrchestrator,
  ): Promise<DispatchArgs[]> {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const raw = lane === "push" ? pushFrame(chatKind, extra) : pollRow(chatKind, extra);
    const normalized = (ws as unknown as {
      normalizeInbound(r: unknown): InboundMessagePayload | null;
    }).normalizeInbound(raw);
    expect(normalized).not.toBeNull();
    const seen: DispatchArgs[] = [];
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen.push(args);
      },
      boards,
    });
    await handler(normalized!);
    return seen;
  }

  /**
   * The boards orchestrator after GUARD_COUNT chained board result turns in
   * this chat: its loop guard counts them per stretch of silence, and a real
   * inbound message re-arms it.
   */
  function guardedBoards(): BoardsOrchestrator {
    const boards = new BoardsOrchestrator({
      api: makeApi(baseUrl),
      getTurnContext: () => null,
      log: () => {},
    });
    loopGuard(boards).set(CHAT_ID, GUARD_COUNT);
    return boards;
  }

  /** Hand several rows to ONE handler, in order, the way one gateway gets them. */
  async function deliverAll(
    rows: Array<[Lane, Record<string, unknown>]>,
  ): Promise<DispatchArgs[]> {
    const ws = new BgosWs({} as never, makeApi(baseUrl));
    const seen: DispatchArgs[] = [];
    const handler = createInboundHandler({
      outbound: new BgosOutbound(makeApi(baseUrl)),
      getRouteForAssistant: () => "general",
      getDispatch: () => async (args) => {
        seen.push(args);
      },
    });
    for (const [lane, extra] of rows) {
      const raw = lane === "push" ? pushFrame("room", extra) : pollRow("room", extra);
      const normalized = (ws as unknown as {
        normalizeInbound(r: unknown): InboundMessagePayload | null;
      }).normalizeInbound(raw);
      expect(normalized).not.toBeNull();
      await handler(normalized!);
    }
    return seen;
  }

  it("an agent's row the poll read before its text wakes the agent once its text is pushed", async () => {
    // The poll serves an agent's row as soon as it exists; the push waits
    // until it has settled and then delivers it, under the same id. The
    // empty read must not make the settled push look like a duplicate.
    const text = serverFramed("@Mockbot can you check the build?");
    const seen = await deliverAll([
      ["poll", { text: serverFramed(""), ...roomAgent(OTHER_ASSISTANT_ID) }],
      ["push", { text, ...roomAgent(OTHER_ASSISTANT_ID) }],
      ["poll", { text, ...roomAgent(OTHER_ASSISTANT_ID) }],
    ]);
    expect(seen.map((s) => s.text)).toEqual([text]);
  });

  it("an agent's empty row still moves the agent's cursor past it", async () => {
    await deliverAll([
      ["poll", { text: serverFramed(""), ...roomAgent(OTHER_ASSISTANT_ID) }],
    ]);
    expect(loadAgentCursor(OWN_ASSISTANT_ID)).toBe(901);
  });

  for (const { lane, chatKind } of CASES) {
    for (const [framing, text] of [
      ["framed", SERVER_FRAMED],
      ["unframed", UNFRAMED],
    ] as const) {
      it(`${lane}, ${chatKind}, ${framing}: another agent's message wakes the agent as another agent`, async () => {
        const seen = await deliver(lane, chatKind, {
          text,
          ...roomAgent(OTHER_ASSISTANT_ID),
        });
        expect(seen).toHaveLength(1);
        // The agent is told who wrote it: another agent, never its owner.
        expect(seen[0]!.senderType).toBe("room_agent");
        expect(seen[0]!.senderAssistantId).toBe(OTHER_ASSISTANT_ID);
        expect(seen[0]!.text).toMatch(/not a person/);
      });
    }

    it(`${lane}, ${chatKind}: the agent's own message does not wake it`, async () => {
      const seen = await deliver(lane, chatKind, roomAgent(OWN_ASSISTANT_ID));
      expect(seen).toHaveLength(0);
    });

    it(`${lane}, ${chatKind}: another agent's message with no author does not wake it`, async () => {
      // The marker without a readable author cannot be told apart from the
      // agent's own message, so it is not delivered (the Claude Code
      // plugin's rule, isOwnRoomAgentMessage). Waking on it could loop.
      const seen = await deliver(lane, chatKind, roomAgent(undefined));
      expect(seen).toHaveLength(0);
    });

    for (const [label, text] of [
      ["empty", ""],
      ["null", null],
    ] as const) {
      it(`${lane}, ${chatKind}: another agent's ${label} message does not wake it`, async () => {
        // The poll can hand over an agent's row before its first edit.
        // Nothing to read: the framing line alone must not wake the agent.
        const seen = await deliver(lane, chatKind, {
          text,
          ...roomAgent(OTHER_ASSISTANT_ID),
        });
        expect(seen).toHaveLength(0);
      });
    }

    for (const [shapeLabel, shape] of [
      ["", {}],
      [" as a follow-up", { followUp: true }],
      [" with no roster", { noRoster: true }],
      [" as a follow-up with no roster", { followUp: true, noRoster: true }],
    ] as const) {
      for (const [label, body] of [
        ["empty", ""],
        ["blank", "  \n "],
      ] as const) {
        it(`${lane}, ${chatKind}: another agent's ${label} message in the server's framing${shapeLabel} does not wake it`, async () => {
          // The server frames an empty body as well: the text is the
          // preamble and a blank line, so it is not empty, but there is
          // still nothing to read.
          const seen = await deliver(lane, chatKind, {
            text: serverFramed(body, shape),
            ...roomAgent(OTHER_ASSISTANT_ID),
          });
          expect(seen).toHaveLength(0);
        });
      }
    }

    for (const [shapeLabel, shape] of [
      ["", {}],
      [" as a follow-up", { followUp: true }],
    ] as const) {
      for (const [label, body] of [
        ["", "@Mockbot can you check the build?\n\nThe log is attached."],
        [" that quotes the framing", `@Mockbot the server writes:\n\n${FRAMING_SENTENCE}`],
      ] as const) {
        it(`${lane}, ${chatKind}: another agent's message${label} in the server's framing${shapeLabel} wakes the agent with the text unchanged`, async () => {
          const text = serverFramed(body, shape);
          const seen = await deliver(lane, chatKind, {
            text,
            ...roomAgent(OTHER_ASSISTANT_ID),
          });
          expect(seen).toHaveLength(1);
          expect(seen[0]!.text).toBe(text);
        });
      }
    }

    it(`${lane}, ${chatKind}: another agent's message in the server's framing with no roster wakes the agent`, async () => {
      const text = serverFramed("@Mockbot can you check the build?", { noRoster: true });
      const seen = await deliver(lane, chatKind, {
        text,
        ...roomAgent(OTHER_ASSISTANT_ID),
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.text).toContain(text);
      expect(seen[0]!.text).toMatch(/not a person/);
    });

    it(`${lane}, ${chatKind}: another agent's message does not re-arm the boards loop guard`, async () => {
      // The guard stops chained board result turns until someone writes.
      // Another agent's tag is not that: two agents tagging each other would
      // re-arm each other's guard with every tag.
      const boards = guardedBoards();
      const seen = await deliver(
        lane,
        chatKind,
        { text: SERVER_FRAMED, ...roomAgent(OTHER_ASSISTANT_ID) },
        boards,
      );
      expect(seen).toHaveLength(1);
      expect(loopGuard(boards).get(CHAT_ID)).toBe(GUARD_COUNT);
    });

    it(`${lane}, ${chatKind}: a person's message re-arms the boards loop guard`, async () => {
      const boards = guardedBoards();
      const seen = await deliver(lane, chatKind, { text: "@Mockbot hi" }, boards);
      expect(seen).toHaveLength(1);
      expect(loopGuard(boards).has(CHAT_ID)).toBe(false);
    });

    it(`${lane}, ${chatKind}: a person's message wakes the agent unmarked`, async () => {
      const seen = await deliver(lane, chatKind, { text: "@Mockbot hi" });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.senderType).toBeUndefined();
      expect(seen[0]!.text).toBe("@Mockbot hi");
    });
  }
});
