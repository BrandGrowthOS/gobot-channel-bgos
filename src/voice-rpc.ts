/**
 * voice_rpc frame handler — the Gobot plugin side of BGOS's native in-app
 * WebRTC voice control plane.
 *
 * The BGOS backend pushes `voice_rpc {rpcId, op, assistantId, agentRoute,
 * chatId, payload}` frames into the `pairing:<id>` room this plugin's
 * socket already joined (Gobot is a pairing-managed channel, same lane as
 * OpenClaw). We ACK immediately (suppresses the backend's 1.5 s
 * retry-emit), run the op, and POST the outcome back with our
 * X-BGOS-Pairing header:
 *
 *   POST /api/v1/integrations/voice-rpc/:rpcId/result
 *     {ok:true, payload} | {ok:false, error:{code, message}}
 *
 * Ops:
 *   mint    → POST https://api.openai.com/v1/realtime/client_secrets
 *             directly (key from BGOS_OPENAI_API_KEY / OPENAI_API_KEY on
 *             the Gobot host — the Hermes-broker blueprint, spec §6.2, the
 *             same pattern the Claude Code plugin v0.14.0 ships). We own
 *             the mint, so the agent persona + recent chat context are
 *             baked into the session `instructions` → contextInjected:true
 *             (the app then skips client-side injection). 8 s inner cap,
 *             under the backend's 10 s mint deadline so our descriptive
 *             error always beats the generic timeout. The session bakes
 *             EXACTLY the gobot_agent_consult tool — the app only registers
 *             its client-side dispatch/roundtable tools when the mint
 *             returned ≥1 baked tool (verified frontend gotcha).
 *   consult → run a REAL turn on the Gobot brain through the fork's
 *             registered dispatch function, with a capture ReplyHandle
 *             that resolves on the brain's first sendText instead of
 *             posting to the chat. 38 s inner cap < the backend's 45 s.
 *   dispatch accepts first because the backend waits only 10 s for that
 *             response. The same brain turn can then run for up to 10 min.
 *             This handler stays pending so update drain tracks the work,
 *             while the outcome is posted on the voice task result route.
 *
 * Deadline discipline (ported from openclaw-channel-bgos/voice-rpc-handler):
 * the daemon's inner cap must stay UNDER the backend's, because the backend
 * drops results that arrive after its own timeout — a descriptive error
 * that arrives in time always beats a better answer that arrives late.
 *
 * G2 lesson (silent drops): ops are whitelisted in normalizeVoiceRpc and
 * every WELL-FORMED frame gets an explicit outcome — an op we don't serve
 * is answered with a descriptive error, never silence.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import type {
  DispatchArgs,
  DispatchFn,
  ReplyHandle,
} from "./inbound-handler.js";

export type VoiceRpcOp = "mint" | "consult" | "dispatch";

export interface VoiceRpcFrame {
  rpcId: string;
  op: VoiceRpcOp;
  assistantId: string | number;
  agentRoute: string;
  chatId: string | number | null;
  payload: Record<string, unknown>;
}

export interface VoiceRpcResultBody {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
}

/**
 * Validate a voice_rpc control frame. Backend emits camelCase:
 * {rpcId, op, assistantId, agentRoute, chatId, payload}. Ops are
 * WHITELISTED — anything else is dropped here (the backend's own timeout
 * surfaces the failure to the app, so silence for a malformed frame is
 * safe; a well-formed frame with an op we don't serve gets a descriptive
 * error in VoiceRpcHandler.handle instead). Port of the OpenClaw
 * bgos-ws.ts normalizer.
 */
export function normalizeVoiceRpc(raw: unknown): VoiceRpcFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rpcId = typeof r.rpcId === "string" ? r.rpcId : "";
  const op =
    r.op === "mint" || r.op === "consult" || r.op === "dispatch"
      ? r.op
      : null;
  if (!rpcId || !op) return null;
  return {
    rpcId,
    op,
    assistantId:
      typeof r.assistantId === "number" || typeof r.assistantId === "string"
        ? r.assistantId
        : "",
    agentRoute: typeof r.agentRoute === "string" ? r.agentRoute : "",
    chatId:
      typeof r.chatId === "number" || typeof r.chatId === "string"
        ? r.chatId
        : null,
    payload:
      r.payload && typeof r.payload === "object"
        ? (r.payload as Record<string, unknown>)
        : {},
  };
}

/** The SDP-exchange endpoint for a direct-OpenAI mint (wire contract). */
export const OFFER_URL = "https://api.openai.com/v1/realtime/calls";
export const CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
/** Must not collide with the app's client-registered tool names
 *  (agent_dispatch / get_task_status / check_agent_status / roundtable_*):
 *  the app's tool router relays every OTHER name to the consult endpoint. */
export const CONSULT_TOOL_NAME = "gobot_agent_consult";

/** Voice (realtime call) configuration. All values default from env so a
 *  host only needs to export an OpenAI key to enable calls. */
