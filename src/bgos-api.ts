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

/**
 * Thin typed wrapper around the BGOS integration endpoints. All methods
 * attach the X-BGOS-Pairing header from cfg.pairingToken.
 *
 * A 401 from any request is mapped to PairingRevokedError so callers
 * (WS client, outbound adapter) can short-circuit and let the setup
 * wizard prompt for re-pair.
 */
/**
 * Sentinel returned by conditional GETs when the server replies 304 Not
 * Modified. Distinct from any real body so callers can tell "nothing changed,
 * skip work" apart from a normal response. Egress fix (Stage 4): conditional
 * GET on the inbound poll lets the Stage-3 backend answer the tight poll loop
 * with a 0-byte 304 instead of re-serializing the message list every few
 * seconds.
 */
export const NOT_MODIFIED = Symbol("bgos.notModified");

export class BgosApi {
  private readonly http: AxiosInstance;
  /**
   * Last ETag seen per conditional-GET cache key, so the next poll can send
   * `If-None-Match`. In-process only — on restart we re-fetch the full payload
   * once (the backend still returns 200 + body for a missing/non-matching
   * ETag), so losing this is harmless and backward-safe.
   */
  private readonly etagByKey = new Map<string, string>();

  constructor(cfg: PluginConfig) {
    this.http = axios.create({
      baseURL: cfg.baseUrl + "/api/v1",
      headers: {
        "X-BGOS-Pairing": cfg.pairingToken,
        "Content-Type": "application/json",
        // Defensive: axios already injects this in Node (decompress defaults
        // to true), but pinning it makes the Stage-1 gzip win explicit and
        // robust against future axios/proxy changes. Server gzips; axios
        // transparently decompresses.
        "Accept-Encoding": "gzip, deflate, br",
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

  /** REST backfill after a WS reconnect AND the steady-state poll loop.
   *
   * Conditional-GET aware (egress fix): when we hold an ETag for this cursor
   * we send `If-None-Match`; a 304 surfaces as the `NOT_MODIFIED` sentinel so
   * the caller can skip work entirely. Against an older backend that doesn't
   * emit ETags this is identical to the prior behavior (always 200 + full
   * body). The ETag bucket is keyed by cursor so a validator minted for one
   * cursor is never replayed against a different one.
   */
  async inboundSince(
    sinceMessageId: number,
  ): Promise<{ messages: InboundMessagePayload[] } | typeof NOT_MODIFIED> {
    const cacheKey = `inbound:${sinceMessageId}`;
    const prevEtag = this.etagByKey.get(cacheKey);
    const r = await this.http.get("integrations/inbound", {
      params: { since_message_id: sinceMessageId },
      headers: prevEtag ? { "If-None-Match": prevEtag } : undefined,
      // 304 is not 2xx; tell axios to resolve (not throw) so we can branch.
      validateStatus: (s) => (s >= 200 && s < 300) || s === 304,
    });
    if (r.status === 304) return NOT_MODIFIED;
    const etag = r.headers?.etag ?? r.headers?.ETag;
    if (typeof etag === "string" && etag) {
      this.etagByKey.set(cacheKey, etag);
    } else {
      this.etagByKey.delete(cacheKey);
    }
    return r.data;
  }

  /** Fetch the recent message history for a chat — used by the daemon to
   *  rebuild conversation context before dispatching to a stateless
   *  gateway. Backend returns up to 100 entries ASC by created_at.
   *
   *  Egress fix (Stage 2/4) — both opts are additive and opt-in so older
   *  backends ignore them harmlessly:
   *   - `afterId`: ask the backend for only messages newer than the last one
   *     we've already seen (`?afterId=<lastSeenId>`), turning a full re-fetch
   *     into a delta.
   *   - `lite`: request audio-by-URL instead of inline base64 `audioData`
   *     (`?lite=1`), so voice notes don't bloat the response.
   */
  async getMessages(
    chatId: number,
    userId: string,
    opts?: { afterId?: number; lite?: boolean },
  ): Promise<BgosMessageEnvelope[]> {
    const params: Record<string, string | number> = { userId };
    if (opts?.afterId !== undefined && Number.isFinite(opts.afterId)) {
      params.afterId = opts.afterId;
    }
    if (opts?.lite) {
      params.lite = 1;
    }
    const r = await this.http.get(`chats/${chatId}/messages`, { params });
    const rows = r.data?.messages;
    return Array.isArray(rows) ? (rows as BgosMessageEnvelope[]) : [];
  }

  /** Agent reply — assistant message with optional inline buttons/approval. */
  async postMessage(
    payload: OutboundMessagePayload,
  ): Promise<{ id: number }> {
    const r = await this.http.post("messages", payload);
    return r.data;
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
}
