import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advanceIdleAgents,
  isColdStart,
  loadAgentCursor,
  loadLastId,
  pollSince,
  saveAgentCursor,
  saveLastId,
  seedAllCursors,
} from "../src/last-id-store.js";
import { recordPendingUnknown } from "../src/pending-unknown-store.js";

describe("last-id-store", () => {
  let tempHome: string;
  const originalGobotHome = process.env.GOBOT_HOME;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "gobot-channel-test-"));
    process.env.GOBOT_HOME = tempHome;
  });

  afterEach(() => {
    if (originalGobotHome === undefined) {
      delete process.env.GOBOT_HOME;
    } else {
      process.env.GOBOT_HOME = originalGobotHome;
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  const cursorsFile = () => join(tempHome, "bgos_last_ids.json");

  it("an agent with no cursor starts at 0 on a fresh install", () => {
    expect(loadAgentCursor(7)).toBe(0);
    expect(pollSince([7, 8])).toBe(0);
  });

  it("each agent keeps its own cursor", () => {
    pollSince([1, 2]); // both known from the start
    saveAgentCursor(1, 500);
    saveAgentCursor(2, 300);
    expect(loadAgentCursor(1)).toBe(500);
    expect(loadAgentCursor(2)).toBe(300);
    // The poll starts from the LOWEST of the agents it serves.
    expect(pollSince([1, 2])).toBe(300);
    // Persisted on disk as JSON, one entry per agent.
    expect(JSON.parse(readFileSync(cursorsFile(), "utf8"))).toMatchObject({
      version: 1,
      agents: { "1": 500, "2": 300 },
    });
  });

  it("a cursor never regresses and rejects 0 / negative / non-integer ids", () => {
    saveAgentCursor(1, 100);
    saveAgentCursor(1, 50);
    saveAgentCursor(1, 0);
    saveAgentCursor(1, -5);
    saveAgentCursor(1, 3.14);
    saveAgentCursor(1, NaN);
    expect(loadAgentCursor(1)).toBe(100);
  });

  it("MIGRATION: every agent starts from the old single cursor, nothing replays, nothing is lost", () => {
    // The pre per-agent install: one integer in bgos_last_id.
    writeFileSync(join(tempHome, "bgos_last_id"), "480", "utf8");

    // First start under the new code: both agents sit exactly at the old value.
    expect(loadAgentCursor(1)).toBe(480);
    expect(loadAgentCursor(2)).toBe(480);
    expect(pollSince([1, 2])).toBe(480); // not replayed: polls past 480
    // ...and each agent now has its own entry; the migration is one event.
    expect(JSON.parse(readFileSync(cursorsFile(), "utf8"))).toEqual({
      version: 1,
      head: 480,
      agents: { "1": 480, "2": 480 },
    });

    // Agent 1 moves on; agent 2 keeps the migrated value, so its next message
    // (> 480) is still fetched.
    saveAgentCursor(1, 520);
    expect(loadAgentCursor(1)).toBe(520);
    expect(loadAgentCursor(2)).toBe(480);
    expect(pollSince([1, 2])).toBe(480);

    // The old file is not consulted again once the new one exists.
    writeFileSync(join(tempHome, "bgos_last_id"), "9999", "utf8");
    expect(loadAgentCursor(2)).toBe(480);
  });

  it("MIGRATION: a live message that lands before the first poll cannot move another agent's start", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "480", "utf8");

    saveAgentCursor(1, 520); // agent 1's live message, before any poll

    expect(loadAgentCursor(2)).toBe(480);
    expect(pollSince([1, 2])).toBe(480);
    expect(loadAgentCursor(2)).toBe(480);
  });

  it("an agent exposed after the first poll starts at the head, not at a stale value", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "480", "utf8");
    expect(pollSince([1])).toBe(480);
    saveAgentCursor(1, 90000);
    // Agent 7 is exposed much later: its old rows are history, as they were
    // for the single cursor.
    expect(loadAgentCursor(7)).toBe(90000);
    expect(pollSince([1, 7])).toBe(90000);
  });

  it("an agent exposed after its message arrived still gets that message (pending-unknown hole)", () => {
    saveAgentCursor(1, 400);
    recordPendingUnknown(450, 9); // agent 9's row, left unconsumed
    saveAgentCursor(1, 600);
    // Agent 1 is held below the hole, and agent 9 starts below it too.
    expect(loadAgentCursor(9)).toBe(449);
    expect(pollSince([1, 9])).toBe(449);
  });

  it("the cursor file replaces a corrupt one by migrating again, never throws", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "77", "utf8");
    writeFileSync(cursorsFile(), "{not json", "utf8");
    expect(loadAgentCursor(1)).toBe(77);
  });

  it("isColdStart is true only before anything was ever consumed", () => {
    expect(isColdStart()).toBe(true);
    saveAgentCursor(1, 5);
    expect(isColdStart()).toBe(false);
  });

  it("isColdStart is false right after a migration", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "480", "utf8");
    expect(isColdStart()).toBe(false);
  });

  it("seedAllCursors moves the head and every given agent (storm guard, cold start)", () => {
    seedAllCursors([1, 2], 900);
    expect(loadAgentCursor(1)).toBe(900);
    expect(loadAgentCursor(2)).toBe(900);
    expect(loadAgentCursor(3)).toBe(900); // a later agent starts at the new head
  });

  it("advanceIdleAgents moves only the agents it is given", () => {
    saveAgentCursor(1, 400); // busy agent
    saveAgentCursor(2, 100);
    advanceIdleAgents([2], 400); // agent 2 had no row up to 400
    expect(loadAgentCursor(2)).toBe(400);
    expect(pollSince([1, 2])).toBe(400);
  });

  it("the pending-unknown clamp holds every agent's cursor below the hole", () => {
    recordPendingUnknown(500, 9);
    saveAgentCursor(1, 600);
    expect(loadAgentCursor(1)).toBe(499);
    // And the poll window stays open down to the hole.
    expect(pollSince([1])).toBe(499);
  });

  it("deprecated loadLastId / saveLastId act on the gateway-wide head", () => {
    expect(loadLastId()).toBe(0);
    saveLastId(42);
    expect(loadLastId()).toBe(42);
    saveLastId(30);
    expect(loadLastId()).toBe(42);
  });
});
