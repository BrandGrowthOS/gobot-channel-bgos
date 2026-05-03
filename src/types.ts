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

// ─── Peer (cross-channel agent-to-agent) types — see capabilities §11 ────────

export type PeerSendStatus = "sent" | "requires_introduction";
export type PeerTurnState = "expecting_reply" | "more_coming" | "final";

export interface PeerEntry {
  assistantId: number;
  name: string;
  avatarUrl?: string | null;
  color?: string | null;
  /** True ONLY if the user has enabled this caller→target row in the BGOS
   *  Agent Permissions matrix. False means `sendToPeer` will return
   *  `requires_introduction`. */
  introduced: boolean;
  /** Non-null = ephemeral allow-once expiry. */
  expiresAt?: string | null;
}

export interface PeerStatus {
  online: boolean;
  lastSeenAt: string | null;
  hasOpenConversation: boolean;
  conversationId: number | null;
  turnHolderId: number | null;
}

export interface PeerSendInput {
  /** Assistant id of the caller (this agent). Sent as `X-Caller-Assistant-Id`
   *  header. */
  callerAssistantId: number;
  targetAssistantId: number;
  text: string;
  /** A message id in the caller's chat that the SideConversationCard
   *  visually anchors against. Typically the id of a "Looping in <peer>..."
   *  reply the caller posted just before this call. */
  parentMessageId: number;
  waitForReply?: boolean;
  /** When `waitForReply=true`, server cap is 85s. Default 60s. */
  timeoutSeconds?: number;
  turnState?: PeerTurnState;
}

export interface PeerSendResult {
  status: PeerSendStatus;
  sideThreadChatId: number | null;
  messageId: number | null;
  conversationId: number | null;
  turnState: PeerTurnState | null;
  reply?: { id: number; text: string } | null;
}

export interface PeerCompleteThreadInput {
  callerAssistantId: number;
  peerAssistantId?: number;
  parentMessageId?: number;
  summary?: string;
}

export interface PeerInbox {
  chats: Array<{
    id: number;
    assistantId: number;
    kind: "main" | "a2a";
  }>;
}
