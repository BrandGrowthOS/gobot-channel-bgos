/**
 * Pure functions for the `[[BGOS_BOARDS]]` marker round trip (Agent Boards).
 *
 * A faithful TypeScript port of the Hermes reference implementation
 * (`hermes-channel-bgos/src/hermes_channel_bgos/boards_marker.py`, shipped in
 * BGOS #1026); the protocol is identical on the wire. Gobot's other BGOS
 * capabilities are fire and forget. Boards is not: `query` must return rows
 * TO the agent mid task, and the only inbound path to a Gobot agent is a
 * dispatched turn. The protocol therefore has two pure halves, both here,
 * both free of I/O so they unit test cleanly:
 *
 * REQUEST half. The agent embeds one JSON object per block in its normal
 * reply:
 *
 *   [[BGOS_BOARDS]]{"op":"query","board":"Tasks","reqId":"q1","limit":20}[[/BGOS_BOARDS]]
 *
 * `parseBoardsBlocks` strips every block from the visible text (the user
 * must never see marker syntax) and returns well formed blocks as
 * `BoardsRequest` and malformed ones as `BoardsParseError`. Invalid JSON is
 * NOT silently ignored: the agent is waiting on data, so a malformed block
 * must come back as an error section or the round trip strands.
 * `planRequest` maps a request to the exact REST call on the agent family
 * routes (`/api/v1/integrations/assistants/:id/boards...`); the api client
 * (`BgosApi.boardsCall`) owns that prefix and never re-derives paths.
 *
 * RESULT half. The orchestrator dispatches ONE synthetic system turn back
 * into the agent's session (the fork dispatch mechanism the voice lane's
 * `runBrainTurn` already uses). `buildResultTurn` renders it: a fixed
 * provenance header, then one `### reqId=<id> op=<op>` section per call in
 * request order. Backend bodies, markdown and denials alike, pass through
 * VERBATIM: the boards denial wording is a leak proof contract (see backend
 * boards-access.filter.ts) and must never be paraphrased by a channel.
 *
 * Ops mirror the Claude Code tool roster exactly so the capability canon
 * reads the same across channels. Spec:
 * BGOS/docs/superpowers/specs/2026-08-03-hermes-boards-marker-design.md
 */
import { randomBytes } from "node:crypto";

/** Same delimiter family as the other agent emitted markers. */
export const BOARDS_BLOCK_RE = /\[\[BGOS_BOARDS\]\]([\s\S]*?)\[\[\/BGOS_BOARDS\]\]/gi;

/**
 * Fenced code protection, mirrors the Hermes MEDIA: parser discipline: a
 * documented example inside ``` or ~~~ must render, not fire a real call.
 */
const CODE_FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/;

/**
 * The fixed first line of every result turn. The canon tells the agent that
 * a turn starting with this is the adapter answering its own requests, not
 * the user speaking. Byte identical to Hermes.
 */
export const BOARDS_RESULT_HEADER = "[BGOS boards result]";

/**
 * The provenance paragraph under the header. One place so the orchestrator
 * and the tests never drift on wording. Byte identical to Hermes.
 */
export const BOARDS_RESULT_PREAMBLE =
  "This is a system message from the BGOS adapter, not the user. It answers " +
  "the [[BGOS_BOARDS]] requests in your previous reply. Do not thank the " +
  "user for it. Continue the task; anything you want the user to see must " +
  "be a normal reply.";

/**
 * One reply carries at most this many board calls. More almost certainly
 * means a runaway generation; the excess blocks are stripped and answered
 * with an error section rather than executed.
 */
export const BOARDS_MAX_BLOCKS = 5;

/**
 * Consecutive board result turns per chat before the orchestrator refuses
 * further calls until a real inbound message arrives. Chained queries are
 * intended (a result turn may contain new blocks); an unbounded ping pong
 * is not. Matches Hermes BOARDS_LOOP_GUARD_LIMIT.
 */
export const BOARDS_LOOP_GUARD_LIMIT = 6;

