import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BGOS_AGENT_HINTS } from "../src/agent-hints.js";
import { BgosApi } from "../src/bgos-api.js";
import {
  dispatchMissionOps,
  parseMissionMarkers,
  type MissionDispatchState,
} from "../src/mission-markers.js";
import { BgosOutbound } from "../src/outbound.js";
import { loadOutbox } from "../src/outbox.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const TOKEN = "pair_" + "x".repeat(30);
const OPEN = "[[BGOS_MISSION]]";
const CLOSE = "[[/BGOS_MISSION]]";

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: TOKEN,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function block(value: unknown): string {
  return `${OPEN}${JSON.stringify(value)}${CLOSE}`;
}

describe("parseMissionMarkers", () => {
  it.each([
    [
      "create",
      {
        op: "create",
        title: "Ship the launch",
        miniGoals: [
          { name: "Draft", doneWhen: "copy approved" },
          { name: "Publish", doneWhen: "page is live" },
        ],
        progress: { current: 1, total: 2, label: "steps" },
      },
    ],
    ["tick", { op: "tick", goalId: 2, evidence: "page is live" }],
    [
      "progress",
      {
        op: "progress",
        progress: { current: 34, total: 76 },
        feedText: "Drafted a reply to Sarah",
      },
    ],
    ["complete", { op: "complete", summary: "Everything shipped." }],
    ["abandon", { op: "abandon" }],
  ])("parses the %s op and strips its block", (_name, op) => {
    const text = `Before\n${block(op)}\nAfter`;

    expect(parseMissionMarkers(text)).toEqual({
      cleanText: "Before\n\nAfter",
      ops: [op],
    });
  });

  it("preserves multiple parsed ops in source order", () => {
    const text =
      "Start " +
      block({ op: "create", title: "Inbox catch-up" }) +
      " middle " +
      block({ op: "progress", feedText: "Opened ten messages" }) +
      " end " +
      block({ op: "complete", summary: "Inbox cleared" });

    expect(parseMissionMarkers(text)).toEqual({
      cleanText: "Start  middle  end ",
      ops: [
        { op: "create", title: "Inbox catch-up" },
        { op: "progress", feedText: "Opened ten messages" },
        { op: "complete", summary: "Inbox cleared" },
      ],
    });
  });

  it("strips invalid JSON and ignores it", () => {
    const text = `before${OPEN}{not json}${CLOSE}after`;
    expect(parseMissionMarkers(text)).toEqual({
      cleanText: "beforeafter",
      ops: [],
    });
  });

  it("strips an unknown op and ignores it", () => {
    const text = `before${block({ op: "pause" })}after`;
    expect(parseMissionMarkers(text)).toEqual({
      cleanText: "beforeafter",
      ops: [],
    });
  });

  it("strips and drops a progress op with no valid payload", async () => {
    const apiCall = vi.fn().mockResolvedValue({
      ok: true,
      mission: { id: 61 },
    });
    const api = {
      createMission: apiCall,
      getActiveMission: apiCall,
      tickMiniGoal: apiCall,
      updateMissionProgress: apiCall,
      completeMission: apiCall,
      abandonMission: apiCall,
    } as unknown as BgosApi;
    const parsed = parseMissionMarkers(
      '[[BGOS_MISSION]]{"op":"progress"}[[/BGOS_MISSION]]',
    );

    await dispatchMissionOps(api, 7, parsed.ops, { missionId: 61 });

    expect(parsed).toEqual({ cleanText: "", ops: [] });
    expect(apiCall).not.toHaveBeenCalled();
  });

  it("returns marker-free text byte-for-byte unchanged", () => {
    const text = "  Plain reply.\r\n\r\nStill plain.  ";
    expect(parseMissionMarkers(text)).toEqual({ cleanText: text, ops: [] });
  });

  it("enforces string limits", () => {
    const parsed = parseMissionMarkers(
      [
        block({
          op: "create",
          title: "t".repeat(201),
          progress: { current: 1, total: 3, label: "l".repeat(41) },
        }),
        block({ op: "tick", goalId: 2, evidence: "e".repeat(201) }),
        block({ op: "progress", feedText: "f".repeat(201) }),
        block({ op: "complete", summary: "s".repeat(501) }),
      ].join(""),
    );

    expect(parsed.ops).toEqual([
      {
        op: "create",
        title: "t".repeat(200),
        progress: { current: 1, total: 3, label: "l".repeat(40) },
      },
      { op: "tick", goalId: 2, evidence: "e".repeat(200) },
      { op: "progress", feedText: "f".repeat(200) },
      { op: "complete", summary: "s".repeat(500) },
    ]);
  });

  it("drops a miniGoals array outside the 2 to 12 range", () => {
    const parsed = parseMissionMarkers(
      block({
        op: "create",
        title: "One goal is not enough",
        miniGoals: [{ name: "Only", doneWhen: "done" }],
      }),
    );

    expect(parsed.ops).toEqual([
      { op: "create", title: "One goal is not enough" },
    ]);
  });

  it("truncates miniGoal fields to their backend limits", () => {
    const parsed = parseMissionMarkers(
      block({
        op: "create",
        title: "Bounded goals",
        miniGoals: [
          { name: "n".repeat(121), doneWhen: "d".repeat(201) },
          { name: "second", doneWhen: "verified" },
        ],
      }),
    );

    expect(parsed.ops[0]).toEqual({
      op: "create",
      title: "Bounded goals",
      miniGoals: [
        { name: "n".repeat(120), doneWhen: "d".repeat(200) },
        { name: "second", doneWhen: "verified" },
      ],
    });
  });

  it("coerces a string goalId to an integer", () => {
    expect(
      parseMissionMarkers(block({ op: "tick", goalId: "2" })).ops,
    ).toEqual([{ op: "tick", goalId: 2 }]);
  });

  it("drops values that violate backend integer and nonempty constraints", () => {
    const parsed = parseMissionMarkers(
      [
        block({ op: "create", title: "" }),
        block({ op: "create", title: "   " }),
        block({
          op: "create",
          title: "Valid title",
          miniGoals: [
            { name: "   ", doneWhen: "checked" },
            { name: "Second", doneWhen: "verified" },
          ],
          progress: { current: -1, total: 0 },
        }),
        block({ op: "tick", goalId: 0 }),
        block({
          op: "progress",
          progress: { current: 1.5, total: 2 },
          feedText: "Still worked",
        }),
      ].join(""),
    );

    expect(parsed.ops).toEqual([
      { op: "create", title: "Valid title" },
      { op: "progress", feedText: "Still worked" },
    ]);
  });
});

