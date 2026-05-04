/**
 * Payload shapes mirrored from the BGOS backend. Independent types so the
 * plugin doesn't depend on backend code.
 *
 * Keep these in sync with:
 *   docs/superpowers/specs/2026-04-25-gobot-bgos-integration-design.md §7
 *   backend/src/dto/integrations/*.ts
 */

export type IntegrationDirection = "bgos_initiated" | "gobot_initiated";

export interface PairExchangeResponse {
  pairing_token: string;
  pairing_id: number;
  user_id: string;
}

export interface AgentCatalogEntry {
  agent_route: string;
  name: string;
  description?: string;
  avatar_url?: string;
}

export interface IntegrationPairing {
  id: number;
  device_label: string;
  integration: string;
  token_prefix: string;
  last_seen_at: string | null;
  created_at: string;
  agent_catalog: AgentCatalogEntry[];
}

export interface InboundFile {
  id: number;
  filename: string;
  mime: string;
  url?: string;
}

export interface InboundMessagePayload {
  assistantId: number;
  userId: string;
  chatId: number;
  messageId: number;
  text: string;
  files: InboundFile[];
  messageType:
    | "standard"
    | "slash_command"
    | "approval_request"
    | "agent_error"
    | "ask_user_input";
  commandName?: string;
  commandArgs?: string;
}

export interface CommandsUpdatedPayload {
  userId: string;
  assistantId: number;
  commands: CommandManifestEntry[];
}

export interface PairReadyPayload {
  userId: string;
  pairingId: number;
  agentCatalog: AgentCatalogEntry[];
}

export interface AssistantBoundPayload {
  pairingId: number;
  assistantId: number;
  agentRoute: string;
}

export interface AssistantUnboundPayload {
  pairingId: number;
  assistantId: number;
}

export interface PairingRevokedPayload {
  pairingId: number;
  reason?: string;
}

export interface CallbackResultPayload {
  messageId: number;
  optionId: number;
  success: boolean;
  error?: string;
  assistantId?: number;
}

/** Option = button on a message (Telegram inline-keyboard equivalent). */
export interface MessageOption {
  text: string;
  callbackData: string;
  style?: "default" | "success" | "danger" | "primary";
}

export interface ApprovalMeta {
  tool: string;
  agent_route: string;
  risk: "low" | "medium" | "high";
  request_id: string;
  expired?: boolean;
}

/**
 * Inline agent identity. When present, the backend resolves it to
 * `messages.from_agent_inline` (or `from_agent_peer_id` if `peerId`/
 * `assistantId` matches a peer in the registry) and the BGOS frontend
 * renders the bubble with this name + color + avatar instead of the
 * bound assistant's identity.
 *
 * Used by `/board` to render each agent's contribution as a visually
 * distinct bubble even though they all originate from the single bound
 * Gobot assistant. Mirrors `FromAgentInputDto` in the backend.
 */
export interface FromAgentInput {
  /** AgentPeer.id from the BGOS registry (preferred when available). */
  peerId?: number;
  /** Source assistant id — for BGOS-native cross-assistant peers. */
  assistantId?: number;
  /** Stable string id (max 128 chars) used to look up the peer. */
  externalId?: string;
  /** Display name (inline fallback). Max 80 chars. */
  name?: string;
  /** Bubble accent color, hex e.g. "#0EA5E9". */
  color?: string;
  /** Avatar URL (https only). Max 2048 chars. */
  avatarUrl?: string;
  /** Agent type. `[a-z0-9_-]+`, max 32 chars. */
  type?: "n8n" | "bgos" | "external" | "gobot" | string;
}

/** Outbound message payload we POST to /api/v1/messages. */
export interface OutboundMessagePayload {
  assistantId: number;
  chatId: number;
  text: string;
  sender: "assistant";
  options?: MessageOption[];
  messageType?:
    | "standard"
    | "slash_command"
    | "approval_request"
    | "agent_error";
  approvalMeta?: ApprovalMeta;
  files?: Array<{
    fileName: string;
    fileMimeType: string;
    fileData?: string; // inline base64 (<500 KB path)
    s3Key?: string; // presigned-put path
  }>;
  /**
   * When set, the backend stores `messages.reply_to_id = replyToId` and the
   * UI renders this as a quoted reply. REQUIRED in agent-to-agent (a2a)
   * side-thread chats: the originator's pollForReply correlates the target's
   * reply with the inbound peer message via this field. Without it the
   * backend falls back to positional matching, which works for 1:1 side
   * threads but is less precise.
   */
  replyToId?: number;
  /**
   * Inline-agent identity override. When set, the backend's
   * agent-peer resolver maps it to `messages.from_agent_peer_id` (registry
   * hit) or `messages.from_agent_inline` (free-form), and the BGOS UI
   * renders the bubble with the supplied name/avatar/color. Required for
   * Gobot's `/board` flow so each agent's contribution shows as its own
   * sender even though they share one bound assistant.
   */
  fromAgent?: FromAgentInput;
}

export interface CommandManifestEntry {
  command: string;
  description: string;
  scope?: string;
  order_index?: number;
}

export interface PluginConfig {
  baseUrl: string;
  pairingToken: string;
  reconnect: {
    initialDelayMs: number;
    maxDelayMs: number;
  };
}

/** Error thrown when BGOS returns 401 — plugin should clear token + re-pair. */
export class PairingRevokedError extends Error {
  constructor(message = "Pairing token revoked or invalid") {
    super(message);
    this.name = "PairingRevokedError";
  }
}

/** OpenAI-compat chat message. One of these per prior turn when we dispatch
 *  to the gateway, so the agent sees full conversation context. */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** One entry from `GET /api/v1/chats/:id/messages?userId=`. The backend
 *  returns `MessagesDto { messages: MessageWithFilesAndOptionsDto[] }`,
 *  where each entry nests a `message` object. */
export interface BgosMessageEnvelope {
  message: {
    id: number;
    sender: "user" | "assistant" | null;
    text: string | null;
    messageType: string;
    createdAt: string;
  };
}