/** The op roster, mirroring the 12 Claude Code boards_* tools name for name. */
export const BOARDS_OPS: readonly string[] = Object.freeze([
  "list",
  "describe",
  "create",
  "update_schema",
  "query",
  "get_row",
  "insert",
  "update",
  "attach",
  "search",
  "changes",
  "grant",
]);

const BOARDS_OPS_SET = new Set(BOARDS_OPS);

/**
 * Required payload fields per op, checked at parse time so a bad block never
 * reaches the REST lane and 404s confusingly. `op` itself is implicit.
 */
const REQUIRED_FIELDS: Record<string, readonly string[]> = {
  list: [],
  describe: ["board"],
  create: ["name"],
  update_schema: ["board", "action"],
  query: ["board"],
  get_row: ["board", "row"],
  insert: ["board", "cells"],
  update: ["board", "row", "cells"],
  attach: ["board", "row", "path"],
  search: ["board", "query"],
  changes: ["board"],
  grant: ["board", "assistantId", "role"],
};

/**
 * Ops whose endpoint accepts the ?format= knob (the read family). Writes
 * have no format and get params=null.
 */
const FORMAT_OPS = new Set([
  "list",
  "describe",
  "query",
  "get_row",
  "search",
  "changes",
]);

/** update_schema fans out to three REST shapes on `action`. */
const SCHEMA_ACTIONS: Record<string, string> = {
  add_field: "POST",
  update_field: "PATCH",
  delete_field: "DELETE",
};

/**
 * Body keys forwarded per op (everything else in the payload is dropped, the
 * transport keys op/reqId/board/row/format never belong in a request body).
 */
const BODY_KEYS: Record<string, readonly string[]> = {
  create: ["name", "description", "fields"],
  query: [
    "conditions",
    "conjunction",
    "sorts",
    "search",
    "limit",
    "cursor",
    "clientToday",
  ],
  insert: ["cells"],
  update: ["cells"],
  search: ["query", "limit"],
  grant: ["assistantId", "role"],
};

/**
 * One well formed board call the agent asked for. `args` is the parsed JSON
 * payload minus op/reqId: `planRequest` picks what it needs.
 */
export interface BoardsRequest {
  reqId: string;
  op: string;
  args: Record<string, unknown>;
}

/**
 * One block that could not become a request. Stripped from the visible text
 * like a good block, and answered with an error section so the agent learns
 * what was wrong instead of waiting forever.
 */
export interface BoardsParseError {
  reqId: string;
  raw: string;
  message: string;
}

/**
 * The exact REST call for a request. `path` is RELATIVE to the boards root
 * (`/api/v1/integrations/assistants/:id/boards`); the api client owns the
 * prefix. `kind` is "rest" for the generic lane or "attach" for the file
 * upload flow the orchestrator executes itself.
 */
export interface RestPlan {
  method: string;
  path: string;
  json: Record<string, unknown> | null;
  params: Record<string, string> | null;
  kind: "rest" | "attach";
}

/**
 * One executed (or refused) call, ready to render. `body` is whatever the
 * backend answered, VERBATIM, or a locally minted {error, message} object
 * for orchestrator side failures.
 */
export interface BoardsCallResult {
  reqId: string;
  op: string;
  ok: boolean;
  status: number;
  body: unknown;
}

function mintReqId(): string {
  return `b-${randomBytes(4).toString("hex")}`;
}