describe("dispatchMissionOps", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
  });

  it("creates a self-report mission and stores its id", async () => {
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      201,
      { ok: true, mission: { id: 91 } },
    );
    const state: MissionDispatchState = {};

    await dispatchMissionOps(
      makeApi(baseUrl),
      7,
      [
        {
          op: "create",
          title: "Inbox catch-up",
          progress: { current: 0, total: 76, label: "emails" },
        },
      ],
      state,
    );

    expect(state.missionId).toBe(91);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/integrations/assistants/7/missions",
      body: {
        title: "Inbox catch-up",
        progress: { current: 0, total: 76, label: "emails" },
        origin: "self_report",
      },
    });
    expect(server.requests[0]!.headers["x-bgos-pairing"]).toBe(TOKEN);
  });

  it("uses the stored id for tick, progress, and complete in order", async () => {
    const prefix = "/api/v1/integrations/assistants/7/missions/91";
    server
      .stage("PATCH", `${prefix}/tick`, 200, {
        ok: true,
        mission: { id: 91 },
      })
      .stage("PATCH", `${prefix}/progress`, 200, {
        ok: true,
        mission: { id: 91 },
      })
      .stage("PATCH", `${prefix}/complete`, 200, {
        ok: true,
        mission: { id: 91 },
      });
    const state: MissionDispatchState = { missionId: 91 };

    await dispatchMissionOps(
      makeApi(baseUrl),
      7,
      [
        { op: "tick", goalId: 2, evidence: "draft is saved" },
        {
          op: "progress",
          progress: { current: 34, total: 76 },
          feedText: "Drafted a reply to Sarah",
        },
        { op: "complete", summary: "All handled" },
      ],
      state,
    );

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `PATCH ${prefix}/tick`,
      `PATCH ${prefix}/progress`,
      `PATCH ${prefix}/complete`,
    ]);
    expect(server.requests.map((r) => r.body)).toEqual([
      { goalId: 2, evidence: "draft is saved" },
      {
        progress: { current: 34, total: 76 },
        feedEntry: { kind: "worked", text: "Drafted a reply to Sarah" },
      },
      { summary: "All handled" },
    ]);
    expect(state.missionId).toBeUndefined();
  });

  it("resolves an unknown id through GET active before patching", async () => {
    server
      .stage(
        "GET",
        "/api/v1/integrations/assistants/7/missions/active",
        200,
        { mission: { id: 44 } },
      )
      .stage(
        "PATCH",
        "/api/v1/integrations/assistants/7/missions/44/abandon",
        200,
        { ok: true, mission: { id: 44 } },
      );
    const state: MissionDispatchState = {};

    await dispatchMissionOps(
      makeApi(baseUrl),
      7,
      [{ op: "abandon" }],
      state,
    );

    expect(server.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/v1/integrations/assistants/7/missions/active",
      "PATCH /api/v1/integrations/assistants/7/missions/44/abandon",
    ]);
    expect(state.missionId).toBeUndefined();
  });

  it("clears a stale stored id after a PATCH 404", async () => {
    server.stage(
      "PATCH",
      "/api/v1/integrations/assistants/7/missions/91/tick",
      404,
      { message: "not found" },
    );
    const state: MissionDispatchState = { missionId: 91 };
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      dispatchMissionOps(
        makeApi(baseUrl),
        7,
        [{ op: "tick", goalId: 2 }],
        state,
      ),
    ).resolves.toBeUndefined();

    expect(state.missionId).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it("logs and swallows an API failure", async () => {
    server.stage(
      "POST",
      "/api/v1/integrations/assistants/7/missions",
      500,
      { message: "down" },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      dispatchMissionOps(
        makeApi(baseUrl),
        7,
        [{ op: "create", title: "Still reply" }],
        {},
      ),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
  });

});