export interface VoiceConfig {
  /** OpenAI API key with Realtime access; '' = voice not configured. */
  openaiApiKey: string;
  model: string;
  voice: string;
  /** Optional extra persona text baked into the mint instructions. */
  persona: string;
  /** Confirm gate belt (Iris G5): reject dispatch frames lacking
   *  confirmed:true. Default off; the backend-side gate is the primary
   *  enforcement and now sends confirmed:true on every forwarded dispatch. */
  requireConfirmedDispatch?: boolean;
}

/** Same env names as the Claude Code plugin (cross-plugin parity):
 *  BGOS_OPENAI_API_KEY (falls back to OPENAI_API_KEY), BGOS_VOICE_MODEL,
 *  BGOS_VOICE_VOICE, BGOS_VOICE_PERSONA. */
export function loadVoiceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): VoiceConfig {
  return {
    openaiApiKey: env.BGOS_OPENAI_API_KEY || env.OPENAI_API_KEY || "",
    model: env.BGOS_VOICE_MODEL || "gpt-realtime-2",
    voice: env.BGOS_VOICE_VOICE || "marin",
    persona: env.BGOS_VOICE_PERSONA || "",
    requireConfirmedDispatch: env.BGOS_REQUIRE_CONFIRMED_DISPATCH === "true",
  };
}

/**
 * Per-assistant voice settings from the app (BGOS assistant voice menu),
 * riding the mint frame as payload.voiceConfig. Everything optional — the
 * host env config (BGOS_VOICE_VOICE / BGOS_VOICE_PERSONA) is the fallback
 * ONLY. Bounds mirror the backend coercion (services/voice-settings.ts) and
 * OpenAI's GA limits: speed 0.25–1.5 (session.audio.output.speed).
 */
export interface MintVoiceConfig {
  voice?: string;
  speed?: number;
  instructions?: string;
  /** Confirm gate (Iris G5): the backend sets this when the assistant's
   *  owner enabled ask-before-dispatch; the mint instructions then carry
   *  the propose-first contract. */
  requireDispatchConfirm?: true;
}

export const VOICE_SPEED_MIN = 0.25;
export const VOICE_SPEED_MAX = 1.5;
export const VOICE_INSTRUCTIONS_MAX = 2000;
const VOICE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** ONE shared total-instructions budget (Iris G4): persona + recent context +
 *  the owner memory head fit in ~14k chars. When over, memory is trimmed
 *  FIRST (then recent context); the fixed voice contract is never trimmed. The
 *  aggregate trim only applies when a memory head is present, so a memory-less
 *  agent mints byte-identically to the pre-feature path. */
export const AGGREGATE_INSTRUCTIONS_BUDGET = 14_000;
/** Per-source cap on the owner memory head before the aggregate trim. */
export const VOICE_MEMORY_MAX = 8_000;

/** Gobot home memory files read into the voice memory head (USER.md +
 *  MEMORY.md), resolved from GOBOT_HOME or ~/.gobot. */
const VOICE_MEMORY_CANDIDATES = ["USER.md", "MEMORY.md"];

/** Resolve the Gobot home dir (mirrors the adapter's resolution) to an
 *  ABSOLUTE path so candidate joins never double-prefix a relative home. */
function gobotHome(env: Record<string, string | undefined>): string {
  const fromEnv = (env.GOBOT_HOME || "").trim();
  if (fromEnv) {
    const expanded = fromEnv.startsWith("~")
      ? join(homedir(), fromEnv.slice(1))
      : fromEnv;
    return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
  }
  return join(homedir(), ".gobot");
}

/** Keep the first `n` UTF-16 units, dropping a trailing lone high surrogate. */
function sliceHead(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = s.slice(0, n);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Keep the LAST `n` UTF-16 units (most recent text), dropping a leading lone
 *  low surrogate. */
function sliceTail(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = s.slice(s.length - n);
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  return out;
}

/**
 * Owner memory head (Iris G4): read the Gobot home USER.md + MEMORY.md (or an
 * explicit BGOS_VOICE_MEMORY_FILE) into a single capped string. Owner-only by
 * construction (the backend refuses non-owner mints). Best-effort: a missing
 * file contributes nothing, so a home with no memory is byte-identical to the
 * pre-feature mint. Set BGOS_VOICE_MEMORY=off to disable. Reader injectable
 * for tests.
 */
export function loadVoiceMemory(
  opts: {
    env?: Record<string, string | undefined>;
    readFile?: (path: string) => string | null;
  } = {},
): string {
  const env = opts.env ?? process.env;
  if ((env.BGOS_VOICE_MEMORY ?? "").trim().toLowerCase() === "off") return "";
  const read =
    opts.readFile ??
    ((p: string) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    });
  const explicit = (env.BGOS_VOICE_MEMORY_FILE ?? "").trim();
  const home = gobotHome(env);
  // Explicit path is used verbatim; otherwise resolve each bare candidate
  // against the absolute home exactly once (no double-prefix).
  const paths = explicit
    ? [isAbsolute(explicit) ? explicit : join(home, explicit)]
    : VOICE_MEMORY_CANDIDATES.map((f) => join(home, f));
  const chunks: string[] = [];
  for (const path of paths) {
    const body = read(path);
    if (body && body.trim()) chunks.push(body.trim());
    if (chunks.join("\n\n").length >= VOICE_MEMORY_MAX) break;
  }
  return chunks.join("\n\n").slice(0, VOICE_MEMORY_MAX);
}

