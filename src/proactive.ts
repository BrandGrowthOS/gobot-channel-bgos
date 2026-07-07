/**
 * Proactive (no-origin) message helpers for the Gobot ↔ BGOS channel.
 *
 * Background:
 *   Gobot's cron jobs — `morning-briefing.ts`, `smart-checkin.ts`,
 *   scheduled-task reminders — historically only post to Telegram via
 *   `bot.api.sendMessage(...)`. Once a user pairs to BGOS, these
 *   messages should fan out to BGOS too (per `GOBOT_HOME_CHANNEL`).
 *
 *   This module gives the fork a single dependency-light helper to
 *   resolve the right BGOS target (assistant + chat) and post a message
 *   without spinning up the full WS + dispatch lifecycle. It's safe to
 *   call from a one-shot script that lives ~3 seconds and exits.
 *
 *   The fork's cron scripts:
 *     1. read `GOBOT_HOME_CHANNEL` via `resolveHomeChannel()`,
 *     2. always send to Telegram (existing path) when channel is
 *        `'telegram'` or `'both'`,
 *     3. additionally call `sendProactive(...)` from this module when
 *        channel is `'bgos'` or `'both'`.
 *
 *   Failures here NEVER abort the Telegram path — they're best-effort.
 */
import { BgosApi } from "./bgos-api.js";
import { sanitizeFromAgent } from "./agent-identity.js";
import { resolveHomeChannel, type HomeChannel } from "./home-channel.js";
import { readSecretsSafe } from "./load-config.js";
import type {
  FromAgentInput,
  MessageOption,
  PluginConfig,
} from "./types.js";

/** Outcome of a single `sendProactive` call. */
export interface ProactiveSendResult {
  /** Whether the BGOS leg actually fired (false when channel='telegram'). */
  attempted: boolean;
  /** Number of assistants we successfully posted to. */
  delivered: number;
  /** Per-assistant errors. Empty when everything succeeded. */
  errors: Array<{ assistantId: number; error: string }>;
  /** The home-channel mode that was resolved at call time. */
  channel: HomeChannel;
}

/** Inputs the fork passes per call. */
export interface ProactiveSendParams {
  /** The text to send. Markdown allowed (BGOS renders it). */
  text: string;
  /**
   * Optional inline buttons. Useful for "morning briefing → tap to drill
   * in" flows. ≤6 enforced by the backend.
   */
  options?: MessageOption[];
  /**
   * Optional inline-agent identity override. When supplied the message
   * renders as that agent (e.g. for a /board synthesis posted from a
   * cron). Most proactive paths leave this unset.
   */
  fromAgent?: FromAgentInput;
  /**
   * Restrict delivery to a subset of assistants. By default the helper
   * sends to EVERY assistant the pairing knows about (matches Gobot's
   * "broadcast to me" semantics). Pass an explicit set when the cron
   * has a target in mind (e.g. only the agent matching the briefing
   * flavor).
   */
  assistantIds?: ReadonlyArray<number>;
}

/** Construction inputs. Anything missing falls back to env vars. */
export interface ProactiveClientInit {
  baseUrl?: string;
  pairingToken?: string;
}

const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";

interface AssistantTarget {
  assistantId: number;
  /** Most-recent chat for this assistant (used as the proactive target). */
  chatId: number | null;
  agentRoute: string | null;
}

/**
 * One-shot proactive client. Construct it inside a cron entry-point,
 * call `sendProactive(...)`, then let the process exit. No WS, no
 * background timers, no cleanup needed.
 *
 * Caches `whoami` + the resolved chat id for the lifetime of the
 * instance so a single cron run with multiple sends only hits the
 * backend once for routing.
 */
export class BgosProactiveClient {
  private readonly api: BgosApi;
  private readonly cfg: PluginConfig;
  private targets: AssistantTarget[] | null = null;
  /**
   * Self-resolved delivery chats, keyed by assistantId. Populated the first
   * time an assistant is resolved via the primary-chat endpoint and kept for
   * the lifetime of this process so a multi-send cron only POSTs once per
   * assistant (even if `targets` were ever rebuilt).
   */
  private readonly resolvedChats = new Map<number, number>();
  /** Last primary-chat resolve failure per assistant (for a clear skip msg). */
  private readonly resolveErrors = new Map<number, string>();

  constructor(init: ProactiveClientInit = {}) {
    const envBaseUrl =
      init.baseUrl ??
      process.env.GOBOT_BASE_URL ??
      process.env.BGOS_BASE_URL;
    const envToken =
      init.pairingToken ??
      process.env.GOBOT_PAIRING_TOKEN ??
      process.env.BGOS_PAIRING_TOKEN;
    // Fall back to the pairing secrets file (`~/.gobot/secrets/bgos.json`) only
    // when init/env leaves the token or base URL unset. The SEPARATE proactive
    // check-in/briefing processes (launchd `com.go.smart-checkin`, `bun run
    // checkin`) do not inherit the adapter's GOBOT_PAIRING_TOKEN env, so without
    // this every proactive send would be skipped as "unconfigured". Reading is
    // synchronous + never throws, so a missing/corrupt file simply leaves the
    // token undefined and isConfigured() stays false (graceful no-op). Composes
    // with the primary-chat self-resolve so a freshly-paired host gets
    // zero-config proactive delivery.
    const secrets =
      !envToken || !envBaseUrl ? readSecretsSafe() : null;
    const baseUrl =
      envBaseUrl ?? secrets?.baseUrl ?? DEFAULT_BASE_URL;
    const pairingToken =
      envToken ?? secrets?.pairingToken ?? "";
    this.cfg = {
      baseUrl: baseUrl.replace(/\/+$/, ""),
      pairingToken,
      reconnect: { initialDelayMs: 1_000, maxDelayMs: 30_000 },
    };
    this.api = new BgosApi(this.cfg);
  }

