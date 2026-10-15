/**
 * Persistent per-agent cursors for the BGOS inbound stream.
 *
 * CRITICAL — DO NOT REGRESS. Without persistence the adapter will replay
 * every historical message on every restart (the REST backfill cursor
 * starts at the loaded value), producing duplicate agent replies forever.
 *
 * See `memory/hermes_integration_shipped.md` "Critical gotcha: last-id
 * persistence" for the full background — this is the same fix as Hermes
 * commit-to-disk pattern, ported to TypeScript.
 *
 * ONE CURSOR PER AGENT (per assistant id), not one per gateway. The backend
 * delivers a message addressed to several agents as one poll row per agent, all
 * carrying the same message id. With a single gateway cursor, the first agent's
 * row moved the cursor past the id and the other agents' rows for that id were
 * dropped, or never fetched again after a restart in between. Each agent now
 * advances only past messages it consumed itself.
 *
 * File location: `$GOBOT_HOME/bgos_last_ids.json` (default
 * `~/.gobot/bgos_last_ids.json`).
 *
 * Format: `{"version":1,"head":<n>,"agents":{"<assistantId>":<n>},"migrating":<n>?}`.
 *   - `agents` holds each agent's own cursor.
 *   - `head` is the highest id any agent has consumed or been carried past. An
 *     agent exposed LATER starts there (its older rows are history it was not
 *     part of), exactly as the single cursor used to place it.
 *   - `migrating` exists only between the migration and the first poll.
 *
 * MIGRATION: before per-agent cursors the file was `$GOBOT_HOME/bgos_last_id`,
 * a single integer. When `bgos_last_ids.json` does not exist yet, every agent
 * known at the first poll gets that old value as its own cursor (`migrating`
 * holds it until then, so a live message that lands first cannot move it), so
 * every agent starts exactly where the single cursor was: nothing replays and
 * nothing is skipped. The old file is left in place and is no longer written.
 *
 * Writes are atomic (write-to-tempfile + rename) so a crash mid-write can't
 * leave a half-written file.
 *
 * All errors are swallowed — disk full, permission denied, missing
 * directory, etc. The worst case is a one-time replay on the next start;
 * we'd rather not crash the adapter for a persistence hiccup.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { lowestPendingUnknown } from "./pending-unknown-store.js";

interface CursorFile {
  version: 1;
  head: number;
  agents: Record<string, number>;
  /** The migrated single cursor, until the first poll hands it to each agent. */
  migrating?: number;
}

function stateRoot(): string {
  return process.env.GOBOT_HOME ?? join(homedir(), ".gobot");
}

/** The old single-cursor file (read only, for the migration). */
function legacyPath(): string {
  return join(stateRoot(), "bgos_last_id");
}

function cursorsPath(): string {
  return join(stateRoot(), "bgos_last_ids.json");
}

