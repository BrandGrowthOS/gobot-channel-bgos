/**
 * A computer that has never consumed a message must not skip what was sent
 * while it slept (board row 41654857).
 *
 * Before: `isColdStart()` stayed true until something was consumed, so a first
 * boot that found an EMPTY history wrote nothing, and the next boot (the wake)
 * was a "cold start" again: it seeded the cursors past everything sent in
 * between and dispatched none of it. The same seed also dropped what arrived
 * between pairing and the first boot.
 *
 * After: the cold start runs once per install (a marker is persisted even when
 * history is empty), and rows created at or after the pairing (`pairedAt`) are
 * replayed, newest first up to a bound, instead of being seeded past.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "../src/bgos-api.js";
import { BgosWs } from "../src/bgos-ws.js";
import {
  isColdStart,
  loadAgentCursor,
  saveAgentCursor,
  saveLastId,
} from "../src/last-id-store.js";
import type { InboundMessagePayload } from "../src/types.js";
import { MockBgosServer } from "./mocks/mock-bgos-server.js";

const INBOUND = "/api/v1/integrations/inbound";
const PAIRED_AT = Date.parse("2026-11-01T10:00:00.000Z");
const before = (min: number) => new Date(PAIRED_AT - min * 60_000).toISOString();
const after = (min: number) => new Date(PAIRED_AT + min * 60_000).toISOString();

function makeApi(baseUrl: string) {
  return new BgosApi({
    baseUrl,
    pairingToken: "pair_" + "x".repeat(30),
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
  });
}

function row(id: number, createdAt: string, assistantId = 1) {
  return {
    assistant_id: assistantId,
    chat_id: 200,
    message_id: id,
    user_id: "u",
    text: "m" + id,
    created_at: createdAt,
  };
}

/** One boot of the daemon's poll side. The listener does what the inbound
 *  handler does: dedupe per (agent, id), persist the agent's cursor BEFORE
 *  dispatch, then dispatch. `crashAfter` stops dispatching after N rows, the
 *  way a process that dies mid dispatch would. */
function boot(
  baseUrl: string,
  opts: { pairedAt?: number | null; known?: number[]; crashAfter?: number } = {},
) {
  const ws = new BgosWs({} as never, makeApi(baseUrl));
  ws.setKnownAssistants(() => opts.known ?? [1]);
  if (opts.pairedAt !== undefined) ws.setPairedAt(() => opts.pairedAt ?? null);
  const dispatched: number[] = [];
  const seen = new Set<string>();
  let crashed = false;
  ws.on("inbound_message", (m: InboundMessagePayload) => {
    if (crashed) return;
    const key = `${m.assistantId}:${m.messageId}`;
    if (seen.has(key)) return;
    seen.add(key);
    saveAgentCursor(m.assistantId, m.messageId);
    if (opts.crashAfter !== undefined && dispatched.length >= opts.crashAfter) {
      crashed = true; // cursor saved, dispatch never happened: the process died
      return;
    }
    dispatched.push(m.messageId);
  });
  return { ws, dispatched };
}

