/**
 * A computer that has never consumed a message must not skip what was sent
 * while it slept.
 *
 * Before: `isColdStart()` stayed true until something was consumed, so a first
 * boot that found an EMPTY history wrote nothing, and the next boot (the wake)
 * was a "cold start" again: it seeded the cursors past everything sent in
 * between and dispatched none of it. The same seed also dropped what arrived
 * between pairing and the first boot.
 *
 * After: the cold start runs once per install (a marker is persisted even when
 * history is empty), and it picks ONE cursor: just below the first row (in id
 * order) created at or after the pairing less a 10 minute slack (the pairing
 * time clamped to the newest row's time), never more than the replay bound
 * below the newest id. Everything above that cursor is replayed by the normal
 * poll in id order, so the selected rows and the dispatched rows are the same.
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

/**
 * A server that answers the poll the way the backend does: every row above
 * `since_message_id`, ascending by id, at most 200 per page. Unlike a staged
 * response it cannot be told which rows to return, so what a test sees
 * dispatched is exactly what the seeded cursor left above it.
 */
function historyServer(history: ReturnType<typeof row>[]) {
  const sinces: number[] = [];
  const api = {
    async inboundSince(since: number) {
      sinces.push(since);
      const messages = history
        .filter((r) => r.message_id > since)
        .sort((a, b) => a.message_id - b.message_id)
        .slice(0, 200);
      return { messages };
    },
  };
  return { api, sinces };
}

function bootOn(
  api: unknown,
  opts: { pairedAt: number | null; known?: number[] },
) {
  const ws = new BgosWs({} as never, api as never);
  ws.setKnownAssistants(() => opts.known ?? [1]);
  ws.setPairedAt(() => opts.pairedAt);
  const dispatched: number[] = [];
  const seen = new Set<string>();
  ws.on("inbound_message", (m: InboundMessagePayload) => {
    const key = `${m.assistantId}:${m.messageId}`;
    if (seen.has(key)) return;
    seen.add(key);
    saveAgentCursor(m.assistantId, m.messageId);
    dispatched.push(m.messageId);
  });
  let storm = 0;
  ws.on("backfill_storm", (n: number) => {
    storm = n;
  });
  return { ws, dispatched, storm: () => storm };
}

/** The ids the poll after the seed was asked to start above (the cursor). */
const replayCursor = (sinces: number[]) => sinces.at(-1)!;

