import type { BgosApi } from "./bgos-api.js";
import { publishMediaPath } from "./attachment-bridge.js";
import type {
  ApprovalMeta,
  FromAgentInput,
  MessageOption,
  OutboundMessagePayload,
} from "./types.js";

/**
 * High-level outbound adapter for the Gobot channel.
 *
 * Wraps `BgosApi.postMessage` with the modality-specific helpers
 * `BGOSAdapter` + the fork's reply-handle expose:
 *   - `sendText`              plain assistant reply
 *   - `sendButtons`           text + ≤6 inline option chips
 *   - `sendApprovalRequest`   approval bubble (`ea:<decision>:<reqId>`)
 *   - `sendAskUserInput`      blocking pop-under (modal or inline)
 *   - `sendFile/Image/Video`  attach a local file via attachment-bridge
 *   - `sendAgentError`        styled error bubble used on dispatch failure
 *   - `sendTyping`            best-effort indicator (no-op on backend today)
 *
 * Validation is light — the backend does the authoritative checks. We
 * enforce limits client-side only when the failure mode is silent (e.g.
 * options>6 truncates, not 400; message-type mismatches sometimes
 * succeed but render wrong). Limits we enforce:
 *   - inline buttons: max 6 options (matches PR #62 backend limit + the
 *     `inline_buttons_shipped` memory).
 *
 * `BgosOutbound` is the canonical export used everywhere; `BGOSOutbound`
 * is kept as an alias for the brief moment in PR #82 where the scaffold
 * named it that way (so existing imports don't break).
 */

/** Backend rejects inline messages with >6 options. */
const INLINE_OPTION_LIMIT = 6;

export class BgosOutbound {
  /** Public read-only handle on the underlying REST client; consumers
   *  occasionally need it (e.g. inbound-handler routes uploadFile through
   *  publishMediaPath). */
  readonly api: BgosApi;

  constructor(api: BgosApi) {
    this.api = api;
  }

  // -------------------------------------------------------------------
  // Text + buttons
  // -------------------------------------------------------------------