/**
 * Sanitize payload.voiceConfig from the wire. Defensive twin of the
 * backend's buildMintVoiceConfig — the backend already coerces, but the
 * daemon must never trust the wire (junk voice → dropped, out-of-range
 * speed → clamped, oversized instructions → capped). Returns {} when
 * nothing usable is present so callers can spread it safely.
 */
export function normalizeVoiceConfig(raw: unknown): MintVoiceConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: MintVoiceConfig = {};
  if (typeof r.voice === "string" && VOICE_ID_RE.test(r.voice.trim())) {
    out.voice = r.voice.trim().toLowerCase();
  }
  const speed = typeof r.speed === "string" ? Number(r.speed) : r.speed;
  if (typeof speed === "number" && Number.isFinite(speed)) {
    out.speed =
      Math.round(
        Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, speed)) * 100,
      ) / 100;
  }
  if (typeof r.instructions === "string" && r.instructions.trim()) {
    out.instructions = r.instructions.trim().slice(0, VOICE_INSTRUCTIONS_MAX);
  }
  // Coerce defensively (never trust the wire): boolean true or string 'true'.
  if (
    r.requireDispatchConfirm === true ||
    r.requireDispatchConfirm === "true"
  ) {
    out.requireDispatchConfirm = true;
  }
  return out;
}

export interface VoiceRpcTiming {
  /** Whole-mint wall clock (the OpenAI call). < backend 10 s. */
  mintTimeoutMs: number;
  /** Whole-consult wall clock (brain turn incl. dispatch). < backend 45 s. */
  consultTimeoutMs: number;
  /** Wall-clock cap for an accepted dispatch run. The voice call does not
   *  wait for the work, but the adapter tracks it for safe update drain. */
  dispatchTimeoutMs: number;
  /** Grace for a reply text that lands just after the brain turn's promise
   *  resolves (some forks send the final text right at turn end). */
  noReplyGraceMs: number;
  /** Delay before retrying a failed voice-task result POST. */
  resultRetryDelayMs: number;
}

export const DEFAULT_TIMING: VoiceRpcTiming = {
  mintTimeoutMs: 8_000,
  consultTimeoutMs: 38_000,
  dispatchTimeoutMs: 600_000,
  noReplyGraceMs: 1_500,
  resultRetryDelayMs: 3_000,
};

/** The three REST replies the handler needs. Matches BgosApi's methods —
 *  declared structurally here so this module has no import cycle. */
export interface VoiceRpcApi {
  postVoiceRpcAck(rpcId: string): Promise<unknown>;
  postVoiceRpcResult(rpcId: string, body: VoiceRpcResultBody): Promise<unknown>;
  postVoiceTaskResult(
    taskId: string,
    body: VoiceRpcResultBody,
  ): Promise<unknown>;
}

export interface VoiceRpcDeps {
  api: VoiceRpcApi;
  config: VoiceConfig;
  /** The fork-registered brain dispatch. Null until setDispatch() ran. */
  getDispatch(): DispatchFn | null;
  /** assistant id → bound agent_route (adapter's whoami map). */
  getRouteForAssistant(assistantId: number): string | null;
  /** Best-effort assistant display name for the voice persona. */
  getAssistantName(assistantId: number): string | null;
  /** The pairing's BGOS user id (from whoami). */
  getUserId(): string;
  /** Fork-supplied per-agent system prompt (persona). */
  getSystemPrompt?(agentRoute: string): string;
  log?(msg: string): void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timing?: Partial<VoiceRpcTiming>;
}

class VoiceRpcError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Clamp a step's timeout so it can never overshoot the op deadline
 *  (inner < outer discipline; see the OpenClaw reference). */
function capToDeadline(timeoutMs: number, deadline: number): number {
  return Math.max(1, Math.min(timeoutMs, deadline - Date.now()));
}

/** The backend stores `new Date(Number(expiresAt) * 1000)` — the wire unit
 *  is epoch SECONDS. OpenAI's client_secrets returns seconds today, but
 *  normalize defensively (the OpenClaw lesson: providers have emitted both
 *  units historically). */
