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
 * Format: `{"version":1,"floor":<n>,"agents":{"<assistantId>":<n>}}`.
 *   - `agents` holds each agent's own cursor.
 *   - `floor` is where an agent with no entry starts (a newly exposed agent).
 *     It never moves past the lowest cursor of the agents currently known.
 *
 * MIGRATION: before per-agent cursors the file was `$GOBOT_HOME/bgos_last_id`,
 * a single integer. When `bgos_last_ids.json` does not exist yet, `floor` is
 * seeded from that old value, so every agent starts exactly where the single
 * cursor was: nothing replays and nothing is skipped. The old file is left in
 * place and is no longer written.
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
  floor: number;
  agents: Record<string, number>;
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
    isCursor((parsed as CursorFile).floor)
  ) {
    const agents: Record<string, number> = {};
    const raw = (parsed as CursorFile).agents;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) {
        if (Number.isInteger(Number(k)) && isCursor(v)) agents[k] = v;
      }
    }
    return { version: 1, floor: (parsed as CursorFile).floor, agents };
  }
  const migrated: CursorFile = { version: 1, floor: readLegacyCursor(), agents: {} };
  if (migrated.floor > 0) writeCursors(migrated);
  return migrated;
}

/** One agent's cursor: its own entry, else the floor. */
export function loadAgentCursor(assistantId: number): number {
  const file = loadCursors();
  return file.agents[String(assistantId)] ?? file.floor;
}

/**
 * The id to poll `since_message_id` from: the LOWEST cursor of the given agents
 * (the poll returns every agent's rows, and each row is then kept or dropped by
 * its own agent's cursor), never above the lowest still-pending unknown id.
 * With no agents known yet, the floor.
 */
export function pollSince(knownAssistantIds: readonly number[]): number {
  const file = loadCursors();
  let since = file.floor;
  if (knownAssistantIds.length > 0) {
    since = Math.min(
      ...knownAssistantIds.map((id) => file.agents[String(id)] ?? file.floor),
    );
  }
  const lowest = lowestPendingUnknown();
  if (lowest !== null && lowest - 1 < since) since = Math.max(0, lowest - 1);
  return since;
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
 * Errors are caught + ignored — see module docstring.
 */
export function saveAgentCursor(assistantId: number, id: number): void {
  if (!Number.isInteger(assistantId)) return;
  advance([assistantId], id, false);
}

/**
 * Move several agents (and the floor) forward together: the storm guard and the
 * cold-start seed, which skip dispatch for a whole batch. `knownAssistantIds`
 * are the agents moved; agents added later start at the new floor.
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
 * would stop reaching new messages. Also lifts the floor to the lowest known
 * cursor, so a newly exposed agent does not start from a stale value.
 */
export function advanceIdleAgents(
  idleAssistantIds: readonly number[],
  knownAssistantIds: readonly number[],
  watermark: number,
): void {
  if (idleAssistantIds.length === 0 && knownAssistantIds.length === 0) return;
  advance(idleAssistantIds, watermark, false, knownAssistantIds);
}

function advance(
  assistantIds: readonly number[],
  id: number,
  raiseFloor: boolean,
  knownForFloor?: readonly number[],
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
      const current = file.agents[key] ?? file.floor;
      if (advanceTo > current) {
        file.agents[key] = advanceTo;
        changed = true;
      }
    }
    if (raiseFloor && advanceTo > file.floor) {
      file.floor = advanceTo;
      changed = true;
    }
    if (knownForFloor && knownForFloor.length > 0) {
      const lowestKnown = Math.min(
        ...knownForFloor.map((a) => file.agents[String(a)] ?? file.floor),
      );
      if (lowestKnown > file.floor) {
        file.floor = lowestKnown;
        changed = true;
      }
    }
    if (changed) writeCursors(file);
  } catch {
    /* swallow: see module docstring */
  }
}

/**
 * @deprecated Gateway-wide view kept for fork code that read the single
 * cursor: the floor (where an agent with no cursor of its own starts). The
 * adapter itself polls from `pollSince` and saves per agent.
 */
export function loadLastId(): number {
  return loadCursors().floor;
}

/**
 * @deprecated Raises the floor and every existing agent cursor to `id` (a
 * gateway-wide seed). The adapter saves per agent with `saveAgentCursor`.
 */
export function saveLastId(id: number): void {
  try {
    const file = loadCursors();
    seedAllCursors(
      Object.keys(file.agents).map(Number),
      id,
    );
  } catch {
    /* swallow */
  }
}
