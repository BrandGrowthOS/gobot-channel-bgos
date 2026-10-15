/**
 * BgosWs.triggerBackfill with per-agent cursors: the poll starts from the lowest
 * cursor of the known agents, each row is kept only past ITS agent's cursor, and
 * an idle agent's cursor is carried up to what the poll covered so it cannot pin
 * the window.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { loadAgentCursor, saveAgentCursor } from "../src/last-id-store.js";
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
    saveAgentCursor(1, 100);
    saveAgentCursor(2, 100);
    server.stage("GET", INBOUND, 200, { messages: [row(600, 1)] });
    const { ws } = makeWs(baseUrl, [1, 2]);

    await ws.triggerBackfill();

    // Agent 2 had no row up to 600: nothing for it is pending below that.
    expect(loadAgentCursor(2)).toBe(600);
  });

  it("does not carry an agent that had a row (its own handler advances it)", async () => {
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
});