export function normalizeExpiresAtSeconds(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  // ~2286-11-20 in epoch seconds; anything bigger is epoch milliseconds.
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

/** Continuation brief (Iris 514): consult/dispatch turns land in the agent's
 *  OWN session, which may already hold earlier voice-run results. Telling the
 *  brain so makes repeat asks dramatically faster (reuse, don't redo). */
const CONTINUATION_BRIEF =
  "This session may contain your earlier runs of similar work from this " +
  "call. Reuse those results where they still apply and re-check only " +
  "what changed instead of starting over.";

/** Realtime session instructions: persona + the dumb-mouth contract. The
 *  realtime model is only the VOICE; the Gobot brain (memory, tools, chat
 *  context) is reachable via the baked consult tool and the app-registered
 *  agent_dispatch. Exported for unit tests. */
export function buildMintInstructions(args: {
  agentName: string | null;
  persona: string;
  recentContext: string;
  /** Confirm gate (Iris G5): bake the propose-first contract. */
  requireDispatchConfirm?: boolean;
  /** Owner memory head (Iris G4): the owner's profile / active projects /
   *  shorthand. Owner-only by construction. */
  memory?: string;
}): string {
  const name = args.agentName?.trim() || "the agent";
  const parts: string[] = [];
  parts.push(`You are ${name}, speaking with your user on a live voice call.`);
  if (args.persona.trim()) parts.push(args.persona.trim());
  parts.push(
    "Personality: warm, capable, concise. Answer in one to three short " +
      "sentences unless asked for more. Never mention being an AI model or " +
      `a "realtime voice"; you ARE ${name}.`,
  );
  parts.push(
    "Welcome-back ceremony: open your FIRST greeting this call with a warm, " +
      "brief welcome (greet the user by name if the recent conversation " +
      "below reveals it), never a robotic identical hello. If the recent " +
      "conversation shows you are resuming an earlier thread, skip the " +
      "greeting ceremony and pick up naturally where you left off. Do not " +
      "invent status you do not actually have.",
  );
  parts.push(
    "You are the VOICE of the agent, not its brain. The real agent — a " +
      "Gobot agent with its own memory, tools, and chat context — is " +
      "reachable through your tools:\n" +
      "- Handle greetings, chit-chat, and anything answerable from this " +
      "conversation DIRECTLY. No tools for small talk.\n" +
      `- Use ${CONSULT_TOOL_NAME} for quick questions the real agent can ` +
      "answer in a sentence or two (it knows the chat history and its own " +
      "memory). Verbally acknowledge before consulting — it takes a few " +
      "seconds. If a consult fails or times out, say the agent is still " +
      "working on it and will follow up in the chat — never leave silence.\n" +
      "- For anything multi-step, anything needing real work (files, " +
      "research, messages), or anything that changes state, PREFER " +
      "agent_dispatch: verbally acknowledge what you are kicking off, " +
      "dispatch it, and the result is announced when ready.\n" +
      "- Speak results naturally; keep technical detail light unless asked.",
  );
  parts.push(
    "Truthfulness contract: NEVER invent, guess, or embellish the results " +
      "of the agent's work. Only report an outcome you actually received " +
      "from a tool result or an announcement on this call. If you do not " +
      "have the result yet, say the work is still in progress and check " +
      "its status before speaking about it.",
  );
  parts.push(
    "When you consult or dispatch, phrase the brief as the user's intent " +
      "and desired outcome, in their own words. Never include mechanics " +
      "from earlier runs (tool names, file paths, step-by-step how-to); " +
      "the agent owns its tools and stale mechanics mislead it.",
  );
  if (args.requireDispatchConfirm) {
    parts.push(
      "Dispatch confirmation is ON for this agent: agent_dispatch STAGES a " +
        "proposal instead of starting work. Read the staged brief back to " +
        "the user in one short sentence and ask for their go-ahead. Only " +
        "after the user clearly confirms on their next turn, call " +
        "confirm_dispatch with the task id from the ack. If they decline, " +
        "call confirm_dispatch with approve:false. Never invent a " +
        "confirmation the user did not give.",
    );
  }
  const core = parts.join("\n\n");
  const memLabel = "Owner memory (profile, active projects, shorthand):\n";
  const ctxLabel = "Recent conversation with your user (for continuity):\n";
  const SEP = "\n\n";
  let memory = sliceHead((args.memory ?? "").trim(), VOICE_MEMORY_MAX);
  // recentContext is built most-recent-LAST, so keep its TAIL when trimming.
  let context = sliceTail(args.recentContext.trim(), 20_000);

  // Safe default: with NO memory head, leave recent context at its pre-feature
  // 20k slice and skip the aggregate trim, so a memory-less agent mints
  // byte-identically to before this feature.
  if (memory) {
    const coreCost = core.length;
    const ctxBlockCost = context
      ? SEP.length + ctxLabel.length + context.length
      : 0;
    if (coreCost + ctxBlockCost > AGGREGATE_INSTRUCTIONS_BUDGET) {
      memory = "";
      if (context) {
        const room =
          AGGREGATE_INSTRUCTIONS_BUDGET - coreCost - SEP.length - ctxLabel.length;
        context = room > 0 ? sliceTail(context, room) : "";
      }
    } else {
      const memRoom =
        AGGREGATE_INSTRUCTIONS_BUDGET -
        coreCost -
        ctxBlockCost -
        SEP.length -
        memLabel.length;
      memory = memRoom > 0 ? sliceHead(memory, memRoom) : "";
    }
  }
  const out = [core];
  if (memory) out.push(memLabel + memory);
  if (context) out.push(ctxLabel + context);
  return out.join(SEP);
}

/** The consult tool definition baked into the realtime session at mint.
 *  Mirrors the backend's VoiceToolCallDto args shape. */
export function buildConsultToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    name: CONSULT_TOOL_NAME,
    description:
      "Ask the agent's real brain (the Gobot agent, which knows the chat " +
      "history and its own memory) a QUICK question it can answer in a " +
      "sentence or two. Takes several seconds; verbally acknowledge first. " +
      "For real/multi-step work use agent_dispatch instead.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, self-contained and specific.",
        },
        context: {
          type: "string",
          description: "Optional call context that helps answer.",
        },
        responseStyle: {
          type: "string",
          description: 'Optional style hint, e.g. "one sentence".',
        },
      },
      required: ["question"],
    },
  };
}

