import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  advanceIdleAgents,
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
    // ...and the migration was persisted once, so it is a single event.
    expect(JSON.parse(readFileSync(cursorsFile(), "utf8"))).toMatchObject({
      version: 1,
      floor: 480,
      agents: {},
    });

    // Agent 1 moves on; agent 2 (not yet served) keeps the migrated value, so
    // its next message (> 480) is still fetched.
    saveAgentCursor(1, 520);
    expect(loadAgentCursor(1)).toBe(520);
    expect(loadAgentCursor(2)).toBe(480);
    expect(pollSince([1, 2])).toBe(480);

    // The old file is not consulted again once the new one exists.
    writeFileSync(join(tempHome, "bgos_last_id"), "9999", "utf8");
    expect(loadAgentCursor(2)).toBe(480);
  });

  it("an agent exposed after the migration starts at the floor, not at 0", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "480", "utf8");
    saveAgentCursor(1, 520);
    expect(loadAgentCursor(99)).toBe(480);
  });

  it("the cursor file replaces a corrupt one by migrating again, never throws", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "77", "utf8");
    writeFileSync(cursorsFile(), "{not json", "utf8");
    expect(loadAgentCursor(1)).toBe(77);
  });

  it("seedAllCursors moves the floor and every given agent (storm guard, cold start)", () => {
    seedAllCursors([1, 2], 900);
    expect(loadAgentCursor(1)).toBe(900);
    expect(loadAgentCursor(2)).toBe(900);
    expect(loadAgentCursor(3)).toBe(900); // a later agent starts at the new floor
  });

  it("advanceIdleAgents moves only the idle agents and lifts the floor to the lowest known cursor", () => {
    writeFileSync(join(tempHome, "bgos_last_id"), "100", "utf8");
    saveAgentCursor(1, 400); // busy agent
    advanceIdleAgents([2], [1, 2], 400); // agent 2 had no row up to 400
    expect(loadAgentCursor(2)).toBe(400);
    expect(pollSince([1, 2])).toBe(400);
    expect(loadAgentCursor(3)).toBe(400); // floor lifted
  });

  it("the pending-unknown clamp holds every agent's cursor below the hole", () => {
    recordPendingUnknown(500, 9);
    saveAgentCursor(1, 600);
    expect(loadAgentCursor(1)).toBe(499);
    // And the poll window stays open down to the hole.
    expect(pollSince([1])).toBe(499);
  });

  it("deprecated loadLastId / saveLastId act on the gateway-wide floor", () => {
    expect(loadLastId()).toBe(0);
    saveLastId(42);
    expect(loadLastId()).toBe(42);
    saveLastId(30);
    expect(loadLastId()).toBe(42);
  });
});
