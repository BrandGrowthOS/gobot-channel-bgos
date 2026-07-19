import axios, { type AxiosInstance } from "axios";

import {
  PairingRevokedError,
  type AgentCatalogEntry,
  type BgosMessageEnvelope,
  type CommandManifestEntry,
  type InboundMessagePayload,
  type IntegrationPairing,
  type OutboundMessagePayload,
  type PairExchangeResponse,
  type PluginConfig,
} from "./types.js";
import type { VoiceRpcResultBody } from "./voice-rpc.js";
import type { HeartbeatDto } from "./heartbeat.js";

const CONDITIONAL_GET_CACHE_LIMIT = 50;
const CHAT_HISTORY_PAGE_SIZE = 50;

interface ConditionalGetCacheEntry {
  etag: string;
  body: unknown;
}

export interface MissionMiniGoalInput {
  name: string;
  doneWhen: string;
}

export interface MissionProgressInput {
  current: number;
  total: number;
  label?: string;
}

export interface MissionDto {
  id: number;
  [key: string]: unknown;
}

export interface MissionMutationResponse {
  ok: true;
  mission: MissionDto;
}

export interface CreateMissionBody {
  title: string;
  miniGoals?: MissionMiniGoalInput[];
  progress?: MissionProgressInput;
  origin: "self_report";
  firstFeedText?: string;
}

export interface TickMissionBody {
  goalId: number;
  evidence?: string;
}

export interface ProgressMissionBody {
  progress?: MissionProgressInput;
  feedEntry?: { kind: "worked"; text: string };
}

export interface CompleteMissionBody {
  summary?: string;
}

/**
 * Thin typed wrapper around the BGOS integration endpoints. All methods
 * attach the X-BGOS-Pairing header from cfg.pairingToken.
 *
 * A 401 from any request is mapped to PairingRevokedError so callers
 * (WS client, outbound adapter) can short-circuit and let the setup
 * wizard prompt for re-pair.
 */
export class BgosApi {
  private readonly http: AxiosInstance;
  private readonly conditionalGetCache = new Map<
    string,
    ConditionalGetCacheEntry
  >();

