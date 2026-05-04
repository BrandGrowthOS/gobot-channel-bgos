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
import { resolveHomeChannel, type HomeChannel } from "./home-channel.js";
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

  constructor(init: ProactiveClientInit = {}) {
    const baseUrl =
      init.baseUrl ??
      process.env.GOBOT_BASE_URL ??
      process.env.BGOS_BASE_URL ??
      DEFAULT_BASE_URL;
    const pairingToken =
      init.pairingToken ??
      process.env.GOBOT_PAIRING_TOKEN ??
      process.env.BGOS_PAIRING_TOKEN ??
      "";
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
   * Resolve assistant + chat targets. The chat is the assistant's
   * most-recent chat (last message in `getMessages` ordered ASC); when
   * the assistant has no messages yet, the proactive send is skipped
   * (we don't auto-create a chat from a cron — that's the user's
   * decision and would surface as a noisy empty thread).
   */
  private async loadTargets(): Promise<AssistantTarget[]> {
    if (this.targets) return this.targets;
    const me = await this.api.whoami();
    const userId = me.user_id;
    const targets: AssistantTarget[] = [];
    for (const a of me.assistants ?? []) {
      let chatId: number | null = null;
      try {
        // We don't have a direct "list chats for assistant" on the
        // integrations surface, so we cheat: getMessages requires a
        // chatId we don't have. For V1 we pin proactive deliveries to
        // the assistant's most-recent chat by listing pairings → no,
        // pairings doesn't give us that either. Fall through and let
        // the fork pass `assistantIds` + a known `chatId` via the
        // env var below when it has one.
        chatId = readChatIdEnv(a.assistant_id);
      } catch {
        chatId = null;
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
        errors.push({
          assistantId: t.assistantId,
          error:
            "no chat target — set GOBOT_BGOS_CHAT_ID or " +
            `GOBOT_BGOS_CHAT_ID_${t.assistantId} env var to enable proactive routing`,
        });
        continue;
      }
      try {
        await this.api.postMessage({
          assistantId: t.assistantId,
          chatId: t.chatId,
          sender: "assistant",
          text: params.text,
          messageType: "standard",
          ...(params.options ? { options: params.options } : {}),
          ...(params.fromAgent ? { fromAgent: params.fromAgent } : {}),
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
