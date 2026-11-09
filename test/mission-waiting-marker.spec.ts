/**
 * THE WAITING MARK ON THE MISSION MARKER (0.17.3).
 *
 * BGOS (2026-10-31): a Keep working wake now counts the turns that
 * moved nothing; after 6 it backs off to every 3 hours and at the mission's
 * turn cap it stops Keep working. The wake tells the agent to mark a goal
 * that waits on somebody else as waiting, and a waiting mark is one of the
 * moves that resets the count. The marker had no way to send one, so a Gobot
 * agent could only watch its mission stall. Now:
 *
 *   {"op":"waiting","goalId":3,"on":"owner","who":"Ada","why":"approve the spend"}
 *   {"op":"waiting","goalId":3,"clear":true}
 *
 * PATCH .../missions/:missionId/goals/:goalId/waiting with
 * { waiting: { on, who, why } } or { waiting: null }.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BGOS_AGENT_HINTS } from "../src/agent-hints.js";
import { BgosApi } from "../src/bgos-api.js";
import {
  dispatchMissionOps,
  parseMissionMarkers,
  type MissionDispatchState,
} from "../src/mission-markers.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const TOKEN = "pair_" + "x".repeat(30);

function block(value: unknown): string {
  return `[[BGOS_MISSION]]${JSON.stringify(value)}[[/BGOS_MISSION]]`;
}

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: TOKEN,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

describe("parse the waiting op", () => {
  it("parses a waiting mark and strips its block", () => {
    const op = {
      op: "waiting",
      goalId: 3,
      on: "owner",
      who: "Ada",
      why: "approve the ad spend",
    };
    expect(parseMissionMarkers(`A ${block(op)} B`)).toEqual({
      cleanText: "A  B",
      ops: [op],
    });
  });

  it("parses a clear", () => {
    expect(
      parseMissionMarkers(block({ op: "waiting", goalId: 3, clear: true })).ops,
    ).toEqual([{ op: "waiting", goalId: 3, clear: true }]);
  });

  it("keeps who at 80 and why at 200 exactly", () => {
    const [op] = parseMissionMarkers(
      block({
        op: "waiting",
        goalId: "4",
        on: "agent",
        who: "w".repeat(80),
        why: "y".repeat(200),
      }),
    ).ops;
    expect(op).toEqual({
      op: "waiting",
      goalId: 4,
      on: "agent",
      who: "w".repeat(80),
      why: "y".repeat(200),
    });
  });

  it.each([
    ["no goal", { op: "waiting", on: "owner", who: "Ada", why: "x" }],
    ["an unknown on", { op: "waiting", goalId: 3, on: "board", who: "Ada", why: "x" }],
    ["no why", { op: "waiting", goalId: 3, on: "owner", who: "Ada" }],
    ["no who", { op: "waiting", goalId: 3, on: "owner", why: "x" }],
    // Refused like the server (parseMissionGoalWaiting), never shortened
    // into a mark the agent did not write (review of 3b1e7a2).
    ["a who over 80", { op: "waiting", goalId: 3, on: "owner", who: "w".repeat(81), why: "x" }],
    ["a why over 200", { op: "waiting", goalId: 3, on: "owner", who: "Ada", why: "y".repeat(201) }],
    ["a control character in who", { op: "waiting", goalId: 3, on: "owner", who: "Us\u0007er", why: "x" }],
  ])("drops a mark with %s, still stripping it", (_name, op) => {
    expect(parseMissionMarkers(`x${block(op)}y`)).toEqual({
      cleanText: "xy",
      ops: [],
    });
  });
});

describe("dispatch the waiting op", () => {
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

  it("PATCHes the goal's waiting route with the mark", async () => {
    const url = "/api/v1/integrations/assistants/7/missions/91/goals/3/waiting";
    server.stage("PATCH", url, 200, { ok: true, mission: { id: 91 } });
    const state: MissionDispatchState = { missionId: 91 };
    await dispatchMissionOps(
      makeApi(baseUrl),
      7,
      [{ op: "waiting", goalId: 3, on: "owner", who: "Ada", why: "approve it" }],
      state,
    );
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "PATCH",
      url,
      body: { waiting: { on: "owner", who: "Ada", why: "approve it" } },
    });
    expect(state.missionId).toBe(91);
  });

  it("clears with waiting null", async () => {
    const url = "/api/v1/integrations/assistants/7/missions/91/goals/3/waiting";
    server.stage("PATCH", url, 200, { ok: true, mission: { id: 91 } });
    await dispatchMissionOps(
      makeApi(baseUrl),
      7,
      [{ op: "waiting", goalId: 3, clear: true }],
      { missionId: 91 },
    );
    expect(server.requests[0]!.body).toEqual({ waiting: null });
  });
});

describe("bundled hint names the waiting op", () => {
  it("documents the mark and the clear", () => {
    expect(BGOS_AGENT_HINTS).toContain(
      '[[BGOS_MISSION]]{"op":"waiting","goalId":3,"on":"owner","who":"your owner\'s name","why":"approve the spend"}[[/BGOS_MISSION]]',
    );
    expect(BGOS_AGENT_HINTS).toContain(
      '[[BGOS_MISSION]]{"op":"waiting","goalId":3,"clear":true}[[/BGOS_MISSION]]',
    );
  });
});