describe("cold start replay: one contiguous, bounded range above one cursor", () => {
  let tempHome: string;
  const originalHome = process.env.GOBOT_HOME;
  const originalStorm = process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
  const originalBound = process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-cold-range-"));
    process.env.GOBOT_HOME = tempHome;
    delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    delete process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;
  });
  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.GOBOT_HOME;
    else process.env.GOBOT_HOME = originalHome;
    if (originalStorm === undefined) delete process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT;
    else process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT = originalStorm;
    if (originalBound === undefined) delete process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT;
    else process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = originalBound;
  });

  /** Every history id above `cursor`, ascending: what the seed selected. */
  const above = (history: ReturnType<typeof row>[], cursor: number) =>
    history.map((r) => r.message_id).filter((id) => id > cursor).sort((a, b) => a - b);

  it("an out of order timestamp between post pairing ids: the range is contiguous and is exactly what is dispatched", async () => {
    // 101 carries a pre pairing time (a server clock correction) between 100
    // and 102, which were created after the pairing.
    const history = [row(90, before(60)), row(100, after(1)), row(101, before(60)), row(102, after(2))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(replayCursor(sinces)).toBe(99);
    expect(b.dispatched).toEqual([100, 101, 102]);
    expect(b.dispatched).toEqual(above(history, replayCursor(sinces)));
  });

  it("the same history with a replay limit of 2 replays only the newest 2 ids, and nothing else", async () => {
    process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = "2";
    const history = [row(90, before(60)), row(100, after(1)), row(101, before(60)), row(102, after(2))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(replayCursor(sinces)).toBe(100);
    expect(b.dispatched).toEqual([101, 102]);
    expect(b.dispatched).toEqual(above(history, replayCursor(sinces)));
  });

  it("a row with no timestamp between post pairing ids is replayed with its neighbours", async () => {
    const noTime = { ...row(101, after(1)), created_at: undefined as unknown as string };
    const history = [row(90, before(60)), row(100, after(1)), noTime, row(102, after(2))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([100, 101, 102]);
    expect(b.dispatched).toEqual(above(history, replayCursor(sinces)));
  });

  it("a pairing clock ten minutes fast still replays the messages sent right after the pairing", async () => {
    // The real pairing is PAIRED_AT; the paired computer's clock wrote it ten
    // minutes late. 10 and 11 were sent a minute or two after it, 12 and 13
    // later, so the pairing time is not clamped (rows exist past it).
    const storedPairedAt = PAIRED_AT + 10 * 60_000;
    const history = [
      row(5, before(60)),
      row(10, after(1)),
      row(11, after(2)),
      row(12, after(15)),
      row(13, after(16)),
    ];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: storedPairedAt });
    await b.ws.triggerBackfill({ initial: true });
    expect(replayCursor(sinces)).toBe(9);
    expect(b.dispatched).toEqual([10, 11, 12, 13]);
  });

  it("a pairing time far in the future of the data is clamped to the newest row, so the newest rows replay", async () => {
    // Clock an hour fast: beyond the slack. Without the clamp nothing would
    // qualify and the seed would skip 10 and 11 for good.
    const history = [row(5, before(60)), row(10, after(1)), row(11, after(2))];
    const { api } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT + 60 * 60_000 });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([10, 11]);
  });

  it("a long post pairing history (several pages) replays only the newest ids of the bound, without a storm", async () => {
    const history = Array.from({ length: 500 }, (_, i) => row(i + 1, after(1 + i / 100)));
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    // Default bound 10: the cursor is at most 10 ids below the newest.
    expect(replayCursor(sinces)).toBe(490);
    expect(b.dispatched).toEqual(Array.from({ length: 10 }, (_, i) => 491 + i));
    expect(b.storm()).toBe(0);
  });

  it("a scan that runs out of its page budget replays nothing extra and seeds the TRUE newest id (storm guard off)", async () => {
    // 30,000 post pairing rows at 200 a page: the 100 page scan stops at id
    // 20,000, far below the end of history. That is not a complete scan.
    process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = "10";
    process.env.GOBOT_BGOS_BACKFILL_STORM_LIMIT = "0";
    const newest = 30_000;
    const history = Array.from({ length: newest }, (_, i) => row(i + 1, after(1 + i / 1000)));
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    // The reviewer's bound: never more than the limit, never below newest - limit.
    expect(b.dispatched.length).toBeLessThanOrEqual(10);
    for (const id of b.dispatched) expect(id).toBeGreaterThan(newest - 10);
    // Fail safe: nothing extra at all, the cursor is the true newest (not
    // 20,000, the last id the scan saw), and the seed is finished.
    expect(b.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(newest);
    expect(isColdStart()).toBe(false);
    expect(b.storm()).toBe(0);
    // Finding the newest is a handful of probes, not a page walk to the end.
    expect(sinces.length).toBeLessThan(100 + 40);
    // A later poll starts above the true newest and dispatches only new rows.
    history.push(row(newest + 1, after(60)));
    await b.ws.triggerBackfill();
    expect(b.dispatched).toEqual([newest + 1]);
  });

  it("the same budget cutoff with the default storm guard and sparse ids: no storm, cursor at the true newest", async () => {
    // Ids with gaps (every 7th), so the newest is found by search, not by
    // landing on it.
    const history = Array.from({ length: 30_000 }, (_, i) => row(7 * (i + 1), after(1 + i / 1000)));
    const newest = 7 * 30_000;
    const { api } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([]);
    expect(b.storm()).toBe(0);
    expect(loadAgentCursor(1)).toBe(newest);
    expect(isColdStart()).toBe(false);
  });

  it("the newest id search finds the true newest from any floor, over sparse and dense histories", async () => {
    // Deterministic pseudo random histories: dense runs, wide gaps, and ids
    // one apart at the end (the gap of 1 edge of the halving).
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let trial = 0; trial < 60; trial++) {
      const ids: number[] = [];
      let id = 1 + rand(50);
      const count = 1 + rand(2000);
      for (let i = 0; i < count; i++) {
        ids.push(id);
        id += rand(5) === 0 ? 1 + rand(100_000) : 1 + rand(3);
      }
      const history = ids.map((x) => row(x, after(1)));
      const { api, sinces } = historyServer(history);
      const ws = new BgosWs({} as never, api as never);
      const find = (ws as unknown as { findNewestInboundId(f: number): Promise<number> })
        .findNewestInboundId.bind(ws);
      const floor = ids[rand(ids.length)];
      expect(await find(floor), `trial ${trial} floor ${floor}`).toBe(ids.at(-1));
      expect(sinces.length).toBeLessThan(120);
    }
  });

  it("the clock clamp uses the time of the row that is newest BY ID, not the latest time seen", async () => {
    // 100, 101, 102 at 10:01, 11:00, 10:02 the same day (a server clock
    // correction put 101 ahead). The pairing clock is fast and wrote 12:00.
    // The newest row by id is 102 (10:02), so the threshold is 09:52 and the
    // cursor is 99: all three replay. Clamping to 11:00 (the latest time)
    // would put the cursor at 100 and lose message 100 for good.
    const history = [row(100, after(1)), row(101, after(60)), row(102, after(2))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT + 120 * 60_000 });
    await b.ws.triggerBackfill({ initial: true });
    expect(replayCursor(sinces)).toBe(99);
    expect(b.dispatched).toEqual([100, 101, 102]);
  });

  it("a history entirely older than the pairing: the clamp keeps only the rows within the slack of the newest row", async () => {
    // The pairing time is past every row, so it is clamped to the newest row's
    // time (the client cannot tell a fast pairing clock from a quiet pairing).
    // Only what was created within 10 minutes of that newest row replays.
    const history = [row(50, before(600)), row(51, before(300)), row(52, before(295))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(replayCursor(sinces)).toBe(50);
    expect(b.dispatched).toEqual([51, 52]);
  });

  it("without a pairing time it seeds to the newest id and replays nothing (as today)", async () => {
    const history = [row(5, before(60)), row(10, after(1)), row(11, after(2))];
    const { api } = historyServer(history);
    const b = bootOn(api, { pairedAt: null });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(11);
    expect(isColdStart()).toBe(false);
  });

  it("a replay limit of 0 replays nothing (the old seed)", async () => {
    process.env.GOBOT_BGOS_COLD_START_REPLAY_LIMIT = "0";
    const history = [row(5, before(60)), row(10, after(1)), row(11, after(2))];
    const { api } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(b.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(11);
  });

  it("a computer with a stored cursor is unchanged: no history paging, no pairing rule", async () => {
    saveLastId(10);
    const history = [row(5, before(60)), row(10, after(1)), row(11, before(60)), row(12, after(2))];
    const { api, sinces } = historyServer(history);
    const b = bootOn(api, { pairedAt: PAIRED_AT });
    await b.ws.triggerBackfill({ initial: true });
    expect(sinces).toEqual([10]);
    expect(b.dispatched).toEqual([11, 12]);
  });

  it("no row is dispatched twice: the replay, a second poll and a restart dispatch each row once", async () => {
    const history = [row(5, before(60)), row(10, after(1)), row(11, after(2))];
    const { api } = historyServer(history);
    const first = bootOn(api, { pairedAt: PAIRED_AT });
    await first.ws.triggerBackfill({ initial: true });
    await first.ws.triggerBackfill();
    expect(first.dispatched).toEqual([10, 11]);
    const restart = bootOn(api, { pairedAt: PAIRED_AT });
    await restart.ws.triggerBackfill({ initial: true });
    expect(restart.dispatched).toEqual([]);
    expect(loadAgentCursor(1)).toBe(11);
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
    for (const bad of ["not a date", "0", "1730455200000", "2026-11-01", "Nov 1 2026"]) {
      writeFileSync(join(home, "secrets", "bgos.json"), JSON.stringify({ pairedAt: bad }));
      expect(await pairedAtSeenByPoll(), bad).toBeNull();
    }
    writeFileSync(join(home, "secrets", "bgos.json"), JSON.stringify({ pairedAt: 0 }));
    expect(await pairedAtSeenByPoll()).toBeNull();
  });
});
