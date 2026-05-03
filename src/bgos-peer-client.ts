/**
 * High-level peer (cross-channel agent-to-agent) client for Gobot.
 *
 * Wraps the raw BgosApi peer endpoints in a typed surface. The fork's
 * dispatch() function receives a `peers` namespace on the ReplyHandle so
 * an agent handler can call peer operations without ever touching HTTP.
 *
 * See `docs/bgos-agent-capabilities.md` §11 for the canonical wire
 * protocol.
 */
import type { BgosApi } from "./bgos-api.js";
import type {
  PeerCompleteThreadInput,
  PeerEntry,
  PeerInbox,
  PeerSendInput,
  PeerSendResult,
  PeerStatus,
} from "./types.js";

export class BgosPeerClient {
  constructor(private readonly api: BgosApi) {}

  async listPeers(callerAssistantId: number): Promise<PeerEntry[]> {
    const raw = await this.api.listPeers(callerAssistantId);
    return raw.map((r) => normalizePeer(r));
  }

  async peerStatus(
    callerAssistantId: number,
    peerAssistantId: number,
  ): Promise<PeerStatus> {
    const raw = await this.api.peerStatus(callerAssistantId, peerAssistantId);
    return normalizeStatus(raw);
  }

  async sendToPeer(input: PeerSendInput): Promise<PeerSendResult> {
    const raw = await this.api.sendToPeer(input);
    return normalizeSendResult(raw);
  }

  async completePeerThread(
    input: PeerCompleteThreadInput,
  ): Promise<{ closed: boolean; conversationId: number | null }> {
    if (input.peerAssistantId !== undefined) {
      const raw = (await this.api.completePeerThread({
        callerAssistantId: input.callerAssistantId,
        peerAssistantId: input.peerAssistantId,
        summary: input.summary,
      })) as { closed?: boolean; conversationId?: number };
      return {
        closed: raw?.closed ?? true,
        conversationId: raw?.conversationId ?? null,
      };
    }
    if (input.parentMessageId !== undefined) {
      await this.api.completeSideThread({
        callerAssistantId: input.callerAssistantId,
        parentMessageId: input.parentMessageId,
        summary: input.summary ?? "Conversation completed",
      });
      return { closed: true, conversationId: null };
    }
    throw new Error(
      "completePeerThread: pass peerAssistantId or parentMessageId",
    );
  }

  async getSideThread(
    callerAssistantId: number,
    parentMessageId: number,
  ): Promise<unknown> {
    return this.api.getSideThread(callerAssistantId, parentMessageId);
  }

  async getInbox(callerAssistantId: number): Promise<PeerInbox> {
    const raw = (await this.api.getPeerInbox(callerAssistantId)) as
      | { chats?: PeerInbox["chats"] }
      | undefined;
    return { chats: Array.isArray(raw?.chats) ? raw!.chats! : [] };
  }
}

// ─── Normalizers ────────────────────────────────────────────────────────────

function normalizePeer(raw: unknown): PeerEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    assistantId: Number(r.assistantId ?? r.assistant_id ?? 0),
    name: String(r.name ?? `#${r.assistantId ?? r.assistant_id ?? "unknown"}`),
    avatarUrl: (r.avatarUrl ?? r.avatar_url ?? null) as string | null,
    color: (r.color ?? null) as string | null,
    introduced: Boolean(r.introduced ?? false),
    expiresAt: (r.expiresAt ?? r.expires_at ?? null) as string | null,
  };
}

function normalizeStatus(raw: unknown): PeerStatus {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    online: Boolean(r.online ?? false),
    lastSeenAt: (r.lastSeenAt ?? r.last_seen_at ?? null) as string | null,
    hasOpenConversation: Boolean(
      r.hasOpenConversation ?? r.has_open_conversation ?? false,
    ),
    conversationId: (r.conversationId ?? r.conversation_id ?? null) as
      | number
      | null,
    turnHolderId: (r.turnHolderId ?? r.turn_holder_id ?? null) as
      | number
      | null,
  };
}

function normalizeSendResult(raw: unknown): PeerSendResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    status: (r.status ?? "sent") as PeerSendResult["status"],
    sideThreadChatId: (r.sideThreadChatId ?? r.side_thread_chat_id ?? null) as
      | number
      | null,
    messageId: (r.messageId ?? r.message_id ?? null) as number | null,
    conversationId: (r.conversationId ?? r.conversation_id ?? null) as
      | number
      | null,
    turnState: (r.turnState ?? r.turn_state ?? null) as
      | PeerSendResult["turnState"]
      | null,
    reply: (r.reply ?? null) as PeerSendResult["reply"] | null,
  };
}

// ─── Marker parser for agent-emitted peer directives ────────────────────────
//
// The agent embeds these in its reply text:
//
//   [[BGOS_PEER_SEND name="Hades" text="..." wait="false" turn="expecting_reply"]]
//   [[BGOS_PEER_COMPLETE summary="..."]]
//
// The Gobot adapter strips them from the user-visible text before
// posting, then dispatches them after the reply lands. This mirrors
// the Hermes adapter's [[BGOS_PEER_SEND]] / [[BGOS_PEER_COMPLETE]]
// syntax exactly so an agent author can target both channels with the
// same prompt template.

const _PEER_SEND_RE = /\[\[BGOS_PEER_SEND([^\]]*)\]\]/gi;
const _PEER_COMPLETE_RE = /\[\[BGOS_PEER_COMPLETE([^\]]*)\]\]/gi;
const _ATTR_RE = /(\w+)\s*=\s*"((?:\\"|[^"])*)"/g;

export interface ParsedPeerDirectives {
  cleaned: string;
  sends: Array<Record<string, string>>;
  completes: Array<Record<string, string>>;
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  _ATTR_RE.lastIndex = 0;
  while ((m = _ATTR_RE.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2].replace(/\\"/g, '"');
  }
  return out;
}

export function extractPeerDirectives(reply: string): ParsedPeerDirectives {
  const sends: Array<Record<string, string>> = [];
  const completes: Array<Record<string, string>> = [];
  let m: RegExpExecArray | null;
  _PEER_SEND_RE.lastIndex = 0;
  while ((m = _PEER_SEND_RE.exec(reply)) !== null) {
    sends.push(parseAttrs(m[1] ?? ""));
  }
  _PEER_COMPLETE_RE.lastIndex = 0;
  while ((m = _PEER_COMPLETE_RE.exec(reply)) !== null) {
    completes.push(parseAttrs(m[1] ?? ""));
  }
  if (sends.length === 0 && completes.length === 0) {
    return { cleaned: reply, sends, completes };
  }
  let cleaned = reply.replace(_PEER_SEND_RE, "");
  cleaned = cleaned.replace(_PEER_COMPLETE_RE, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, sends, completes };
}