function isCursor(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** The pre per-agent single cursor, 0 when absent or unreadable. */
function readLegacyCursor(): number {
  try {
    const raw = readFileSync(legacyPath(), "utf8").trim();
    if (!raw) return 0;
    const n = Number(raw);
    return isCursor(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeCursors(file: CursorFile): void {
  try {
    const target = cursorsPath();
    mkdirSync(dirname(target), { recursive: true });
    // Write to a sibling tempfile then rename so a partial write never
    // leaves us with a corrupt cursor file.
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    /* swallow: see module docstring */
  }
}

/**
 * Read the cursor file. Never throws: a missing or unparseable file is the
 * first start, which migrates the old single cursor (and persists the result
 * once, so the migration is a single event).
 */
function loadCursors(): CursorFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(cursorsPath(), "utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    isCursor((parsed as CursorFile).head)
  ) {
    const agents: Record<string, number> = {};
    const raw = (parsed as CursorFile).agents;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (Number.isInteger(Number(k)) && isCursor(v)) agents[k] = v;
      }
    }
    const migrating = (parsed as CursorFile).migrating;
    return {
      version: 1,
      head: (parsed as CursorFile).head,
      agents,
      ...(isCursor(migrating) ? { migrating } : {}),
    };
  }
  const legacy = readLegacyCursor();
  const migrated: CursorFile = {
    version: 1,
    head: legacy,
    agents: {},
    ...(legacy > 0 ? { migrating: legacy } : {}),
  };
  if (legacy > 0) writeCursors(migrated);
  return migrated;
}

/**
 * One agent's cursor: its own entry, else where an agent not seen before
 * starts: the migrated value until the first poll, afterwards the head, and
 * never past a message of its own still pending as unknown (so an agent that
 * is exposed after its message arrived still gets it).
 */
function effective(file: CursorFile, assistantId: number): number {
  const own = file.agents[String(assistantId)];
  if (own !== undefined) return own;
  const base = file.migrating ?? file.head;
  const hole = lowestPendingUnknown(assistantId);
  return hole !== null ? Math.min(base, Math.max(0, hole - 1)) : base;
}

/** One agent's cursor. */
export function loadAgentCursor(assistantId: number): number {
  return effective(loadCursors(), assistantId);
}

/** A snapshot reader: read the file once, answer for many rows. */
export function agentCursorReader(): (assistantId: number) => number {
  const file = loadCursors();
  return (assistantId) => effective(file, assistantId);
}

/** The agents that have a cursor of their own. */
export function agentCursorIds(): number[] {
  return Object.keys(loadCursors().agents).map(Number);
}

/** True before any message has ever been consumed or skipped on this install. */
export function isColdStart(): boolean {
  const file = loadCursors();
  return file.head === 0 && file.migrating === undefined;
}

/**
 * The id to poll `since_message_id` from: the LOWEST cursor of the given agents
 * (the poll returns every agent's rows, and each row is then kept or dropped by
 * its own agent's cursor), never above the lowest still-pending unknown id.
 * With no agents known yet, the head.
 *
 * Also gives every known agent that has no entry its own (the migrated value on
 * the first poll after an upgrade, the head for an agent exposed later), so
 * from then on it is just a cursor like the others.
 */
export function pollSince(knownAssistantIds: readonly number[]): number {
  const file = loadCursors();
  let changed = false;
  for (const aid of knownAssistantIds) {
    if (file.agents[String(aid)] === undefined) {
      file.agents[String(aid)] = effective(file, aid);
      changed = true;
    }
  }
  // Only a poll that serves agents hands the migrated value over: one with none
  // known (identity not loaded, or nothing exposed) keeps it for the agents
  // that come, or a live message could move the head past it first.
  if (file.migrating !== undefined && knownAssistantIds.length > 0) {
    delete file.migrating;
    changed = true;
  }
  if (changed) writeCursors(file);
  let since = file.head;
  if (knownAssistantIds.length > 0) {
    since = Math.min(...knownAssistantIds.map((id) => effective(file, id)));
  }
  const lowest = lowestPendingUnknown();
  if (lowest !== null && lowest - 1 < since) since = Math.max(0, lowest - 1);
  return since;
}

/**
 * Agents that were absent from the known set and are back (removed from the
 * pairing, then exposed again while this gateway ran) rejoin at the head like
 * an agent seen for the first time: what arrived for them while away is history
 * they were not part of, not a backlog to replay or a storm to trip over. Never
 * moves a cursor down, and stays below the agent's own pending-unknown row.
 */
export function rebaseReexposedAgents(assistantIds: readonly number[]): void {
  if (assistantIds.length === 0) return;
  try {
    const file = loadCursors();
    let changed = false;
    for (const aid of assistantIds) {
      const own = file.agents[String(aid)];
      if (own === undefined) continue;
      const hole = lowestPendingUnknown(aid);
      const target = hole !== null ? Math.min(file.head, Math.max(0, hole - 1)) : file.head;
      if (target > own) {
        file.agents[String(aid)] = target;
        changed = true;
      }
    }
    if (changed) writeCursors(file);
  } catch {
    /* swallow: see module docstring */
  }
}

/**
 * Atomically persist ONE agent's cursor.
 *
 * Skips:
 *   - Non-positive ids (0 means "no progress"; negative is malformed).
 *   - Ids less than or equal to that agent's current cursor (a cursor must
 *     advance monotonically). This guards against a backfill replay
 *     accidentally rewinding it.
 *
 * Clamp: the cursor never advances past the LOWEST still-pending unknown
 * assistant id (see pending-unknown-store). Without this a sibling KNOWN
 * message with a higher id would push the cursor past an unconsumed unknown
 * message, stranding it forever (silent loss). The clamp holds the cursor just
 * below the hole so the inbound window stays re-fetchable until the route heals
 * and the pending id is consumed + cleared.
 *
 * Errors are caught + ignored: see module docstring.
 */
export function saveAgentCursor(assistantId: number, id: number): void {
  if (!Number.isInteger(assistantId)) return;
  advance([assistantId], id, false);
}

/**
 * Move several agents (and the head) forward together: the storm guard and the
 * cold-start seed, which skip dispatch for a whole batch. Agents exposed later
 * start at the new head.
 */
export function seedAllCursors(
  knownAssistantIds: readonly number[],
  id: number,
): void {
  advance(knownAssistantIds, id, true);
}

/**
 * After a poll that returned rows up to `watermark` (every row at or below it
 * is in that response), the agents that had NO row in it have nothing pending
 * at or below it: move them to the watermark. Without this an idle agent's
 * cursor would pin the poll window below everyone else's and the 200 row page
 * would stop reaching new messages.
 */
export function advanceIdleAgents(
  idleAssistantIds: readonly number[],
  watermark: number,
): void {
  if (idleAssistantIds.length === 0) return;
  advance(idleAssistantIds, watermark, false);
}

function advance(
  assistantIds: readonly number[],
  id: number,
  seed: boolean,
): void {
  if (!Number.isFinite(id) || !Number.isInteger(id) || id <= 0) return;
  try {
    const file = loadCursors();
    // Clamp against the lowest pending-unknown id so a cursor never strands an
    // unconsumed message above the hole.
    let advanceTo = id;
    const lowest = lowestPendingUnknown();
    if (lowest !== null && advanceTo >= lowest) advanceTo = lowest - 1;
    let changed = false;
    for (const aid of assistantIds) {
      const key = String(aid);
      if (advanceTo > effective(file, aid)) {
        file.agents[key] = advanceTo;
        changed = true;
      }
    }
    if ((seed || assistantIds.length > 0) && advanceTo > file.head) {
      file.head = advanceTo;
      changed = true;
    }
    if (seed && file.migrating !== undefined) {
      delete file.migrating;
      changed = true;
    }
    if (changed) writeCursors(file);
  } catch {
    /* swallow: see module docstring */
  }
}

/**
 * @deprecated Gateway-wide view kept for fork code that read the single
 * cursor: the head. The adapter itself polls from `pollSince` and saves per
 * agent.
 */
export function loadLastId(): number {
  return loadCursors().head;
}

/**
 * @deprecated Raises the head and every existing agent cursor to `id` (a
 * gateway-wide seed). The adapter saves per agent with `saveAgentCursor`.
 */
export function saveLastId(id: number): void {
  try {
    const file = loadCursors();
    seedAllCursors(Object.keys(file.agents).map(Number), id);
  } catch {
    /* swallow */
  }
}
