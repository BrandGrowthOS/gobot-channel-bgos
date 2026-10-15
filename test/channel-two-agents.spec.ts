/**
 * Two agents on ONE gateway, one channel message addressed to both.
 *
 * The backend delivers it as one poll row per agent, both with the SAME message
 * id. Each agent must get its own copy: through the live poll, and across a
 * restart that lands between the two agents' turns (a single gateway cursor
 * moved past the id on the first agent's row and the second agent's row was
 * never fetched again).
 *
 * This file only uses symbols that exist on both sides of the per-agent cursor
 * change, so the same tests run red on the old code and green on the new code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import { BgosOutbound } from "../src/outbound.js";
import { createInboundHandler } from "../src/inbound-handler.js";

const AGENT_A = 11;
const AGENT_B = 12;

/** A row the way `GET /integrations/inbound` serves it: one per (message, agent). */
function row(id: number, assistantId: number) {
  return {
    assistantId,
    chatId: 900,
    messageId: id,
    userId: "user_1",
    text: "@a @b what do you think",
    chatKind: "channel",
  };
}

/** The backend poll: every row with id > since_message_id, ASC by id. */
class PollBackend {
  rows: Array<ReturnType<typeof row>> = [];
  readonly sinceSeen: number[] = [];
  private server!: Server;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const since = Number(url.searchParams.get("since_message_id") ?? "0");
      this.sinceSeen.push(since);
      const messages = this.rows
        .filter((r) => r.messageId > since)
        .sort((a, b) => a.messageId - b.messageId);
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ messages }));
    });
    await new Promise<void>((r) => this.server.listen(0, r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

/** One gateway process: the poll, the inbound handler and the two bound agents. */
function startGateway(baseUrl: string, onlyAgent?: number) {
  const dispatch = vi.fn(async (_args: { assistantId: number; messageId: number }) => {});
  const api = makeApi(baseUrl);
  const ws = new BgosWs({} as never, api);
  // The adapter wires its bound agents in; absent on the pre per-agent code.
  (ws as unknown as { setKnownAssistants?: (fn: () => number[]) => void })
    .setKnownAssistants?.(() => [AGENT_A, AGENT_B]);
  const handler = createInboundHandler({
    outbound: new BgosOutbound(api),
    getRouteForAssistant: (id) => (id === AGENT_A || id === AGENT_B ? "general" : null),
    getDispatch: () => dispatch as never,
  });
  const inFlight: Array<Promise<void>> = [];
  ws.on("inbound_message", (m) => {
    // `onlyAgent` stops the process before the other agent's turn (a crash).
    if (onlyAgent !== undefined && m.assistantId !== onlyAgent) return;
    inFlight.push(handler(m));
  });
  return {
    dispatch,
    poll: async () => {
      await ws.triggerBackfill();
      await Promise.all(inFlight);
    },
    got: () =>
      dispatch.mock.calls
        .map((c) => `${c[0].assistantId}:${c[0].messageId}`)
        .sort(),
  };
}

describe("two agents on one gateway, a channel message addressed to both", () => {
  let backend: PollBackend;
  let baseUrl: string;
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(async () => {
    backend = new PollBackend();
    baseUrl = await backend.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-two-agents-"));
    process.env.GOBOT_HOME = tempHome;
  });
  afterEach(async () => {
    await backend.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalGobotHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalGobotHome;
  });

  it("both agents receive it from the same poll", async () => {
    backend.rows = [row(500, AGENT_A), row(500, AGENT_B)];
    const gw = startGateway(baseUrl);

    await gw.poll();

    expect(gw.got()).toEqual([`${AGENT_A}:500`, `${AGENT_B}:500`]);
  });

  it("the second agent still gets it when the gateway restarts between the two turns", async () => {
    backend.rows = [row(500, AGENT_A), row(500, AGENT_B)];

    // Process 1 reaches agent A's turn, then dies before agent B's.
    const first = startGateway(baseUrl, AGENT_A);
    await first.poll();
    expect(first.got()).toEqual([`${AGENT_A}:500`]);

    // Process 2 starts from what process 1 persisted.
    const second = startGateway(baseUrl);
    await second.poll();

    // B gets it; A is not handed the same message a second time.
    expect(second.got()).toEqual([`${AGENT_B}:500`]);
  });
});