describe("dispatchMissionOps failure recovery", () => {
  it("does not apply later ops to an old mission after create fails", async () => {
    const api = {
      createMission: vi.fn().mockRejectedValue(new Error("create failed")),
      getActiveMission: vi.fn().mockResolvedValue({ mission: null }),
      tickMiniGoal: vi.fn().mockResolvedValue({
        ok: true,
        mission: { id: 12 },
      }),
    } as unknown as BgosApi;
    const state: MissionDispatchState = { missionId: 12 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await dispatchMissionOps(
      api,
      7,
      [
        { op: "create", title: "Replacement" },
        { op: "tick", goalId: 1 },
      ],
      state,
    );

    expect(api.tickMiniGoal).not.toHaveBeenCalled();
    expect(state.missionId).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("BgosOutbound mission marker integration", () => {
  let server: MockBgosServer;
  let baseUrl: string;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("posts clean reply text, then dispatches mission ops", async () => {
    server
      .stage("POST", "/api/v1/messages", 201, { id: 501 })
      .stage(
        "POST",
        "/api/v1/integrations/assistants/7/missions",
        201,
        { ok: true, mission: { id: 92 } },
      );
    const outbound = new BgosOutbound(makeApi(baseUrl));

    await outbound.sendText({
      assistantId: 7,
      chatId: 8,
      text: `Visible before${block({ op: "create", title: "Do the work" })} visible after`,
    });

    await vi.waitFor(() => expect(server.requests).toHaveLength(2));
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/messages",
      body: { text: "Visible before visible after" },
    });
    expect(server.requests[1]).toMatchObject({
      method: "POST",
      url: "/api/v1/integrations/assistants/7/missions",
    });
  });

  it("leaves marker-free replies untouched and makes no mission call", async () => {
    server.stage("POST", "/api/v1/messages", 201, { id: 502 });
    const outbound = new BgosOutbound(makeApi(baseUrl));
    const text = "  Nothing to report.\r\n\r\nExactly as written.  ";

    await outbound.sendText({ assistantId: 7, chatId: 8, text });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/messages",
      body: { text },
    });
  });
});

describe("BgosOutbound mission dispatch timing", () => {
  it("starts mission dispatch only after the visible reply is delivered", async () => {
    let finishReply!: (value: { id: number }) => void;
    const pendingReply = new Promise<{ id: number }>((resolve) => {
      finishReply = resolve;
    });
    const api = {
      postMessage: vi.fn().mockReturnValue(pendingReply),
      createMission: vi.fn().mockResolvedValue({
        ok: true,
        mission: { id: 93 },
      }),
    } as unknown as BgosApi;
    const outbound = new BgosOutbound(api);

    const delivery = outbound.sendText({
      assistantId: 7,
      chatId: 8,
      text: block({ op: "create", title: "Wait for delivery" }),
    });
    await Promise.resolve();
    expect(api.createMission).not.toHaveBeenCalled();

    finishReply({ id: 503 });
    await expect(delivery).resolves.toEqual({ id: 503 });
    expect(api.createMission).toHaveBeenCalledTimes(1);
  });

  it("does not await mission REST before resolving the delivered reply", async () => {
    let finishMission!: (value: {
      ok: true;
      mission: { id: number };
    }) => void;
    const pendingMission = new Promise<{
      ok: true;
      mission: { id: number };
    }>((resolve) => {
      finishMission = resolve;
    });
    const api = {
      postMessage: vi.fn().mockResolvedValue({ id: 503 }),
      createMission: vi.fn().mockReturnValue(pendingMission),
    } as unknown as BgosApi;
    const outbound = new BgosOutbound(api);

    await expect(
      outbound.sendText({
        assistantId: 7,
        chatId: 8,
        text: block({ op: "create", title: "Do not block delivery" }),
      }),
    ).resolves.toEqual({ id: 503 });
    expect(api.createMission).toHaveBeenCalledTimes(1);

    finishMission({ ok: true, mission: { id: 93 } });
  });

  it("serializes mission ops across rapid replies for one assistant", async () => {
    let finishCreate!: (value: {
      ok: true;
      mission: { id: number };
    }) => void;
    const pendingCreate = new Promise<{
      ok: true;
      mission: { id: number };
    }>((resolve) => {
      finishCreate = resolve;
    });
    const api = {
      postMessage: vi.fn().mockResolvedValue({ id: 504 }),
      createMission: vi.fn().mockReturnValue(pendingCreate),
      getActiveMission: vi.fn().mockResolvedValue({ mission: null }),
      tickMiniGoal: vi.fn().mockResolvedValue({
        ok: true,
        mission: { id: 94 },
      }),
    } as unknown as BgosApi;
    const outbound = new BgosOutbound(api);

    await outbound.sendText({
      assistantId: 7,
      chatId: 8,
      text: block({ op: "create", title: "Ordered work" }),
    });
    await outbound.sendText({
      assistantId: 7,
      chatId: 8,
      text: block({ op: "tick", goalId: 2 }),
    });

    expect(api.getActiveMission).not.toHaveBeenCalled();
    expect(api.tickMiniGoal).not.toHaveBeenCalled();
    finishCreate({ ok: true, mission: { id: 94 } });
    await vi.waitFor(() => expect(api.tickMiniGoal).toHaveBeenCalledTimes(1));
    expect(api.tickMiniGoal).toHaveBeenCalledWith(7, 94, { goalId: 2 });
  });
});

describe("BgosOutbound mission spool replay", () => {
  it("retains mission ops until a safely spooled reply is delivered", async () => {
    const previousHome = process.env.GOBOT_HOME;
    const tempHome = mkdtempSync(join(tmpdir(), "gobot-mission-spool-"));
    process.env.GOBOT_HOME = tempHome;
    try {
      let failing = true;
      const send = vi.fn(async () => {
        if (failing) {
          throw Object.assign(new Error("offline"), {
            code: "ECONNREFUSED",
          });
        }
        return { id: 505 };
      });
      const api = {
        postMessage: send,
        sendMessage: send,
        createMission: vi.fn().mockResolvedValue({
          ok: true,
          mission: { id: 95 },
        }),
      } as unknown as BgosApi;
      const outbound = new BgosOutbound(api);
      outbound.setSleepFn(async () => {});

      await expect(
        outbound.sendText({
          assistantId: 7,
          chatId: 8,
          text: `Visible${block({ op: "create", title: "Replay me" })}`,
        }),
      ).rejects.toThrow("offline");
      expect(api.createMission).not.toHaveBeenCalled();
      const spooled = loadOutbox();
      expect(spooled).toHaveLength(1);
      expect(spooled[0]!.payload.text).toBe("Visible");
      expect((spooled[0] as any).mission.ops).toEqual([
        { op: "create", title: "Replay me" },
      ]);

      failing = false;
      await outbound.replaySpool();
      await vi.waitFor(() =>
        expect(api.createMission).toHaveBeenCalledTimes(1),
      );
    } finally {
      rmSync(tempHome, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.GOBOT_HOME;
      else process.env.GOBOT_HOME = previousHome;
    }
  });
});

describe("bundled mission hint", () => {
  it("contains the shared mission text verbatim", () => {
    const exact = `Missions (durable goal card): for a long multi step goal, create a durable mission card and keep it honest with ticks and progress. Emit marker blocks anywhere in a reply; they are stripped before the user sees the text. One JSON op per block:
[[BGOS_MISSION]]{"op":"create","title":"Inbox catch-up","miniGoals":[{"name":"Read every unanswered email","doneWhen":"all 76 opened"},{"name":"Draft replies where needed","doneWhen":"every needed reply has a draft"}],"progress":{"current":0,"total":76,"label":"emails"}}[[/BGOS_MISSION]]
[[BGOS_MISSION]]{"op":"tick","goalId":2,"evidence":"drafts folder has 23 replies"}[[/BGOS_MISSION]]
[[BGOS_MISSION]]{"op":"progress","progress":{"current":34,"total":76},"feedText":"Drafted a reply to Sarah"}[[/BGOS_MISSION]]
[[BGOS_MISSION]]{"op":"complete","summary":"All 76 handled. 23 drafts waiting for your review."}[[/BGOS_MISSION]]
[[BGOS_MISSION]]{"op":"abandon"}[[/BGOS_MISSION]]
Rules: title up to 200 chars. miniGoals optional; when present 2 to 12 binary goals, each with a doneWhen check. progress is countable honest progress (current, total, optional short label). feedText up to 200 chars, summary up to 500. Create replaces your previous open mission. Tick goals the moment their check is true; never claim silent progress. Invalid JSON in a block is ignored.`;

    expect(BGOS_AGENT_HINTS).toContain(exact);
  });
});
