import type {
  BgosApi,
  CreateMissionBody,
  MissionMiniGoalInput,
  MissionProgressInput,
} from "./bgos-api.js";

export const MISSION_MARKER_OPEN = "[[BGOS_MISSION]]";
export const MISSION_MARKER_CLOSE = "[[/BGOS_MISSION]]";

const MISSION_BLOCK_RE =
  /\[\[BGOS_MISSION\]\]([\s\S]*?)\[\[\/BGOS_MISSION\]\]/g;

const TITLE_MAX = 200;
const MINI_GOAL_NAME_MAX = 120;
const DONE_WHEN_MAX = 200;
const EVIDENCE_MAX = 200;
const FEED_TEXT_MAX = 200;
const SUMMARY_MAX = 500;
const PROGRESS_LABEL_MAX = 40;

export interface CreateMissionOp {
  op: "create";
  title: string;
  miniGoals?: MissionMiniGoalInput[];
  progress?: MissionProgressInput;
}

export interface TickMissionOp {
  op: "tick";
  goalId: number;
  evidence?: string;
}

export interface ProgressMissionOp {
  op: "progress";
  progress?: MissionProgressInput;
  feedText?: string;
}

export interface CompleteMissionOp {
  op: "complete";
  summary?: string;
}

export interface AbandonMissionOp {
  op: "abandon";
}

export type MissionOp =
  | CreateMissionOp
  | TickMissionOp
  | ProgressMissionOp
  | CompleteMissionOp
  | AbandonMissionOp;

export interface MissionDispatchState {
  missionId?: number;
  pending?: Promise<void>;
}

export interface ParsedMissionMarkers {
  cleanText: string;
  ops: MissionOp[];
}

export type MissionApi = Pick<
  BgosApi,
  | "createMission"
  | "getActiveMission"
  | "tickMiniGoal"
  | "updateMissionProgress"
  | "completeMission"
  | "abandonMission"
>;

export type MissionMarkerOp = MissionOp;
export type MissionMarkerParseResult = ParsedMissionMarkers;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = numericValue(value);
  if (numeric === undefined) return undefined;
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : undefined;
}

function integerAtLeast(value: unknown, minimum: number): number | undefined {
  const numeric = numericValue(value);
  return numeric !== undefined && Number.isInteger(numeric) && numeric >= minimum
    ? numeric
    : undefined;
}

function parseProgress(value: unknown): MissionProgressInput | undefined {
  if (!isRecord(value)) return undefined;
  const current = integerAtLeast(value.current, 0);
  const total = integerAtLeast(value.total, 1);
  if (current === undefined || total === undefined) return undefined;

  const progress: MissionProgressInput = { current, total };
  const label = truncateString(value.label, PROGRESS_LABEL_MAX);
  if (label !== undefined) progress.label = label;
  return progress;
}

function parseMiniGoals(value: unknown): MissionMiniGoalInput[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 12) {
    return undefined;
  }

  const goals: MissionMiniGoalInput[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const name = truncateString(candidate.name, MINI_GOAL_NAME_MAX);
    const doneWhen = truncateString(candidate.doneWhen, DONE_WHEN_MAX);
    if (!name?.trim() || !doneWhen?.trim()) return undefined;
    goals.push({ name, doneWhen });
  }
  return goals;
}

function parseMissionOp(value: unknown): MissionOp | null {
  if (!isRecord(value) || typeof value.op !== "string") return null;

  switch (value.op) {
    case "create": {
      const title = truncateString(value.title, TITLE_MAX);
      if (!title?.trim()) return null;
      const op: CreateMissionOp = { op: "create", title };
      const miniGoals = parseMiniGoals(value.miniGoals);
      const progress = parseProgress(value.progress);
      if (miniGoals !== undefined) op.miniGoals = miniGoals;
      if (progress !== undefined) op.progress = progress;
      return op;
    }
    case "tick": {
      const goalId = positiveInteger(value.goalId);
      if (goalId === undefined) return null;
      const op: TickMissionOp = { op: "tick", goalId };
      const evidence = truncateString(value.evidence, EVIDENCE_MAX);
      if (evidence !== undefined) op.evidence = evidence;
      return op;
    }
    case "progress": {
      const progress = parseProgress(value.progress);
      const feedText = truncateString(value.feedText, FEED_TEXT_MAX);
      if (progress === undefined && feedText === undefined) return null;
      const op: ProgressMissionOp = { op: "progress" };
      if (progress !== undefined) op.progress = progress;
      if (feedText !== undefined) op.feedText = feedText;
      return op;
    }
    case "complete": {
      const op: CompleteMissionOp = { op: "complete" };
      const summary = truncateString(value.summary, SUMMARY_MAX);
      if (summary !== undefined) op.summary = summary;
      return op;
    }
    case "abandon":
      return { op: "abandon" };
    default:
      return null;
  }
}

