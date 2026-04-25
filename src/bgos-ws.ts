import { io, type Socket } from "socket.io-client";
import { EventEmitter } from "node:events";

import type { BgosApi } from "./bgos-api.js";
import {
  PairingRevokedError,
  type AssistantBoundPayload,
  type AssistantUnboundPayload,
  type CallbackResultPayload,
  type CommandsUpdatedPayload,
  type InboundMessagePayload,
  type PairReadyPayload,
  type PairingRevokedPayload,
  type PluginConfig,
} from "./types.js";

type EventMap = {
  inbound_message: [InboundMessagePayload];
  commands_updated: [CommandsUpdatedPayload];
  pair_ready: [PairReadyPayload];
  assistant_bound: [AssistantBoundPayload];
  assistant_unbound: [AssistantUnboundPayload];
  pairing_revoked: [PairingRevokedPayload];
  callback_result: [CallbackResultPayload];
  error: [Error];
};

/**
 * Socket.IO client against BGOS. Handshake passes pairingToken as a query
 * param; backend validates via bcrypt and joins the client to
 * pairing:<id> + every assistant:<id> the pairing owns.
 *
 * Reconnect: exponential backoff 1s → 30s. On reconnect, the plugin
 * should call triggerBackfill() which hits GET /integrations/inbound?since=...
 * and re-emits missed user messages through the same inbound_message
 * event — callers handle live + backfill identically.
 */
export class BgosWs {
  private readonly emitter = new EventEmitter();
  private socket: Socket | null = null;
  private lastSeenMessageId = 0;
  private reconnectAttempts = 0;
  private manualClose = false;

  constructor(
    private readonly cfg: PluginConfig,
    private readonly api: BgosApi,
  ) {}

  on<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof EventMap>(
    event: K,
    listener: (...args: EventMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  async connect(): Promise<void> {
    this.manualClose = false;
    const socket = io(this.cfg.baseUrl, {
      path: "/socket.io",
      query: { pairingToken: this.cfg.pairingToken },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: this.cfg.reconnect.initialDelayMs,
      reconnectionDelayMax: this.cfg.reconnect.maxDelayMs,
      reconnectionAttempts: Infinity,
    });

    socket.on("connect", () => {
      this.reconnectAttempts = 0;
    });
    socket.on("reconnect", () => void this.triggerBackfill());

    socket.on("inbound_message", (payload: unknown) => {
      const msg = this.normalizeInbound(payload);
      if (!msg) return;
      if (msg.messageId > this.lastSeenMessageId) {
        this.lastSeenMessageId = msg.messageId;
      }
      this.emitter.emit("inbound_message", msg);
    });

    socket.on("commands_updated", (p: unknown) =>
      this.emitter.emit(
        "commands_updated",
        p as CommandsUpdatedPayload,
      ),
    );
    socket.on("pair_ready", (p: unknown) =>
      this.emitter.emit("pair_ready", p as PairReadyPayload),
    );
    socket.on("assistant_bound", (p: unknown) =>
      this.emitter.emit("assistant_bound", p as AssistantBoundPayload),
    );
    socket.on("assistant_unbound", (p: unknown) =>
      this.emitter.emit("assistant_unbound", p as AssistantUnboundPayload),
    );
    socket.on("pairing_revoked", (p: unknown) => {
      this.emitter.emit("pairing_revoked", p as PairingRevokedPayload);
      this.emitter.emit(
        "error",
        new PairingRevokedError("Pairing revoked by backend"),
      );
    });
    socket.on("callback_result", (p: unknown) =>
      this.emitter.emit("callback_result", p as CallbackResultPayload),
    );

    socket.on("connect_error", (err: Error) => {
      this.reconnectAttempts++;
      this.emitter.emit("error", err);
    });

    this.socket = socket;
  }

  /** Explicit reconnect-triggered backfill. Also callable on startup. */
  async triggerBackfill(): Promise<void> {
    try {
      const { messages } = await this.api.inboundSince(this.lastSeenMessageId);
      for (const m of messages) {
        if (m.messageId > this.lastSeenMessageId) {
          this.lastSeenMessageId = m.messageId;
        }
        this.emitter.emit("inbound_message", m);
      }
    } catch (err) {
      this.emitter.emit(
        "error",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  setLastSeen(messageId: number): void {
    if (messageId > this.lastSeenMessageId) {
      this.lastSeenMessageId = messageId;
    }
  }

  disconnect(): void {
    this.manualClose = true;
    this.socket?.disconnect();
    this.socket = null;
  }

  /**
   * Translate the wire-level payload (snake_case) into our camelCase type.
   * Backend already emits camelCase via the helper service, but defensively
   * handle both so we don't drop messages if someone changes the emitter.
   */
  private normalizeInbound(raw: unknown): InboundMessagePayload | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const toInt = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
      return 0;
    };
    const assistantId = toInt(r.assistantId ?? r.assistant_id);
    const chatId = toInt(r.chatId ?? r.chat_id);
    const messageId = toInt(r.messageId ?? r.message_id);
    if (!assistantId || !chatId || !messageId) return null;
    return {
      assistantId,
      chatId,
      messageId,
      userId: String(r.userId ?? r.user_id ?? ""),
      text: String(r.text ?? ""),
      files: Array.isArray(r.files) ? (r.files as InboundMessagePayload["files"]) : [],
      messageType: (r.messageType ?? r.message_type ?? "standard") as
        InboundMessagePayload["messageType"],
      commandName: (r.commandName ?? r.command_name ?? undefined) as
        string | undefined,
      commandArgs: (r.commandArgs ?? r.command_args ?? undefined) as
        string | undefined,
    };
  }
}