function grammarReminder(): string {
  return (
    "Expected one JSON object per block: " +
    '[[BGOS_BOARDS]]{"op":"query","board":"<id or exact name>",' +
    '"reqId":"q1"}[[/BGOS_BOARDS]] with op one of: ' +
    [...BOARDS_OPS].sort().join(", ") +
    "."
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

/** Parse the inside of one block into a request or an error. Pure. */
function parseOneBlock(raw: string): BoardsRequest | BoardsParseError {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return {
      reqId: mintReqId(),
      raw,
      message: "invalid JSON. " + grammarReminder(),
    };
  }
  if (!isPlainObject(payload)) {
    return {
      reqId: mintReqId(),
      raw,
      message: "payload must be a JSON object. " + grammarReminder(),
    };
  }
  const rawReqId = payload.reqId;
  const reqId =
    rawReqId !== undefined && rawReqId !== null ? String(rawReqId) : mintReqId();
  const op = payload.op;
  if (typeof op !== "string" || !BOARDS_OPS_SET.has(op)) {
    return {
      reqId,
      raw,
      message: `unknown op ${JSON.stringify(op)}. ` + grammarReminder(),
    };
  }
  const missing = (REQUIRED_FIELDS[op] ?? []).filter((field) => {
    const v = payload[field];
    return v === undefined || v === null || v === "";
  });
  if (op === "update_schema") {
    const action = payload.action;
    if (
      action !== undefined &&
      action !== null &&
      // Own-property check: `"toString" in SCHEMA_ACTIONS` is true via the
      // prototype chain and would leak a non-action into planRequest.
      !(typeof action === "string" && Object.hasOwn(SCHEMA_ACTIONS, action))
    ) {
      return {
        reqId,
        raw,
        message:
          `unknown update_schema action ${JSON.stringify(action)}; ` +
          "expected one of " +
          Object.keys(SCHEMA_ACTIONS).sort().join(", ") +
          ".",
      };
    }
    if (
      (action === "update_field" || action === "delete_field") &&
      !payload.fieldKey
    ) {
      missing.push("fieldKey");
    }
    if (action === "add_field" || action === "update_field") {
      const field = payload.field;
      if (!field) {
        missing.push("field");
      } else if (!isPlainObject(field)) {
        // A non object here used to surface later as a misleading
        // transport_error from planRequest on the Hermes side; tell the
        // agent the real problem at parse time instead.
        return {
          reqId,
          raw,
          message:
            "field must be a JSON object like " +
            '{"label":"Owner","type":"text"}.',
        };
      }
    }
  }
  if (missing.length > 0) {
    return {
      reqId,
      raw,
      message:
        `op ${JSON.stringify(op)} is missing required field(s): ` +
        missing.join(", ") +
        ".",
    };
  }
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k !== "op" && k !== "reqId") args[k] = v;
  }
  return { reqId, op, args };
}

function isParseError(
  parsed: BoardsRequest | BoardsParseError,
): parsed is BoardsParseError {
  return (parsed as BoardsParseError).message !== undefined;
}

/**
 * Extract every `[[BGOS_BOARDS]]...[[/BGOS_BOARDS]]` block from agent text.
 *
 * Returns `{ cleanedText, requests, errors }`. Every matched block, well
 * formed or not, is removed from the visible text (blank line noise
 * collapsed); blocks inside code fences are documentation and stay put.
 * Blocks beyond BOARDS_MAX_BLOCKS become errors rather than calls.
 */
export function parseBoardsBlocks(content: string): {
  cleanedText: string;
  requests: BoardsRequest[];
  errors: BoardsParseError[];
} {
  if (!content || !content.toUpperCase().includes("BGOS_BOARDS")) {
    return { cleanedText: content, requests: [], errors: [] };
  }
  const segments = content.split(CODE_FENCE_RE);
  const requests: BoardsRequest[] = [];
  const errors: BoardsParseError[] = [];
  let matchedAny = false;
  for (let idx = 0; idx < segments.length; idx += 2) {
    const seg = segments[idx]!;
    if (!seg.toUpperCase().includes("BGOS_BOARDS")) continue;
    for (const m of seg.matchAll(BOARDS_BLOCK_RE)) {
      matchedAny = true;
      const raw = (m[1] ?? "").trim();
      const parsed = parseOneBlock(raw);
      if (!isParseError(parsed)) {
        if (requests.length < BOARDS_MAX_BLOCKS) {
          requests.push(parsed);
        } else {
          errors.push({
            reqId: parsed.reqId,
            raw,
            message:
              `more than ${BOARDS_MAX_BLOCKS} board calls in one reply; ` +
              "this one was not executed. Batch fewer calls per turn.",
          });
        }
      } else {
        errors.push(parsed);
      }
    }
    segments[idx] = seg.replace(BOARDS_BLOCK_RE, "");
  }
  if (!matchedAny) {
    return { cleanedText: content, requests: [], errors: [] };
  }
  let cleanedText = segments.join("");
  cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanedText, requests, errors };
}

/** URL path segment for a board or row identifier. */
function seg(value: unknown): string {
  return encodeURIComponent(String(value));
}

