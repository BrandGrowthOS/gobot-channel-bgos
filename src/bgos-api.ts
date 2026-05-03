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
export class BgosApi {
  private readonly http: AxiosInstance;

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

  /** REST backfill after a WS reconnect. */
  async inboundSince(sinceMessageId: number): Promise<{
    messages: InboundMessagePayload[];
  }> {
    const r = await this.http.get("integrations/inbound", {
      params: { since_message_id: sinceMessageId },
    });
    return r.data;
  }

  /** Fetch the recent message history for a chat — used by the daemon to
   *  rebuild conversation context before dispatching to a stateless
   *  gateway. Backend returns up to 100 entries ASC by created_at. */
  async getMessages(
    chatId: number,
    userId: string,
  ): Promise<BgosMessageEnvelope[]> {
    const r = await this.http.get(`chats/${chatId}/messages`, {
      params: { userId },
    });
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

  /** Request a presigned PUT for a file ≥500 KB that the agent wants to send. */
  async createUploadUrl(params: {
    filename: string;
    mimeType: string;
    size: number;
  }): Promise<{
    upload_url: string;
    s3_key: string;
    expires_at: string;
  }> {
    const r = await this.http.post("integrations/files/upload-url", {
      filename: params.filename,
      mime_type: params.mimeType,
      size: params.size,
    });
    return r.data;
  }

  /** List this pairing's active/paired state. Mostly used in setup wizard. */
  async listPairings(): Promise<IntegrationPairing[]> {
    const r = await this.http.get("integrations/pairings");
    return r.data;
  }

  // ─── Peer (cross-channel a2a) endpoints — see capabilities §11 ────────────
  //
  // Every peer call sends `X-Caller-Assistant-Id` IN ADDITION to the
  // standard `X-BGOS-Pairing` header. Caller id is per-call so a single
  // Gobot host can serve multiple bound assistants on the same pairing.

  private peerHeaders(callerAssistantId: number): Record<string, string> {
    return { "X-Caller-Assistant-Id": String(callerAssistantId) };
  }

  /** GET /peers — discovery. */
  async listPeers(callerAssistantId: number): Promise<unknown[]> {
    const r = await this.http.get("peers", {
      headers: this.peerHeaders(callerAssistantId),
    });
    if (Array.isArray(r.data)) return r.data;
    if (Array.isArray((r.data as { peers?: unknown[] })?.peers)) {
      return (r.data as { peers: unknown[] }).peers;
    }
    return [];
  }

  /** GET /peers/:peerAssistantId/status — presence + open conversation. */
  async peerStatus(
    callerAssistantId: number,
    peerAssistantId: number,
  ): Promise<unknown> {
    const r = await this.http.get(`peers/${peerAssistantId}/status`, {
      headers: this.peerHeaders(callerAssistantId),
    });
    return r.data;
  }

  /** POST /peers/:targetAssistantId/send — send to peer.
   *
   *  Idempotency: do NOT retry on 504 / network timeout — the message is
   *  already saved server-side. */
  async sendToPeer(input: {
    callerAssistantId: number;
    targetAssistantId: number;
    text: string;
    parentMessageId: number;
    waitForReply?: boolean;
    timeoutSeconds?: number;
    turnState?: "expecting_reply" | "more_coming" | "final";
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      text: input.text,
      parentMessageId: input.parentMessageId,
      waitForReply: input.waitForReply ?? false,
    };
    if (input.timeoutSeconds !== undefined) {
      body.timeoutSeconds = input.timeoutSeconds;
    }
    if (input.turnState !== undefined) {
      body.turnState = input.turnState;
    }
    const r = await this.http.post(
      `peers/${input.targetAssistantId}/send`,
      body,
      { headers: this.peerHeaders(input.callerAssistantId) },
    );
    return r.data;
  }

  /** POST /peers/conversations/close — close active conversation. */
  async completePeerThread(input: {
    callerAssistantId: number;
    peerAssistantId: number;
    summary?: string;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      peerAssistantId: input.peerAssistantId,
    };
    if (input.summary && input.summary.trim().length > 0) {
      body.summary = input.summary.trim();
    }
    const r = await this.http.post("peers/conversations/close", body, {
      headers: this.peerHeaders(input.callerAssistantId),
    });
    return r.data;
  }

  /** POST /peers/threads/:parentMessageId/complete — flip the
   *  SideConversationCard to completed-collapsed. */
  async completeSideThread(input: {
    callerAssistantId: number;
    parentMessageId: number;
    summary: string;
  }): Promise<unknown> {
    const r = await this.http.post(
      `peers/threads/${input.parentMessageId}/complete`,
      { summary: input.summary },
      { headers: this.peerHeaders(input.callerAssistantId) },
    );
    return r.data;
  }

  /** GET /peers/threads/:parentMessageId — fetch a side-thread. */
  async getSideThread(
    callerAssistantId: number,
    parentMessageId: number,
  ): Promise<unknown> {
    const r = await this.http.get(`peers/threads/${parentMessageId}`, {
      headers: this.peerHeaders(callerAssistantId),
    });
    return r.data;
  }

  /** GET /peers/inbox — list main + a2a chats where this assistant is the
   *  recipient. */
  async getPeerInbox(callerAssistantId: number): Promise<unknown> {
    const r = await this.http.get("peers/inbox", {
      headers: this.peerHeaders(callerAssistantId),
    });
    return r.data;
  }
}