/** Parse all complete mission blocks while preserving every other byte. */
export function parseMissionMarkers(text: string): ParsedMissionMarkers {
  if (!text) return { cleanText: text ?? "", ops: [] };
  if (!text.includes(MISSION_MARKER_OPEN)) {
    return { cleanText: text, ops: [] };
  }

  const ops: MissionOp[] = [];
  const cleanText = text.replace(MISSION_BLOCK_RE, (_block, body: string) => {
    try {
      const op = parseMissionOp(JSON.parse(body));
      if (op) ops.push(op);
    } catch {
      // A malformed block is still removed from the visible reply.
    }
    return "";
  });
  return { cleanText, ops };
}

function responseStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missionIdFrom(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const id = value.id;
  return typeof id === "number" && Number.isInteger(id) && id > 0
    ? id
    : undefined;
}

async function resolveMissionId(
  api: MissionApi,
  assistantId: number,
  state: MissionDispatchState,
): Promise<number | undefined> {
  const stored = state.missionId;
  if (typeof stored === "number" && Number.isInteger(stored) && stored > 0) {
    return stored;
  }

  delete state.missionId;
  const active = await api.getActiveMission(assistantId);
  if (active.mission === null) return undefined;
  const resolved = missionIdFrom(active.mission);
  if (resolved === undefined) {
    throw new Error("active mission response did not include a valid id");
  }
  state.missionId = resolved;
  return resolved;
}

function logFailure(op: MissionOp, assistantId: number, error: unknown): void {
  try {
    console.warn(
      `[gobot-channel-bgos] mission ${op.op} failed for assistant ${assistantId}: ${formatError(error)}`,
    );
  } catch {
    // Logging is best-effort and must never escape mission dispatch.
  }
}

/**
 * Dispatch parsed operations in source order. Every API failure is logged and
 * swallowed so mission reporting can never suppress the visible reply.
 */
async function runMissionOps(
  api: MissionApi,
  assistantId: number,
  ops: readonly MissionOp[],
  state: MissionDispatchState,
): Promise<void> {
  let blockedByFailedCreate = false;
  for (const op of ops) {
    if (blockedByFailedCreate && op.op !== "create") continue;
    let attemptedMissionId: number | undefined;
    let patchAttempted = false;
    try {
      switch (op.op) {
        case "create": {
          delete state.missionId;
          const body: CreateMissionBody = {
            title: op.title,
            origin: "self_report",
          };
          if (op.miniGoals !== undefined) body.miniGoals = op.miniGoals;
          if (op.progress !== undefined) body.progress = op.progress;
          const response = await api.createMission(assistantId, body);
          const createdId = missionIdFrom(response.mission);
          if (createdId === undefined) {
            throw new Error("create mission response did not include a valid id");
          }
          state.missionId = createdId;
          blockedByFailedCreate = false;
          break;
        }
        case "tick": {
          attemptedMissionId = await resolveMissionId(api, assistantId, state);
          if (attemptedMissionId === undefined) break;
          patchAttempted = true;
          await api.tickMiniGoal(assistantId, attemptedMissionId, {
            goalId: op.goalId,
            ...(op.evidence !== undefined ? { evidence: op.evidence } : {}),
          });
          break;
        }
        case "progress": {
          attemptedMissionId = await resolveMissionId(api, assistantId, state);
          if (attemptedMissionId === undefined) break;
          patchAttempted = true;
          await api.updateMissionProgress(assistantId, attemptedMissionId, {
            ...(op.progress !== undefined ? { progress: op.progress } : {}),
            ...(op.feedText !== undefined
              ? { feedEntry: { kind: "worked" as const, text: op.feedText } }
              : {}),
          });
          break;
        }
        case "complete": {
          attemptedMissionId = await resolveMissionId(api, assistantId, state);
          if (attemptedMissionId === undefined) break;
          patchAttempted = true;
          await api.completeMission(assistantId, attemptedMissionId, {
            ...(op.summary !== undefined ? { summary: op.summary } : {}),
          });
          if (state.missionId === attemptedMissionId) delete state.missionId;
          break;
        }
        case "abandon": {
          attemptedMissionId = await resolveMissionId(api, assistantId, state);
          if (attemptedMissionId === undefined) break;
          patchAttempted = true;
          await api.abandonMission(assistantId, attemptedMissionId);
          if (state.missionId === attemptedMissionId) delete state.missionId;
          break;
        }
      }
    } catch (error) {
      if (op.op === "create") {
        delete state.missionId;
        blockedByFailedCreate = true;
      } else if (
        patchAttempted &&
        responseStatus(error) === 404 &&
        attemptedMissionId !== undefined &&
        state.missionId === attemptedMissionId
      ) {
        delete state.missionId;
      }
      logFailure(op, assistantId, error);
    }
  }
}

export function dispatchMissionOps(
  api: MissionApi,
  assistantId: number,
  ops: readonly MissionOp[],
  state: MissionDispatchState,
): Promise<void> {
  const previous = state.pending;
  const pending = previous
    ? previous
        .catch(() => undefined)
        .then(() => runMissionOps(api, assistantId, ops, state))
    : runMissionOps(api, assistantId, ops, state);
  state.pending = pending;
  const clearPending = () => {
    if (state.pending === pending) delete state.pending;
  };
  void pending.then(clearPending, clearPending);
  return pending;
}