function bodyFor(
  op: string,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const keys = BODY_KEYS[op] ?? [];
  const body: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in args && args[k] !== null && args[k] !== undefined) {
      body[k] = args[k];
    }
  }
  return Object.keys(body).length > 0 ? body : null;
}

function paramsFor(
  op: string,
  args: Record<string, unknown>,
): Record<string, string> | null {
  if (!FORMAT_OPS.has(op)) return null;
  const params: Record<string, string> = {
    format: args.format === "json" ? "json" : "markdown",
  };
  if (op === "changes" && args.since !== null && args.since !== undefined) {
    params.since = String(args.since);
  }
  return params;
}

/**
 * Map one validated request to its REST call. Validation happened at parse
 * time, so every op reaching here is known and complete.
 */
export function planRequest(req: BoardsRequest): RestPlan {
  const { op, args } = req;
  const board = seg(args.board ?? "");
  const rest = (
    method: string,
    path: string,
    json: Record<string, unknown> | null,
    params: Record<string, string> | null,
  ): RestPlan => ({ method, path, json, params, kind: "rest" });
  switch (op) {
    case "attach":
      return { method: "POST", path: "", json: null, params: null, kind: "attach" };
    case "list":
      return rest("GET", "", null, paramsFor(op, args));
    case "describe":
      return rest("GET", `/${board}/describe`, null, paramsFor(op, args));
    case "create":
      return rest("POST", "", bodyFor(op, args), null);
    case "query":
      return rest(
        "POST",
        `/${board}/rows/query`,
        bodyFor(op, args),
        paramsFor(op, args),
      );
    case "get_row":
      return rest(
        "GET",
        `/${board}/rows/${seg(args.row)}`,
        null,
        paramsFor(op, args),
      );
    case "insert":
      return rest("POST", `/${board}/rows`, bodyFor(op, args), null);
    case "update":
      return rest(
        "PATCH",
        `/${board}/rows/${seg(args.row)}`,
        bodyFor(op, args),
        null,
      );
    case "search":
      return rest("POST", `/${board}/search`, bodyFor(op, args), paramsFor(op, args));
    case "changes":
      return rest("GET", `/${board}/changes`, null, paramsFor(op, args));
    case "grant":
      return rest("POST", `/${board}/grants`, bodyFor(op, args), null);
    default: {
      // update_schema: three REST shapes on `action`.
      const action = String(args.action);
      const method = SCHEMA_ACTIONS[action]!;
      if (action === "add_field") {
        return rest(
          method,
          `/${board}/fields`,
          { ...(args.field as Record<string, unknown>) },
          null,
        );
      }
      const fieldKey = seg(args.fieldKey);
      if (action === "update_field") {
        return rest(
          method,
          `/${board}/fields/${fieldKey}`,
          { ...(args.field as Record<string, unknown>) },
          null,
        );
      }
      return rest(method, `/${board}/fields/${fieldKey}`, null, null);
    }
  }
}

/**
 * One result section's body text. A markdown answer renders bare (that is
 * what the format=markdown contract is FOR); everything else renders as
 * compact JSON, verbatim in content.
 */
function renderBody(body: unknown): string {
  if (
    isPlainObject(body) &&
    typeof (body as Record<string, unknown>).markdown === "string"
  ) {
    return (body as Record<string, unknown>).markdown as string;
  }
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body) ?? String(body);
  } catch {
    return String(body);
  }
}

/**
 * Render the synthetic system turn answering one reply's board calls.
 *
 * Section order equals request order; each section's header carries the
 * echoed reqId so the agent can correlate a result to the request that
 * asked for it. Bodies are verbatim (see renderBody).
 */
export function buildResultTurn(results: BoardsCallResult[]): string {
  const parts = [BOARDS_RESULT_HEADER, BOARDS_RESULT_PREAMBLE];
  for (const r of results) {
    const outcome = r.ok ? "ok" : `error status=${r.status}`;
    parts.push(`### reqId=${r.reqId} op=${r.op} ${outcome}`);
    parts.push(renderBody(r.body));
  }
  return parts.join("\n\n");
}