/** The user-turn text a consult puts in front of the Gobot brain.
 *  Exported for tests. */
export function buildConsultTurnText(args: {
  question: string;
  context: string;
  responseStyle: string;
  budgetSeconds: number;
}): string {
  return (
    `[voice_consult] Your user is asking you LIVE on a voice call:\n\n` +
    args.question +
    (args.context ? `\n\nCall context: ${args.context}` : "") +
    (args.responseStyle ? `\n\nAnswer style: ${args.responseStyle}` : "") +
    `\n\n${CONTINUATION_BRIEF}` +
    `\n\nYou have ~${args.budgetSeconds} seconds. Reply IMMEDIATELY with a ` +
    `short, SPEAKABLE answer (1-3 sentences of plain text — no markdown, ` +
    `no MEDIA: lines, no buttons). Do NOT run tools unless the question ` +
    `strictly requires it. If you cannot answer fully in time, say what ` +
    `you know — you can follow up in the chat.`
  );
}

/** The user-turn text a detached dispatch puts in front of the Gobot
 *  brain. Exported for tests. */
export function buildDispatchTurnText(args: {
  taskId: string;
  question: string;
  context: string;
}): string {
  return (
    `[voice_dispatch] While on a live voice call, your user asked you to ` +
    `do this task (task ${args.taskId}):\n\n` +
    args.question +
    (args.context ? `\n\nContext: ${args.context}` : "") +
    `\n\n${CONTINUATION_BRIEF}` +
    `\n\nDo the work now. Your FINAL reply must be a short, speakable ` +
    `summary of the outcome (1-6 sentences of plain text — no markdown, ` +
    `no MEDIA: lines); it is announced aloud on the call and shown as the ` +
    `task result.`
  );
}

/** Appended to the fork's system prompt for voice-originated brain turns —
 *  the reply is spoken/announced, so BGOS chat affordances (markdown,
 *  MEDIA: lines, buttons) must stay out of it. */
export const VOICE_TURN_SYSTEM_NOTE =
  "\n\nThis turn comes from a LIVE VOICE CALL, not the chat. Reply with " +
  "plain speakable text only: no markdown, no MEDIA: lines, no buttons, " +
  "no approval requests.";

/**
 * A ReplyHandle that CAPTURES the brain's reply text instead of posting it
 * to the BGOS chat — voice consults/dispatches surface their result through
 * the voice control plane (spoken aloud / Work Stream card), not as chat
 * bubbles. Text-bearing sends (text/buttons/ask/approval prompts, media
 * captions) are captured; typing, tool-progress and file uploads are
 * no-ops.
 */
export function makeCaptureReplyHandle(
  onText: (text: string) => void,
): ReplyHandle {
  const captureText = async (text: string): Promise<{ id: number }> => {
    if (typeof text === "string" && text.trim()) onText(text);
    return { id: 0 };
  };
  const captureCaption = async (
    _filePath: string,
    caption?: string,
  ): Promise<{ id: number }> => {
    if (caption && caption.trim()) onText(caption);
    return { id: 0 };
  };
  return {
    origin: "bgos",
    sendText: (text) => captureText(text),
    sendButtons: (text) => captureText(text),
    sendApprovalRequest: (text) => captureText(text),
    sendAskUserInput: (prompt) => captureText(prompt),
    sendFile: captureCaption,
    sendImage: captureCaption,
    sendVideo: captureCaption,
    sendTyping: async () => {},
    uploadFile: async (filePath, opts) => ({
      fileName: opts?.fileName ?? filePath.split("/").pop() ?? "file",
      fileMimeType: opts?.mimeType ?? "application/octet-stream",
      size: 0,
    }),
    sendToolStart: async () => {},
    finalizeTurn: async () => {},
  };
}

export class VoiceRpcHandler {
  private readonly deps: VoiceRpcDeps;
  private readonly timing: VoiceRpcTiming;
  /** Duplicate-frame guard: the backend re-emits once when its ACK doesn't
   *  land within 1.5 s; a consult dispatched twice would run two turns. */
  private readonly inFlight = new Set<string>();
  /** Dedupe accepted dispatch runs by taskId (a re-emitted frame carries a
   *  new rpcId only on backend restart; the taskId is the durable key). */
  private readonly dispatchInFlight = new Set<string>();
  /** One live consult per assistant — a second one gets a descriptive
   *  AGENT_BUSY instead of stacking turns on the brain. */
  private readonly consultBusy = new Set<string>();