  sendText(params: {
    assistantId: number;
    chatId: number;
    text: string;
    fromAgent?: FromAgentInput;
  }): Promise<{ id: number }> {
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      messageType: "standard",
      ...(params.fromAgent ? { fromAgent: params.fromAgent } : {}),
    };
    return this.api.postMessage(payload);
  }

  /**
   * Send a text message stamped with an inline-agent identity.
   *
   * Each call produces a distinct bubble in the BGOS UI labeled with the
   * supplied name / color / avatar — used by Gobot's `/board` so the
   * Research, Finance, Strategy, etc. agents each render as their own
   * sender even though they share one bound assistant.
   *
   * The backend's hybrid resolver tries `peerId` (registry id) →
   * `assistantId` (cross-assistant peer) → `externalId` (string lookup),
   * falling back to inline `{name,color,avatarUrl}` when no peer is found.
   * For Gobot, pass `name` + `color` (and optionally `avatarUrl`) — the
   * inline path is what we need.
   */
  sendAsAgent(params: {
    assistantId: number;
    chatId: number;
    text: string;
    agent: FromAgentInput;
    options?: MessageOption[];
  }): Promise<{ id: number }> {
    if (
      params.options !== undefined &&
      params.options.length > INLINE_OPTION_LIMIT
    ) {
      throw new Error(
        `sendAsAgent: ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      messageType: "standard",
      fromAgent: params.agent,
      ...(params.options ? { options: params.options } : {}),
    };
    return this.api.postMessage(payload);
  }

  sendButtons(params: {
    assistantId: number;
    chatId: number;
    text: string;
    options: MessageOption[];
  }): Promise<{ id: number }> {
    if (params.options.length > INLINE_OPTION_LIMIT) {
      // Throw rather than truncate — the agent should be told it sent
      // too many options so it can re-emit. (Hermes truncates with a
      // warning because the agent gets the buttons via a regex in its
      // text; we have a typed call here so the contract is firmer.)
      throw new Error(
        `sendButtons: ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      options: params.options,
      messageType: "standard",
    };
    return this.api.postMessage(payload);
  }

  // -------------------------------------------------------------------
  // Approval bubbles
  // -------------------------------------------------------------------

  /**
   * Render an approval request bubble.
   *
   * Callback layout: `ea:<decision>:<reqId>` matching Telegram parity
   * (Hermes uses the same prefix). Decisions: `once|session|always|deny`.
   *
   * Default options cover the standard 4-button bubble. Pass `options`
   * explicitly to override (e.g. for a smaller agreement flow).
   */
  sendApprovalRequest(params: {
    assistantId: number;
    chatId: number;
    text: string;
    meta: ApprovalMeta;
    options?: MessageOption[];
  }): Promise<{ id: number }> {
    const reqId = params.meta.request_id;
    const defaults: MessageOption[] = [
      {
        text: "Allow once",
        callbackData: `ea:once:${reqId}`,
        style: "success",
      },
      {
        text: "Allow for session",
        callbackData: `ea:session:${reqId}`,
        style: "success",
      },
      {
        text: "Always allow",
        callbackData: `ea:always:${reqId}`,
        style: "default",
      },
      { text: "Deny", callbackData: `ea:deny:${reqId}`, style: "danger" },
    ];
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.text,
      options: params.options ?? defaults,
      messageType: "approval_request",
      approvalMeta: params.meta,
    };
    return this.api.postMessage(payload);
  }

  // -------------------------------------------------------------------
  // ask_user_input pop-under (modal or inline)
  // -------------------------------------------------------------------

  /**
   * Send an `ask_user_input` prompt.
   *
   * `modal=true` (BGOS default for `ask_user_input`) renders as a
   * pop-over sheet. `modal=false` renders as inline buttons that don't
   * intrude. Use modal only when the user just messaged (~2 min) — see
   * agent hints + the canonical capability doc.
   *
   * Today the backend's `messageType: 'ask_user_input'` carries `options`
   * directly. If the canonical capability doc later splits askId/askOrder
   * out, this method gains those args — for now we keep the surface
   * minimal.
   */
  sendAskUserInput(params: {
    assistantId: number;
    chatId: number;
    prompt: string;
    options?: MessageOption[];
    modal?: boolean;
  }): Promise<{ id: number }> {
    if (
      params.options &&
      params.options.length > INLINE_OPTION_LIMIT &&
      params.modal === false
    ) {
      throw new Error(
        `sendAskUserInput (inline): ${params.options.length} options exceeds inline limit (${INLINE_OPTION_LIMIT})`,
      );
    }
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.prompt,
      // The backend's messageType union doesn't include "ask_user_input"
      // in the OutboundMessagePayload type today — but the wire format
      // accepts it (the canonical capability doc documents it). Cast to
      // sidestep the union, mirroring how Hermes handles this.
      messageType: "ask_user_input" as OutboundMessagePayload["messageType"],
      options: params.options,
    };
    return this.api.postMessage(payload);
  }

  // -------------------------------------------------------------------
  // Files / media
  // -------------------------------------------------------------------

  /** Send a file (image, video, document, audio) via the attachment-bridge. */
  async sendFile(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<{ id: number }> {
    const fileRef = await publishMediaPath(this.api, params.filePath, {
      fileName: params.fileName,
      mimeType: params.mimeType,
    });
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: params.caption ?? "",
      messageType: "standard",
      files: [fileRef],
    };
    return this.api.postMessage(payload);
  }

  /** Image — enforces image/* MIME if provided; otherwise lets MIME
   *  inference handle it. */
  sendImage(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<{ id: number }> {
    if (params.mimeType && !params.mimeType.startsWith("image/")) {
      throw new Error(
        `sendImage: mimeType ${params.mimeType} is not image/*`,
      );
    }
    return this.sendFile(params);
  }

  /** Video — enforces video/* MIME if provided. */
  sendVideo(params: {
    assistantId: number;
    chatId: number;
    filePath: string;
    caption?: string;
    fileName?: string;
    mimeType?: string;
  }): Promise<{ id: number }> {
    if (params.mimeType && !params.mimeType.startsWith("video/")) {
      throw new Error(
        `sendVideo: mimeType ${params.mimeType} is not video/*`,
      );
    }
    return this.sendFile(params);
  }

  // -------------------------------------------------------------------
  // Errors + typing
  // -------------------------------------------------------------------

  sendAgentError(params: {
    assistantId: number;
    chatId: number;
    reason: string;
  }): Promise<{ id: number }> {
    const payload: OutboundMessagePayload = {
      assistantId: params.assistantId,
      chatId: params.chatId,
      sender: "assistant",
      text: `⚠ Agent error: ${params.reason}`,
      messageType: "agent_error",
    };
    return this.api.postMessage(payload);
  }

  /**
   * Send a "typing..." indicator. Best-effort — the backend doesn't yet
   * expose a typing endpoint for the integrations channel, so this
   * resolves immediately. Method is here so the adapter's interface
   * doesn't change later when the endpoint lands; callers should not
   * await it for correctness.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendTyping(_params: {
    assistantId: number;
    chatId: number;
  }): Promise<void> {
    // No-op; swallow any future errors so we never break a reply path
    // over a typing indicator.
    return;
  }
}

/** Backwards-compatible alias retained for the public API surface. */
export { BgosOutbound as BGOSOutbound };