describe("cold start on a computer that never consumed a message", () => {
  let server: MockBgosServer;
  let baseUrl: string;
  let tempHome: string;
  const originalHome = process.env.GOBOT_HOME;
  const originalStorm = process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
  const originalBound = process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;

  beforeEach(async () => {
    server = new MockBgosServer();
    baseUrl = await server.start();
    tempHome = mkdtempSync(join(tmpdir(), "gobot-cold-wake-"));
    process.env.GOBOT_HOME = tempHome;
    delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    delete process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;
  });
  afterEach(async () => {
    await server.stop();
    rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalHome;
    if (originalStorm === undefined) delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    else process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT = originalStorm;
    if (originalBound === undefined) delete process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;
    else process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = originalBound;
  });

  it("wakes after two messages were sent and gets both, once (no pairedAt known)", async () => {
    // Boot 1: paired, nothing sent yet. The cold start must still end here.
    server.stage("GET", INBOUND, 200, { messages: [] });
    await boot(baseUrl, { pairedAt: null }).ws.triggerBackfill({ initial: true });
    expect(isColdStart()).toBe(false);

    // Asleep: two messages. Boot 2 (the wake) is a normal replay.
    server.stage("GET", INBOUND, 200, { messages: [row(7, after(5)), row(8, after(6))] });
    const wake = boot(baseUrl, { pairedAt: null });
    await wake.ws.triggerBackfill({ initial: true });
    expect(wake.dispatched).toEqual([7, 8]);

    // Boot 3: the same rows served again (a stale page) are not dispatched again.
    server.stage("GET", INBOUND, 200, { messages: [row(7, after(5)), row(8, after(6))] });
    const again = boot(baseUrl, { pairedAt: null });
    await again.ws.triggerBackfill({ initial: true });
    expect(again.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(8);
  });

  it("the first boot replays what arrived between pairing and that boot", async () => {
    // Old history before the pairing, two messages after it, then the end.
    const history = [row(3, before(60)), row(4, before(30)), row(7, after(5)), row(8, after(6))];
    server.stage("GET", INBOUND, 200, { messages: history }); // seed page 1
    server.stage("GET", INBOUND, 200, { messages: [] }); // seed page 2: end
    server.stage("GET", INBOUND, 200, { messages: [row(7, after(5)), row(8, after(6))] }); // replay
    const first = boot(baseUrl, { pairedAt: PAIRED_AT });
    await first.ws.triggerBackfill({ initial: true });
    expect(first.dispatched).toEqual([7, 8]);
    expect(isColdStart()).toBe(false);
  });

  it("a fresh install with a long history replays at most the bound, newest kept", async () => {
    process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = "3";
    const old = Array.from({ length: 30 }, (_, i) => row(i + 1, before(100 - i)));
    const recent = Array.from({ length: 6 }, (_, i) => row(31 + i, after(i + 1)));
    server.stage("GET", INBOUND, 200, { messages: [...old, ...recent] });
    server.stage("GET", INBOUND, 200, { messages: [] });
    // The replay poll asks from the bound's start: rows 34..36.
    server.stage("GET", INBOUND, 200, { messages: recent.slice(3) });
    const first = boot(baseUrl, { pairedAt: PAIRED_AT });
    await first.ws.triggerBackfill({ initial: true });
    expect(first.dispatched).toEqual([34, 35, 36]);
    const replayReq = server.requests.filter((r) => r.url.startsWith(INBOUND)).at(-1)!;
    expect(replayReq.url).toContain("since_message_id=33");
  });

  it("a fresh install whose whole history predates the pairing replays nothing (today's seed)", async () => {
    server.stage("GET", INBOUND, 200, { messages: [row(50, before(9)), row(51, before(8)), row(52, before(7))] });
    server.stage("GET", INBOUND, 200, { messages: [] });
    server.stage("GET", INBOUND, 200, { messages: [] }); // the normal poll after the seed
    const first = boot(baseUrl, { pairedAt: PAIRED_AT });
    await first.ws.triggerBackfill({ initial: true });
    expect(first.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(52);
  });

  it("a computer with a stored cursor behaves exactly as today (no history paging)", async () => {
    saveLastId(10);
    server.stage("GET", INBOUND, 200, { messages: [row(11, after(1)), row(12, after(2))] });
    const b = boot(baseUrl, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([11, 12]);
    const reqs = server.requests.filter((r) => r.url.startsWith(INBOUND));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.url).toContain("since_message_id=10");
  });

  it("a crash mid dispatch of the cold-start replay does not replay a row twice", async () => {
    server.stage("GET", INBOUND, 200, { messages: [row(7, after(1)), row(8, after(2))] });
    server.stage("GET", INBOUND, 200, { messages: [] });
    server.stage("GET", INBOUND, 200, { messages: [row(7, after(1)), row(8, after(2))] });
    const crashing = boot(baseUrl, { pairedAt: PAIRED_AT, crashAfter: 1 });
    await crashing.ws.triggerBackfill({ initial: true });
    expect(crashing.dispatched).toEqual([7]);

    // Restart: not a cold start any more; 8 had its cursor saved before the
    // dispatch that died (the existing rule), so it is not replayed.
    server.stage("GET", INBOUND, 200, { messages: [] });
    const restart = boot(baseUrl, { pairedAt: PAIRED_AT });
    await restart.ws.triggerBackfill({ initial: true });
    expect(restart.dispatched).toEqual([]);
    const last = server.requests.filter((r) => r.url.startsWith(INBOUND)).at(-1)!;
    expect(last.url).toContain("since_message_id=8");
  });
});

describe("BGOSAdapter hands the cold start its pairing time", () => {
  const originalHome = process.env.GOBOT_HOME;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "gobot-paired-at-"));
    process.env.GOBOT_HOME = home;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalHome;
  });

  const pairedAtSeenByPoll = async (): Promise<number | null> => {
    const { BGOSAdapter } = await import("../src/adapter.js");
    const adapter = new BGOSAdapter({
      baseUrl: "http://127.0.0.1:1",
      pairingToken: "pair_" + "x".repeat(30),
    });
    return (adapter as unknown as { ws: { pairedAt: () => number | null } }).ws.pairedAt();
  };

  it("reads pairedAt from the secrets file the pair CLI writes", async () => {
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(
      join(home, "secrets", "bgos.json"),
      JSON.stringify({ pairingToken: "t", pairedAt: "2026-11-01T10:00:00.000Z" }),
    );
    expect(await pairedAtSeenByPoll()).toBe(PAIRED_AT);
  });

  it("is null without a secrets file or with an unreadable pairedAt", async () => {
    expect(await pairedAtSeenByPoll()).toBeNull();
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "secrets", "bgos.json"), JSON.stringify({ pairedAt: "not a date" }));
    expect(await pairedAtSeenByPoll()).toBeNull();
  });
});