  /** True when we have what we need to actually call BGOS. */
  isConfigured(): boolean {
    return Boolean(this.cfg.pairingToken);
  }

  /**
   * Resolve assistant + chat targets for proactive delivery.
   *
   * Chat resolution precedence per assistant:
   *   1. `GOBOT_BGOS_CHAT_ID_<assistantId>` env override (most specific),
   *   2. `GOBOT_BGOS_CHAT_ID` env override (shared fallback),
   *   3. the backend `primary-chat` endpoint — the daemon self-resolves (or
   *      creates) the assistant's delivery chat so the operator never has to
   *      set an env var (parity root cause D).
   *
   * We only touch the network (step 3) when neither env override is present,
   * and the result is cached for the process lifetime (see `resolvePrimaryChat`).
   * When step 3 fails, `chatId` stays null and the assistant is skipped with a
   * clear error (never thrown — proactive must not abort the Telegram leg).
   */
  private async loadTargets(): Promise<AssistantTarget[]> {
    if (this.targets) return this.targets;
    const me = await this.api.whoami();
    const userId = me.user_id;
    const targets: AssistantTarget[] = [];
    for (const a of me.assistants ?? []) {
      let chatId: number | null = readChatIdEnv(a.assistant_id);
      if (chatId === null) {
        chatId = await this.resolvePrimaryChat(a.assistant_id);
      }
      targets.push({
        assistantId: a.assistant_id,
        chatId,
        agentRoute: a.agent_route ?? null,
      });
    }
    this.targets = targets;
    void userId;
    return targets;
  }

  /**
   * Self-resolve the assistant's BGOS delivery chat via the backend, memoized
   * per assistant for the lifetime of this process so repeated proactive sends
   * do not re-POST. Returns null (never throws) when the endpoint is
   * unavailable; the underlying reason is stashed in `resolveErrors` so the
   * caller can surface a clear, skippable message.
   */
  private async resolvePrimaryChat(assistantId: number): Promise<number | null> {
    const cached = this.resolvedChats.get(assistantId);
    if (cached !== undefined) return cached;
    try {
      const chatId = await this.api.getOrCreatePrimaryChat(assistantId);
      this.resolvedChats.set(assistantId, chatId);
      this.resolveErrors.delete(assistantId);
      return chatId;
    } catch (err) {
      this.resolveErrors.set(
        assistantId,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * Send a single proactive message, honoring `GOBOT_HOME_CHANNEL`.
   *
   * - `telegram` → returns immediately with `attempted: false`.
   * - `bgos` / `both` → posts to BGOS and returns delivery stats.
   *
   * Never throws — proactive paths must not abort the Telegram leg if
   * BGOS is down. All errors are surfaced via `result.errors`.
   */
  async sendProactive(
    params: ProactiveSendParams,
  ): Promise<ProactiveSendResult> {
    const channel = resolveHomeChannel();
    if (channel === "telegram") {
      return { attempted: false, delivered: 0, errors: [], channel };
    }
    if (!this.isConfigured()) {
      return {
        attempted: true,
        delivered: 0,
        errors: [
          {
            assistantId: -1,
            error: "no GOBOT_PAIRING_TOKEN configured for BGOS proactive send",
          },
        ],
        channel,
      };
    }

    let targets: AssistantTarget[];
    try {
      targets = await this.loadTargets();
    } catch (err) {
      return {
        attempted: true,
        delivered: 0,
        errors: [
          {
            assistantId: -1,
            error: err instanceof Error ? err.message : String(err),
          },
        ],
        channel,
      };
    }

    const filtered =
      params.assistantIds && params.assistantIds.length > 0
        ? targets.filter((t) =>
            (params.assistantIds as ReadonlyArray<number>).includes(
              t.assistantId,
            ),
          )
        : targets;

    let delivered = 0;
    const errors: Array<{ assistantId: number; error: string }> = [];
    for (const t of filtered) {
      if (t.chatId === null) {
        // Neither an env override nor the primary-chat endpoint yielded a
        // chat. Skip this assistant (never throw — the Telegram leg must
        // still fire) with a message that reflects the self-resolve path.
        const reason = this.resolveErrors.get(t.assistantId);
        errors.push({
          assistantId: t.assistantId,
          error:
            "the daemon could not resolve a BGOS delivery chat for this assistant" +
            (reason ? ` (primary-chat endpoint failed: ${reason})` : ""),
        });
        continue;
      }
      try {
        const fromAgent = sanitizeFromAgent(params.fromAgent);
        await this.api.postMessage({
          assistantId: t.assistantId,
          chatId: t.chatId,
          sender: "assistant",
          text: params.text,
          messageType: "standard",
          ...(params.options ? { options: params.options } : {}),
          ...(fromAgent ? { fromAgent } : {}),
        });
        delivered += 1;
      } catch (err) {
        errors.push({
          assistantId: t.assistantId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { attempted: true, delivered, errors, channel };
  }
}

/**
 * Read the chat-id override env var. The cron scripts set this once via
 * the BGOS Integrations UI ("copy proactive chat id") so we don't need
 * an extra REST endpoint listing chats per assistant.
 *
 * Resolution order:
 *   1. `GOBOT_BGOS_CHAT_ID_<assistantId>` — most specific.
 *   2. `GOBOT_BGOS_CHAT_ID` — fallback shared id.
 *   3. `null` — no chat known; caller skips this assistant.
 */
function readChatIdEnv(assistantId: number): number | null {
  const specific = process.env[`GOBOT_BGOS_CHAT_ID_${assistantId}`];
  const generic = process.env.GOBOT_BGOS_CHAT_ID;
  const raw = specific ?? generic;
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
