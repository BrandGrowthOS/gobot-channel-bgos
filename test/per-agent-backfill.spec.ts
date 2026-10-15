/**
 * BgosWs.triggerBackfill with per-agent cursors: the poll starts from the lowest
 * cursor of the known agents, each row is kept only past ITS agent's cursor, and
 * an idle agent's cursor is carried up to what the poll covered so it cannot pin
 * the window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";
import { loadAgentCursor, pollSince, saveAgentCursor } from "../src/last-id-store.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const INBOUND = "/api/v1/integrations/inbound";

function makeWs(baseUrl: string, known: number[]) {
  const api = new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
  const ws = new BgosWs({} as never, api);
  ws.setKnownAssistants(() => known);
  const emitted: InboundMessagePayload[] = [];
  ws.on("inbound_message", (m) => emitted.push(m));
  return { ws, emitted };
}

const row = (id: number, assistantId: number) => ({
  assistantId,
  chatId: 200,
  messageId: id,
  userId: "u",
  text: "x",
});

const sinceOf = (server: MockBgosServer, n = 0) =>
  Number(
    new URL(
      server.requests.filter((r) => r.url.startsWith(INBOUND))[n]!.url,
      "http://x",
    ).searchParams.get("since_message_id"),
  );

describe("BgosWs.triggerBackfill, per-agent cursors", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-per-agent-backfill-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("polls from the lowest known cursor and keeps each row only past its own agent's cursor", async () => {
    pollSince([1, 2]); // both agents known from the start
    saveAgentCursor(1, 500); // agent 1 is ahead
    saveAgentCursor(2, 480);
    server.stage("GET", INBOUND, 200, {
      messages: [row(490, 1), row(490, 2), row(510, 1)],
    });
    const { ws, emitted } = makeWs(baseUrl, [1, 2]);

    await ws.triggerBackfill();

    expect(sinceOf(server)).toBe(480);
    // (490, agent 1) is behind agent 1's cursor: already consumed, not replayed.
    expect(emitted.map((m) => `${m.assistantId}:${m.messageId}`)).toEqual([
      "2:490",
      "1:510",
    ]);
  });

  it("carries an idle agent up to what the poll covered, so it cannot pin the window", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    server.stage("GET", INBOUND, 200, { messages: [row(600, 1)] });
    const { ws } = makeWs(baseUrl, [1, 2]);

    await ws.triggerBackfill();

    // Agent 2 had no row up to 600: nothing for it is pending below that.
    expect(loadAgentCursor(2)).toBe(600);
  });

  it("does not carry an agent that had a row (its own handler advances it)", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    server.stage("GET", INBOUND, 200, { messages: [row(600, 1), row(610, 2)] });
    const { ws } = makeWs(baseUrl, [1, 2]);

    await ws.triggerBackfill();

    // No handler is attached in this test: neither agent's cursor moved.
    expect(loadAgentCursor(1)).toBe(100);
    expect(loadAgentCursor(2)).toBe(100);
  });

  it("a full page stops the idle carry one below its last id (that id's other rows may be cut)", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    const messages = Array.from({ length: 200 }, (_, i) => row(101 + i, 1));
    server.stage("GET", INBOUND, 200, { messages });
    process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT = "0";
    const { ws } = makeWs(baseUrl, [1, 2]);
    try {
      await ws.triggerBackfill();
    } finally {
      delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    }

    expect(loadAgentCursor(2)).toBe(299); // last id 300, minus one
  });

  it("a row for an agent not known yet still reaches the handler (it stays unconsumed there)", async () => {
    saveAgentCursor(1, 500);
    server.stage("GET", INBOUND, 200, { messages: [row(450, 9)] });
    const { ws, emitted } = makeWs(baseUrl, [1]);
    // The poll window must reach below agent 1's cursor for this to matter.
    saveAgentCursor(1, 500);
    await ws.triggerBackfill();
    expect(emitted.map((m) => m.assistantId)).toEqual([9]);
  });

  it("storm guard fast-forwards every known agent and skips dispatch", async () => {
    process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT = "2";
    pollSince([1, 2]);
    saveAgentCursor(1, 10);
    saveAgentCursor(2, 10);
    server.stage("GET", INBOUND, 200, {
      messages: [row(11, 1), row(12, 2), row(13, 1)],
    });
    const { ws, emitted } = makeWs(baseUrl, [1, 2]);
    try {
      await ws.triggerBackfill();
    } finally {
      delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    }

    expect(emitted).toHaveLength(0);
    expect(loadAgentCursor(1)).toBe(13);
    expect(loadAgentCursor(2)).toBe(13);
  });

  it("an agent exposed after its message arrived still gets it once identity heals", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    const routes = new Map<number, string>([
      [1, "a"],
      [2, "b"],
    ]);
    const known = [1, 2];
    const dispatch = vi.fn(async () => {});
    const api = new BgosApi({
      baseUrl,
      pairingToken: "pair_" + "x".repeat(30),
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    const handler = createInboundHandler({
      outbound: new BgosOutbound(api),
      getRouteForAssistant: (id) => routes.get(id) ?? null,
      getDispatch: () => dispatch as never,
    });
    const ws = new BgosWs({} as never, api);
    ws.setKnownAssistants(() => known);
    const inFlight: Array<Promise<void>> = [];
    ws.on("inbound_message", (m) => inFlight.push(handler(m)));

    // Agent 9 is not exposed yet: its row stays unconsumed.
    server.stage("GET", INBOUND, 200, { messages: [row(150, 9)] });
    await ws.triggerBackfill();
    await Promise.all(inFlight);
    expect(dispatch).not.toHaveBeenCalled();
    // The idle agents were NOT carried past the unconsumed row.
    expect(loadAgentCursor(1)).toBe(149);
    expect(loadAgentCursor(2)).toBe(149);

    // Agent 9 is exposed: its message is fetched again and delivered.
    routes.set(9, "c");
    known.push(9);
    server.stage("GET", INBOUND, 200, { messages: [row(150, 9)] });
    await ws.triggerBackfill();
    await Promise.all(inFlight);

    expect(sinceOf(server, 1)).toBe(149);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("an initial poll after partial progress is not a cold start (the other agent's row is delivered)", async () => {
    pollSince([1, 2]); // both at 0
    saveAgentCursor(1, 500); // agent 1 got its copy, then the process died
    server.stage("GET", INBOUND, 200, { messages: [row(500, 1), row(500, 2)] });
    const { ws, emitted } = makeWs(baseUrl, [1, 2]);

    await ws.triggerBackfill({ initial: true });

    expect(emitted.map((m) => `${m.assistantId}:${m.messageId}`)).toEqual(["2:500"]);
  });

  it("an agent exposed long after the migration does not replay history or trip the storm guard", async () => {
    // Legacy cursor 3000; agent 1 has since consumed up to 90000.
    writeFileSync(join(tempHome, "bgos_last_id"), "3000", "utf8");
    pollSince([1]);
    saveAgentCursor(1, 90000);
    // Agent 7 is exposed now. Its old rows (3100..3129) are history.
    const old = Array.from({ length: 30 }, (_, i) => row(3100 + i, 7));
    server.stage("GET", INBOUND, 200, { messages: [...old, row(90100, 1)] });
    const { ws, emitted } = makeWs(baseUrl, [1, 7]);

    await ws.triggerBackfill();

    expect(sinceOf(server)).toBe(90000);
    expect(emitted.map((m) => `${m.assistantId}:${m.messageId}`)).toEqual(["1:90100"]);
  });

  it("an agent removed and exposed again rejoins at the head: no backlog replay, no storm over others", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    const known = [1, 2];
    const { ws, emitted } = makeWs(baseUrl, known);
    server.stage("GET", INBOUND, 200, { messages: [] });
    await ws.triggerBackfill();

    // Agent 2 is away while agent 1 moves on to 3500.
    known.splice(known.indexOf(2), 1);
    saveAgentCursor(1, 3500);
    server.stage("GET", INBOUND, 200, { messages: [] });
    await ws.triggerBackfill();

    // Agent 2 is back; 30 messages arrived for it while away, plus a new one for agent 1.
    known.push(2);
    const away = Array.from({ length: 30 }, (_, i) => row(3100 + i, 2));
    server.stage("GET", INBOUND, 200, { messages: [...away, row(4000, 1)] });
    await ws.triggerBackfill();

    expect(sinceOf(server, 2)).toBe(3500);
    expect(emitted.map((m) => `${m.assistantId}:${m.messageId}`)).toEqual(["1:4000"]);
  });

  it("a poll before identity is loaded (no agents known) does not rebase anyone later", async () => {
    pollSince([1, 2]);
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    saveAgentCursor(1, 900); // head moves on; agent 2 still has rows below it
    const known: number[] = [];
    const { ws, emitted } = makeWs(baseUrl, known);

    server.stage("GET", INBOUND, 200, { messages: [] });
    await ws.triggerBackfill(); // identity not loaded: nothing known

    known.push(1, 2); // identity loaded
    server.stage("GET", INBOUND, 200, { messages: [row(500, 2)] });
    await ws.triggerBackfill({ initial: true });

    expect(sinceOf(server, 1)).toBe(100);
    expect(emitted.map((m) => `${m.assistantId}:${m.messageId}`)).toEqual(["2:500"]);
  });
});