  constructor(deps: VoiceRpcDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  async handle(frame: VoiceRpcFrame): Promise<void> {
    if (!frame?.rpcId) return;
    if (this.inFlight.has(frame.rpcId)) {
      this.log(`voice_rpc duplicate frame ignored (rpc=${frame.rpcId})`);
      return;
    }
    this.inFlight.add(frame.rpcId);
    try {
      // ACK is best-effort: a failed ACK only costs one retry-emit (which
      // the inFlight guard absorbs); it must not abort the op itself.
      try {
        await this.deps.api.postVoiceRpcAck(frame.rpcId);
      } catch (err) {
        this.log(
          `voice_rpc ack failed (non-fatal, rpc=${frame.rpcId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      let payload: Record<string, unknown>;
      if (frame.op === "mint") {
        payload = await this.mint(frame);
      } else if (frame.op === "consult") {
        payload = await this.consult(frame);
      } else if (frame.op === "dispatch") {
        // Accept-first (voice revamp G2): the backend only waits 10 s for
        // this result. The accept POST is STRICT (not the swallowing
        // wrapper) — if it fails, the backend flips the task to error and
        // tells the user, so starting the run anyway would execute real
        // side effects behind a visible failure.
        const { taskId } = frame.payload as { taskId?: string | number };
        if (taskId === undefined || taskId === null || taskId === "") {
          throw new VoiceRpcError(
            "BAD_DISPATCH",
            "dispatch payload missing taskId",
          );
        }
        // Confirm gate belt (Iris G5): pre-accept, so the backend gets an
        // explicit descriptive rejection on the rpc result route. Coerce
        // defensively (boolean true or string 'true').
        if (this.deps.config.requireConfirmedDispatch) {
          const confirmed = (frame.payload as Record<string, unknown>)
            .confirmed;
          if (confirmed !== true && confirmed !== "true") {
            throw new VoiceRpcError(
              "DISPATCH_UNCONFIRMED",
              `unconfirmed dispatch rejected (task=${String(taskId)}): ` +
                "BGOS_REQUIRE_CONFIRMED_DISPATCH is on and the payload " +
                "lacks confirmed:true",
            );
          }
        }
        await this.deps.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { accepted: true, taskId: String(taskId) },
        });
        // The accept response is already durable. Keep this handler pending
        // for the real run so the adapter update drain can track it.
        await this.runDispatch(frame, String(taskId));
        return;
      } else {
        // Whitelisted-but-unserved shapes get a LOUD error, never silence
        // (the G2 silent-drop lesson).
        throw new VoiceRpcError(
          "UNSUPPORTED_OP",
          `unsupported voice_rpc op: ${String((frame as { op?: unknown }).op)}`,
        );
      }
      await this.postResult(frame.rpcId, { ok: true, payload });
    } catch (err) {
      const code = err instanceof VoiceRpcError ? err.code : "PLUGIN_ERROR";
      await this.postResult(frame.rpcId, {
        ok: false,
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      this.inFlight.delete(frame.rpcId);
    }
  }

  // ── mint ─────────────────────────────────────────────────────────────

  private async mint(frame: VoiceRpcFrame): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.timing.mintTimeoutMs;
    const { config } = this.deps;
    // Per-user key (BGOS billing/security): the BGOS backend rides the CALLER's
    // own OpenAI key on the mint frame (payload.openaiApiKey) so the call
    // spends THEIR credits, never this host's owner key. Prefer it; the host
    // env key (config.openaiApiKey) is a fallback ONLY for a standalone Gobot
    // host not driven by the BGOS backend. The BGOS backend refuses a mint for
    // a user with no key of their own, so a BGOS-driven mint always arrives
    // with a user key here. The raw key stays server-side (it arrived over the
    // authed pairing WS room) and never reaches the app.
    const userOpenaiApiKey =
      typeof frame.payload?.openaiApiKey === "string"
        ? frame.payload.openaiApiKey.trim()
        : "";
    const openaiApiKey = userOpenaiApiKey || config.openaiApiKey;
    if (!openaiApiKey) {
      throw new VoiceRpcError(
        "VOICE_NOT_CONFIGURED",
        "voice is not configured: the caller has not set an OpenAI API key in " +
          "their Home of Agents settings, and this Gobot host has no " +
          "BGOS_OPENAI_API_KEY fallback",
      );
    }
    const assistantId = Number(frame.assistantId) || 0;
    const agentName = this.deps.getAssistantName(assistantId);
    const recentContext =
      typeof frame.payload?.recentContext === "string"
        ? frame.payload.recentContext
        : "";
    // Per-assistant voice settings from the app (v0.10.0): voice + speed +
    // persona instructions override the host env config; env vars are the
    // fallback ONLY when the app sent nothing.
    const voiceConfig = normalizeVoiceConfig(frame.payload?.voiceConfig);
    const voice = voiceConfig.voice ?? config.voice;
    const persona = voiceConfig.instructions ?? config.persona;
    const instructions = buildMintInstructions({
      agentName,
      persona,
      recentContext,
      requireDispatchConfirm: voiceConfig.requireDispatchConfirm === true,
      // Owner memory head (G4): read the Gobot home memory files. Owner-only
      // by construction (backend refuses non-owner mints).
      memory: loadVoiceMemory(),
    });
    const body = {
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: config.model,
        instructions,
        tools: [buildConsultToolDefinition()],
        audio: {
          // Input transcription is REQUIRED: the app builds the call
          // transcript (posted back into the chat) from realtime
          // transcription events. Server VAD gives natural turn-taking.
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "server_vad" },
          },
          output: {
            voice,
            // Only sent when the app configured it — omitting preserves the
            // exact pre-feature request shape (OpenAI default 1.0).
            ...(voiceConfig.speed != null ? { speed: voiceConfig.speed } : {}),
          },
        },
      },
    };
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const ac = new AbortController();
    const timer = setTimeout(
      () => ac.abort(),
      capToDeadline(this.timing.mintTimeoutMs, deadline),
    );
    let res: Response;
    try {
      res = await fetchImpl(CLIENT_SECRETS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      const aborted =
        (err as { name?: string })?.name === "AbortError" || ac.signal.aborted;
      throw new VoiceRpcError(
        "MINT_FAILED",
        aborted
          ? "OpenAI mint timed out"
          : `OpenAI mint failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VoiceRpcError(
        "MINT_FAILED",
        `OpenAI client_secrets ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      value?: unknown;
      expires_at?: unknown;
    };
    const clientSecret = typeof data?.value === "string" ? data.value : "";
    if (!clientSecret) {
      throw new VoiceRpcError(
        "MINT_FAILED",
        "OpenAI client_secrets returned no secret value",
      );
    }
    return {
      provider: "openai",
      transport: "webrtc",
      clientSecret,
      offerUrl: OFFER_URL,
      model: config.model,
      // Echo what was APPLIED (app settings win over env) — the app's
      // in-call gear shows this as the active voice.
      voice,
      ...(voiceConfig.speed != null ? { speed: voiceConfig.speed } : {}),
      expiresAt:
        normalizeExpiresAtSeconds(data?.expires_at) ??
        Math.floor(Date.now() / 1000) + 600,
      // Context + persona ride the session instructions above — the app
      // must NOT inject recentContext again client-side.
      contextInjected: true,
    };
  }

  // ── consult ──────────────────────────────────────────────────────────

  private async consult(
    frame: VoiceRpcFrame,
  ): Promise<Record<string, unknown>> {
    const { callId, name, args } = frame.payload as {
      callId?: string;
      name?: string;
      args?: Record<string, unknown>;
    };
    if (!callId || !name) {
      throw new VoiceRpcError(
        "BAD_CONSULT",
        "consult payload missing callId/name",
      );
    }
    const question =
      typeof args?.question === "string" ? args.question.trim() : "";
    if (!question) {
      throw new VoiceRpcError("BAD_CONSULT", "consult args missing question");
    }
    const context =
      typeof args?.context === "string" ? args.context.trim() : "";
    const responseStyle =
      typeof args?.responseStyle === "string" ? args.responseStyle.trim() : "";

    const busyKey = String(frame.assistantId);
    if (this.consultBusy.has(busyKey)) {
      throw new VoiceRpcError(
        "AGENT_BUSY",
        "The agent is already answering another live question — ask again " +
          "in a moment.",
      );
    }
    this.consultBusy.add(busyKey);
    try {
      const turnText = buildConsultTurnText({
        question,
        context,
        responseStyle,
        // Advertise a bit less than the real cap so the brain aims inside it.
        budgetSeconds: Math.max(
          5,
          Math.floor((this.timing.consultTimeoutMs - 8_000) / 1000),
        ),
      });
      const text = await this.runBrainTurn({
        frame,
        mode: "consult",
        turnText,
        timeoutMs: this.timing.consultTimeoutMs,
      });
      return { text };
    } finally {
      this.consultBusy.delete(busyKey);
    }
  }

  // Dispatch after the accept response.

  private async runDispatch(
    frame: VoiceRpcFrame,
    taskId: string,
  ): Promise<void> {
    if (this.dispatchInFlight.has(taskId)) {
      this.log(`dispatch duplicate ignored (task=${taskId})`);
      return;
    }
    this.dispatchInFlight.add(taskId);
    try {
      // Phase 1 — the run. Its failure is a genuine DISPATCH_FAILED.
      let text: string | null = null;
      let failCode = "DISPATCH_FAILED";
      let failMessage = "";
      try {
        const { args } = frame.payload as { args?: Record<string, unknown> };
        const question =
          typeof args?.question === "string" ? args.question.trim() : "";
        if (!question) {
          throw new VoiceRpcError(
            "BAD_DISPATCH",
            "dispatch args missing question",
          );
        }
        const context =
          typeof args?.context === "string" ? args.context.trim() : "";
        text = await this.runBrainTurn({
          frame,
          mode: "dispatch",
          turnText: buildDispatchTurnText({ taskId, question, context }),
          timeoutMs: this.timing.dispatchTimeoutMs,
        });
      } catch (err) {
        if (err instanceof VoiceRpcError) failCode = err.code;
        failMessage = err instanceof Error ? err.message : String(err);
      }
      // Phase 2 — the report. A failed POST must never masquerade as a
      // failed RUN (that would discard a genuine result forever, since the
      // backend row only flips once); retry once, then give up loudly and
      // let the backend's stale-running reaper close the row.
      const body: VoiceRpcResultBody =
        text !== null
          ? { ok: true, payload: { text } }
          : { ok: false, error: { code: failCode, message: failMessage } };
      try {
        await this.deps.api.postVoiceTaskResult(taskId, body);
      } catch {
        await sleep(this.timing.resultRetryDelayMs);
        try {
          await this.deps.api.postVoiceTaskResult(taskId, body);
        } catch (postErr) {
          this.log(
            `dispatch result post failed twice — giving up (task=${taskId}): ${
              postErr instanceof Error ? postErr.message : String(postErr)
            }`,
          );
          return;
        }
      }
      this.log(
        text !== null
          ? `dispatch completed (task=${taskId})`
          : `dispatch failed (task=${taskId}): ${failMessage}`,
      );
    } finally {
      this.dispatchInFlight.delete(taskId);
    }
  }

  // ── the brain turn ───────────────────────────────────────────────────

  /**
   * Run one REAL turn on the Gobot brain through the fork's registered
   * dispatch function, capturing reply text instead of posting it to the
   * chat.
   *
   * consult mode resolves on the FIRST captured text (latency wins — the
   * call is waiting); dispatch mode waits for the whole turn and returns
   * the LAST captured text (the final summary wins). Both fail with
   * descriptive errors on: no dispatch registered, no bound route, brain
   * throw, turn end without any text, or deadline.
   */
  private async runBrainTurn(opts: {
    frame: VoiceRpcFrame;
    mode: "consult" | "dispatch";
    turnText: string;
    timeoutMs: number;
  }): Promise<string> {
    const dispatch = this.deps.getDispatch();
    if (!dispatch) {
      throw new VoiceRpcError(
        "GOBOT_NOT_READY",
        "the Gobot brain has not registered its dispatch function yet — " +
          "the host may still be starting up",
      );
    }
    const assistantId = Number(opts.frame.assistantId) || 0;
    const route =
      (opts.frame.agentRoute || "").trim() ||
      this.deps.getRouteForAssistant(assistantId) ||
      "";
    if (!route) {
      throw new VoiceRpcError(
        "NO_AGENT_ROUTE",
        `no agent route bound for assistant ${assistantId} — re-bind the ` +
          "assistant on this pairing",
      );
    }
    const chatId = Number(opts.frame.chatId ?? 0) || 0;

    const captured: string[] = [];
    let settleFirst: ((text: string) => void) | null = null;
    const firstText = new Promise<string>((resolve) => {
      settleFirst = resolve;
    });
    const replyHandle = makeCaptureReplyHandle((text) => {
      captured.push(text);
      settleFirst?.(text);
      settleFirst = null;
    });

    const baseSystemPrompt = this.deps.getSystemPrompt?.(route) ?? "";
    const dispatchArgs: DispatchArgs = {
      origin: "bgos",
      agentRoute: route,
      assistantId,
      chatId,
      messageId: 0,
      userId: this.deps.getUserId(),
      text: opts.turnText,
      attachments: [],
      systemPrompt: baseSystemPrompt + VOICE_TURN_SYSTEM_NOTE,
      replyHandle,
      messageType: "standard",
    };

    type Outcome =
      | { kind: "text"; text: string }
      | { kind: "done" }
      | { kind: "err"; err: unknown }
      | { kind: "timeout" };

    // The race SUBSCRIBES to the run with a rejection handler, so a brain
    // throw after an early return (text/timeout won) never surfaces as an
    // unhandled rejection.
    const run: Promise<Outcome> = dispatch(dispatchArgs).then(
      () => ({ kind: "done" }) as const,
      (err: unknown) => ({ kind: "err", err }) as const,
    );
    const timeout: Promise<Outcome> = sleep(opts.timeoutMs).then(
      () => ({ kind: "timeout" }) as const,
    );
    const racers: Array<Promise<Outcome>> = [run, timeout];
    if (opts.mode === "consult") {
      racers.push(firstText.then((text) => ({ kind: "text", text }) as const));
    }

    const outcome = await Promise.race(racers);
    if (outcome.kind === "text") return outcome.text;
    if (outcome.kind === "err") {
      throw new VoiceRpcError(
        opts.mode === "consult" ? "CONSULT_FAILED" : "DISPATCH_FAILED",
        outcome.err instanceof Error
          ? outcome.err.message
          : String(outcome.err),
      );
    }
    if (outcome.kind === "timeout") {
      throw new VoiceRpcError(
        opts.mode === "consult" ? "CONSULT_TIMEOUT" : "DISPATCH_TIMEOUT",
        opts.mode === "consult"
          ? "The agent is still working on it — it will follow up in the chat."
          : "The task did not finish within the 10 minute window.",
      );
    }
    // Turn ended. Some forks send the final text a beat after the turn
    // promise resolves — give it a short grace before declaring NO_REPLY.
    if (captured.length === 0) {
      await Promise.race([firstText, sleep(this.timing.noReplyGraceMs)]);
    }
    if (captured.length > 0) {
      return captured[captured.length - 1]!;
    }
    throw new VoiceRpcError(
      "NO_REPLY",
      "The agent finished the turn without a spoken reply.",
    );
  }

  private async postResult(
    rpcId: string,
    body: VoiceRpcResultBody,
  ): Promise<void> {
    try {
      await this.deps.api.postVoiceRpcResult(rpcId, body);
    } catch (err) {
      // Nothing else we can do — the backend's own timeout surfaces the
      // failure to the app.
      this.log(
        `voice_rpc result post failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't hold the process open for a pending voice deadline.
    (t as { unref?: () => void }).unref?.();
  });
}
