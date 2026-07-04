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
 *   dispatch → accept-first (the backend only waits 10 s for the accept),
 *             then run the same brain turn DETACHED (10 min cap) and POST
 *             the outcome to /integrations/voice-tasks/:taskId/result
 *             (resilient: retry once, then give up loudly — the backend's
 *             stale-running reaper closes the row).
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
  };
}

export interface VoiceRpcTiming {
  /** Whole-mint wall clock (the OpenAI call). < backend 10 s. */
  mintTimeoutMs: number;
  /** Whole-consult wall clock (brain turn incl. dispatch). < backend 45 s. */
  consultTimeoutMs: number;
  /** Wall-clock cap for a detached dispatch run. Generous by design — the
   *  whole point is that the call is NOT waiting on it. */
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

/** Realtime session instructions: persona + the dumb-mouth contract. The
 *  realtime model is only the VOICE; the Gobot brain (memory, tools, chat
 *  context) is reachable via the baked consult tool and the app-registered
 *  agent_dispatch. Exported for unit tests. */
export function buildMintInstructions(args: {
  agentName: string | null;
  persona: string;
  recentContext: string;
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
  const ctx = args.recentContext.trim();
  if (ctx) {
    parts.push(
      "Recent conversation with your user (for continuity):\n" +
        ctx.slice(0, 20_000),
    );
  }
  return parts.join("\n\n");
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
  /** Dedupe detached dispatch runs by taskId (a re-emitted frame carries a
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
        await this.deps.api.postVoiceRpcResult(frame.rpcId, {
          ok: true,
          payload: { accepted: true, taskId: String(taskId) },
        });
        void this.runDispatch(frame, String(taskId));
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
    if (!config.openaiApiKey) {
      throw new VoiceRpcError(
        "VOICE_NOT_CONFIGURED",
        "voice is not configured on this Gobot host: set BGOS_OPENAI_API_KEY " +
          "(an OpenAI API key with Realtime access) in the Gobot daemon env " +
          "and restart it",
      );
    }
    const assistantId = Number(frame.assistantId) || 0;
    const agentName = this.deps.getAssistantName(assistantId);
    const recentContext =
      typeof frame.payload?.recentContext === "string"
        ? frame.payload.recentContext
        : "";
    const instructions = buildMintInstructions({
      agentName,
      persona: config.persona,
      recentContext,
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
          output: { voice: config.voice },
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
          Authorization: `Bearer ${config.openaiApiKey}`,
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
      voice: config.voice,
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

  // ── dispatch (detached) ──────────────────────────────────────────────

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