  constructor(cfg: PluginConfig) {
    this.http = axios.create({
      baseURL: cfg.baseUrl + "/api/v1",
      headers: {
        "X-BGOS-Pairing": cfg.pairingToken,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });
    this.http.interceptors.response.use(
      (r) => r,
      (err) => {
        if (err?.response?.status === 401) {
          return Promise.reject(
            new PairingRevokedError(
              err.response?.data?.message ?? "pairing rejected by BGOS",
            ),
          );
        }
        return Promise.reject(err);
      },
    );
  }

  /**
   * GET with an in-memory validator and body cache keyed by the full URL.
   * The body is retained with its ETag so a 304 can preserve the method's
   * normal return shape. Cache reads refresh access order.
   */
  private async conditionalGet<T>(
    url: string,
    params: Record<string, string | number | undefined>,
    useValidator = true,
  ): Promise<T> {
    const cacheKey = this.http.getUri({ url, params });
    const expectedEntry = this.conditionalGetCache.get(cacheKey);
    const cached = useValidator ? expectedEntry : undefined;
    if (cached) {
      this.conditionalGetCache.delete(cacheKey);
      this.conditionalGetCache.set(cacheKey, cached);
    }

    const response = await this.http.get<T>(url, {
      params,
      headers: cached ? { "If-None-Match": cached.etag } : undefined,
      validateStatus: (status) =>
        status === 304 || (status >= 200 && status < 300),
    });

    if (response.status === 304) {
      if (!cached) {
        if (useValidator) {
          return this.conditionalGet(url, params, false);
        }
        throw new Error(
          `BGOS returned 304 twice without a cached body for ${cacheKey}`,
        );
      }
      if (this.conditionalGetCache.get(cacheKey) === expectedEntry) {
        const responseEtag = response.headers.etag;
        if (
          typeof responseEtag === "string" &&
          responseEtag.length > 0 &&
          responseEtag !== cached.etag
        ) {
          this.storeConditionalGetEntry(cacheKey, {
            etag: responseEtag,
            body: cached.body,
          });
        }
      }
      return cached.body as T;
    }

    if (this.conditionalGetCache.get(cacheKey) === expectedEntry) {
      if (response.status === 200) {
        const etag = response.headers.etag;
        if (typeof etag === "string" && etag.length > 0) {
          this.storeConditionalGetEntry(cacheKey, {
            etag,
            body: response.data,
          });
        } else {
          this.conditionalGetCache.delete(cacheKey);
        }
      } else {
        this.conditionalGetCache.delete(cacheKey);
      }
    }

    return response.data;
  }

  private storeConditionalGetEntry(
    cacheKey: string,
    entry: ConditionalGetCacheEntry,
  ): void {
    this.conditionalGetCache.delete(cacheKey);
    this.conditionalGetCache.set(cacheKey, entry);
    while (this.conditionalGetCache.size > CONDITIONAL_GET_CACHE_LIMIT) {
      const oldest = this.conditionalGetCache.keys().next().value;
      if (oldest === undefined) break;
      this.conditionalGetCache.delete(oldest);
    }
  }

  /** GET /integrations/me — confirms token + touches last_seen_at.
   *  Includes assistant→agent_route bindings so the plugin can seed
   *  its dispatch map on cold start.
   */
  async whoami(): Promise<{
    pairing_id: number;
    user_id: string;
    device_label: string;
    integration: string;
    assistants?: Array<{
      assistant_id: number;
      agent_route: string | null;
      name: string;
      /** Count of slash-commands currently set; lets callers decide
       *  whether to seed defaults without a second round-trip. */
      command_count?: number;
    }>;
  }> {
    const r = await this.http.get("integrations/me");
    return r.data;
  }

  /**
   * Fetch the served capability canon for this channel (capability bootstrap).
   * The backend owns the machine-readable canon and serves a per-channel
   * payload; the daemon injects the returned `text` into the agent's system
   * prompt at connect, falling back to the bundled BGOS_AGENT_HINTS when this
   * is unreachable. GET is pairing-token authed like every other method here.
   *
   * `text` is header + shared core + the gobot channel delta, ready to inject.
   * Any non-2xx (including a 404 from an older backend that predates the
   * endpoint) throws, and the caller keeps the bundled fallback.
   */
  async getCapabilities(channel = "gobot"): Promise<{
    channel: string;
    version: string;
    text: string;
    core: string;
    channelSyntax: string;
  }> {
    // SECURITY: cap the response size at the transport layer. The canon is a
    // few KB and is injected into a shell-capable agent's system prompt, so a
    // compromised or MITM'd backend must not be able to stream a giant body
    // (memory DoS). axios rejects past maxContentLength and the caller keeps
    // the bundled fallback.
    const r = await this.http.get("integrations/capabilities", {
      params: { channel },
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
    });
    return r.data;
  }

  /** Pair exchange (Public; does NOT need X-BGOS-Pairing). */
  static async pairExchange(
    baseUrl: string,
    params: {
      code: string;
      deviceLabel: string;
      agentCatalog?: AgentCatalogEntry[];
      /**
       * Channel label persisted on the pairing row. MUST be `'gobot'` for
       * Gobot pairings — without it, the backend falls back to `'openclaw'`
       * and the pairing surfaces under the OpenClaw card with assistants
       * created as code='openclaw' (wrong UI gates, wrong slash picker).
       */
      integration?: string;
      /** Daemon version stamped on the pairing row (contract C1). */
      daemonVersion?: string;
    },
  ): Promise<PairExchangeResponse> {
    const base = baseUrl.replace(/\/+$/, "") + "/api/v1";
    const r = await axios.post(`${base}/integrations/pair-exchange`, params, {
      timeout: 15_000,
    });
    return r.data;
  }

  /** Plugin pushes (or updates) the agent catalog for this pairing. */
  async pushAgentCatalog(
    pairingId: number,
    agents: AgentCatalogEntry[],
  ): Promise<void> {
    await this.http.post(`integrations/pairings/${pairingId}/agent-catalog`, {
      agents,
    });
  }

  /** Plugin replaces the slash-command manifest for a single bound assistant. */
  async putCommands(
    assistantId: number,
    commands: CommandManifestEntry[],
  ): Promise<void> {
    await this.http.put(
      `integrations/assistants/${assistantId}/commands`,
      { commands },
    );
  }

  /** REST backfill after a WS reconnect. */
  async inboundSince(sinceMessageId: number): Promise<{
    messages: InboundMessagePayload[];
  }> {
    return this.conditionalGet("integrations/inbound", {
      since_message_id: sinceMessageId,
    });
  }

  /** Fetch the recent message history for a chat — used by the daemon to
   *  rebuild conversation context before dispatching to a stateless
   *  gateway. Requests 50 entries ASC by created_at. */
  async getMessages(
    chatId: number,
    userId: string,
    afterId?: number,
  ): Promise<BgosMessageEnvelope[]> {
    const data = await this.conditionalGet<{
      messages?: BgosMessageEnvelope[];
    }>(`chats/${chatId}/messages`, {
      userId,
      limit: CHAT_HISTORY_PAGE_SIZE,
      ...(afterId !== undefined ? { afterId } : {}),
    });
    const rows = data?.messages;
    return Array.isArray(rows) ? (rows as BgosMessageEnvelope[]) : [];
  }

  /**
   * Self-resolve (or create) this assistant's primary BGOS delivery chat —
   * the target for proactive / check-in sends when no `GOBOT_BGOS_CHAT_ID`
   * env override is set (parity root cause D). Pairing-token auth only (the
   * pairing must own the assistant; the backend enforces this).
   *
   * `POST /integrations/assistants/:assistantId/primary-chat` (no body). The
   * backend resolves the assistant's `primaryChatId`, else the newest
   * `kind='main'` chat, else creates a fresh main chat (pinning only on a
   * fresh create). Response is `{ chat_id: number }`.
   *
   * Throws on any non-2xx or a malformed response — the caller (proactive
   * `loadTargets`) treats a throw as "skip this assistant".
   */
  async getOrCreatePrimaryChat(assistantId: number): Promise<number> {
    const r = await this.http.post(
      `integrations/assistants/${assistantId}/primary-chat`,
      {},
    );
    const chatId = (r.data as { chat_id?: number } | null)?.chat_id;
    if (typeof chatId !== "number" || !Number.isFinite(chatId) || chatId <= 0) {
      throw new Error(
        `primary-chat endpoint returned no chat_id for assistant ${assistantId}`,
      );
    }
    return chatId;
  }

  /** Agent reply — assistant message with optional inline buttons/approval. */
  async postMessage(
    payload: OutboundMessagePayload,
  ): Promise<{ id: number }> {
    const r = await this.http.post("messages", payload);
    return r.data;
  }

  /**
   * Agent reply via `POST /api/v1/send-message` — the SAME wire payload as
   * `postMessage`, but the endpoint the backend runs its peer-reply bridge
   * (`bridgePeerReplyIfApplicable`) on. For an a2a side-thread chat that
   * bridge stamps `peer_conversation_id` on the reply, which is what
   * resolves the initiating peer's `wait_for_reply`. `/messages` has no
   * such bridge, so peer replies sent there never resolve the wait — hence
   * a dedicated method (see inbound-handler.ts; reference impl
   * bgos-claude-plugin/server.ts uses `bgosPost('send-message', …)`).
   *
   * Response shape differs from `/messages`: the controller returns the
   * created message nested under `message` (HTTP 200) rather than a bare
   * `{ id }` (HTTP 201), so unwrap both shapes.
   */
  async sendMessage(
    payload: OutboundMessagePayload,
  ): Promise<{ id: number }> {
    const r = await this.http.post("send-message", payload);
    const data = (r.data ?? {}) as {
      id?: number;
      message?: { id?: number };
    };
    return { id: data.message?.id ?? data.id ?? 0 };
  }

  /**
   * PATCH an existing message. Used by the tool_progress card flow to
   * update a card in place — adding new tools as they fire, transitioning
   * state running → done at end-of-turn.
   *
   * The backend (BGOS PR #200, deployed 2026-05-16) auto-fills userId from
   * the authenticated principal when omitted from the body. We always omit
   * it from this client — pairing auth on the request itself carries the
   * identity. Returns the updated message dto.
   */
  async patchMessage(
    messageId: number,
    payload: {
      text?: string;
      toolProgress?: {
        state: "running" | "done";
        tools: Array<{
          icon: string;
          name: string;
          args?: string;
          status: "running" | "done" | "error";
        }>;
      };
    },
  ): Promise<{ id: number }> {
    const r = await this.http.patch(`messages/${messageId}`, payload);
    return r.data;
  }

  /** Request a presigned PUT for a file ≥500 KB that the agent wants to send.
   *
   * Route is `POST /api/v1/files/upload-url` (FileController) — NOT under
   * `/integrations/`; the old `integrations/files/upload-url` path 404'd,
   * silently breaking every ≥500 KB media send. The request DTO is camelCase
   * `{ fileName, contentType, size }` and the response is `{ uploadUrl, key }`
   * — both diverged from the snake_case shape this client used. We send the
   * right keys and normalize the response to the `{ upload_url, s3_key }`
   * shape `publishMediaPath` consumes. */
  async createUploadUrl(params: {
    filename: string;
    mimeType: string;
    size: number;
  }): Promise<{
    upload_url: string;
    s3_key: string;
  }> {
    const r = await this.http.post("files/upload-url", {
      fileName: params.filename,
      contentType: params.mimeType,
      size: params.size,
    });
    return { upload_url: r.data.uploadUrl, s3_key: r.data.key };
  }

  /** List this pairing's active/paired state. Mostly used in setup wizard. */
  async listPairings(): Promise<IntegrationPairing[]> {
    const r = await this.http.get("integrations/pairings");
    return r.data;
  }

  /**
   * POST a liveness heartbeat (contract C1). Pairing-token auth only. The
   * backend touches last_seen_at + records daemon_version / last_error_*.
   * Additive: older backends 404 this route; callers must treat any failure
   * as non-fatal (the HeartbeatController swallows it).
   */
  async postHeartbeat(body: HeartbeatDto): Promise<void> {
    await this.http.post("integrations/heartbeat", body);
  }

  /**
   * Set (or clear) an assistant's status line (contract C4). PATCHes the
   * pairing-scoped `/integrations/assistants/:assistantId/status`. Pass an
   * empty string to clear. Fail-open at the call site (fork throttles + never
   * lets a status write suppress a reply).
   */
  async setStatus(
    assistantId: number,
    body: { statusText: string | null; statusEmoji?: string | null },
  ): Promise<void> {
    await this.http.patch(
      `integrations/assistants/${assistantId}/status`,
      body,
    );
  }

  /** Create or replace the assistant's open self-report mission. */
  async createMission(
    assistantId: number,
    body: CreateMissionBody,
  ): Promise<MissionMutationResponse> {
    const r = await this.http.post(
      `integrations/assistants/${assistantId}/missions`,
      body,
    );
    return r.data;
  }

  /** Resolve the assistant's currently open mission, if any. */
  async getActiveMission(assistantId: number): Promise<{
    mission: MissionDto | null;
  }> {
    const r = await this.http.get(
      `integrations/assistants/${assistantId}/missions/active`,
    );
    return r.data;
  }

  /** Mark one binary mini-goal complete. */
  async tickMiniGoal(
    assistantId: number,
    missionId: number,
    body: TickMissionBody,
  ): Promise<MissionMutationResponse> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/tick`,
      body,
    );
    return r.data;
  }

  /** Record countable progress and an optional worked feed entry. */
  async updateMissionProgress(
    assistantId: number,
    missionId: number,
    body: ProgressMissionBody,
  ): Promise<MissionMutationResponse> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/progress`,
      body,
    );
    return r.data;
  }

  /** Complete the assistant's open mission. */
  async completeMission(
    assistantId: number,
    missionId: number,
    body: CompleteMissionBody = {},
  ): Promise<MissionMutationResponse> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/complete`,
      body,
    );
    return r.data;
  }

  /** Abandon the assistant's open mission. */
  async abandonMission(
    assistantId: number,
    missionId: number,
  ): Promise<MissionMutationResponse> {
    const r = await this.http.patch(
      `integrations/assistants/${assistantId}/missions/${missionId}/abandon`,
      {},
    );
    return r.data;
  }

  /**
   * Swap the pairing token (and optionally base URL) in place after a token
   * rotation, so existing references (outbound, tool-progress) keep working
   * without a rebuild. Used by the adapter's re-pair recovery path.
   */
  updateToken(token: string, baseUrl?: string): void {
    const headers = this.http.defaults.headers as unknown as {
      common: Record<string, unknown>;
      [k: string]: unknown;
    };
    headers.common["X-BGOS-Pairing"] = token;
    headers["X-BGOS-Pairing"] = token;
    if (baseUrl) {
      this.http.defaults.baseURL = baseUrl.replace(/\/+$/, "") + "/api/v1";
    }
  }

  // -------------------------------------------------------------------
  // Native voice control plane (voice_rpc — see voice-rpc.ts)
  // -------------------------------------------------------------------

  /** ACK a voice_rpc frame — cancels the backend's 1.5 s retry-emit.
   *  Best-effort; callers must treat a failure as non-fatal. */
  async postVoiceRpcAck(rpcId: string): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-rpc/${encodeURIComponent(rpcId)}/ack`,
      {},
    );
    return r.data;
  }

  /** Settle a voice_rpc op (mint / consult / dispatch-accept). The backend
   *  drops results that arrive after its own per-op deadline, so callers
   *  keep their inner caps strictly under it (see voice-rpc.ts). */
  async postVoiceRpcResult(
    rpcId: string,
    body: VoiceRpcResultBody,
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-rpc/${encodeURIComponent(rpcId)}/result`,
      body,
    );
    return r.data;
  }

  /** Report the outcome of a detached voice dispatch — flips the durable
   *  voice_tasks row and fans `voice_task_update` to the user's devices. */
  async postVoiceTaskResult(
    taskId: string,
    body: VoiceRpcResultBody,
  ): Promise<unknown> {
    const r = await this.http.post(
      `integrations/voice-tasks/${encodeURIComponent(taskId)}/result`,
      body,
    );
    return r.data;
  }
}
