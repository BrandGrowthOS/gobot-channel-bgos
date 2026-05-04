/**
 * Translate a BGOS WS `inbound_message` into a `dispatch()` call against
 * Gobot's existing per-agent handler.
 *
 * The fork wires this up: at boot the fork calls `adapter.setDispatch(fn)`
 * with a closure that runs Gobot's `processMessageForAgent` (or
 * equivalent) and uses the supplied `replyHandle` for any outbound
 * action. `dispatch` is dependency-injected because the fork has access
 * to Gobot's internal types we deliberately do not import here — keeping
 * this vendor package free of any dependency on the upstream Gobot
 * source so it stays npm-installable on its own.
 *
 * What this module owns:
 *   - Looking up `agent_route` from `assistant_id` via the adapter's map
 *   - Translating BGOS attachments into local file paths via
 *     `attachment-bridge`
 *   - Building a `ReplyHandle` scoped to BGOS (calls back through the
 *     `BgosOutbound` instance, never Telegram)
 *   - Persisting `last_id` BEFORE dispatch so a crash inside the agent
 *     handler doesn't infinite-loop the cursor
 *   - Injecting `BGOS_AGENT_HINTS` into the system prompt before
 *     dispatching
 */
import {
  ingestBgosAttachment,
  publishMediaPath,
  type BgosInboundAttachment,
} from "./attachment-bridge.js";
import { buildSystemPromptWithHints } from "./agent-hints.js";
import {
  BgosPeerClient,
  extractPeerDirectives,
} from "./bgos-peer-client.js";
import { BRIDGE_LOCAL_COMMAND_NAMES } from "./default-commands.js";
import { saveLastId } from "./last-id-store.js";
import type { BgosOutbound } from "./outbound.js";
import type {
  ApprovalMeta,
  InboundMessagePayload,
  MessageOption,
  PeerCompleteThreadInput,
  PeerEntry,
  PeerSendInput,
  PeerSendResult,
  PeerStatus,
} from "./types.js";

/**
 * Peer (cross-channel a2a) namespace exposed on the ReplyHandle. Lets a
 * Gobot agent handler discover, message, and synthesize with the user's
 * other BGOS assistants without ever touching HTTP. See
 * `docs/bgos-agent-capabilities.md` §11.
 *
 * `parentMessageId` for `send` is normally provided by the agent (the id
 * of its own "Looping in <peer>..." reply) — without one, the side-thread
 * card has nothing to anchor to. The handler does NOT auto-create an
 * anchor message: that's a UX decision the agent owns. The bridge-local
 * `/peer-send` does auto-create one for ergonomics; the programmatic
 * surface is more explicit.
 */
export interface PeerHandle {
  list(): Promise<PeerEntry[]>;
  status(input: { peerAssistantId: number }): Promise<PeerStatus>;
  send(input: Omit<PeerSendInput, "callerAssistantId">): Promise<PeerSendResult>;
  complete(
    input: Omit<PeerCompleteThreadInput, "callerAssistantId">,
  ): Promise<{ closed: boolean; conversationId: number | null }>;
}

/**
 * Reply handle the fork's `processMessageForAgent` calls into.
 *
 * Mirrors the Telegram side (which the fork builds in
 * `src/adapters/bgos/reply-handle.ts`) so a single agent handler can
 * speak to either origin without branching internally. Methods are
 * Promise-returning so the fork can await delivery confirmation when it
 * cares.
 */
export interface ReplyHandle {
  origin: "bgos";
  sendText: (text: string) => Promise<{ id: number }>;
  sendButtons: (
    text: string,
    options: MessageOption[],
  ) => Promise<{ id: number }>;
  sendApprovalRequest: (
    text: string,
    meta: ApprovalMeta,
  ) => Promise<{ id: number }>;
  sendAskUserInput: (
    prompt: string,
    options?: MessageOption[],
    modal?: boolean,
  ) => Promise<{ id: number }>;
  sendFile: (
    filePath: string,
    caption?: string,
  ) => Promise<{ id: number }>;
  sendImage: (
    filePath: string,
    caption?: string,
  ) => Promise<{ id: number }>;
  sendVideo: (
    filePath: string,
    caption?: string,
  ) => Promise<{ id: number }>;
  sendTyping: () => Promise<void>;
  /** Publish a local file path to BGOS as a `files[]` entry; useful when
   *  the agent emits structured tool output rather than a `MEDIA:` line. */
  uploadFile: (
    filePath: string,
    opts?: { fileName?: string; mimeType?: string },
  ) => Promise<{ fileName: string; fileMimeType: string; size: number }>;
  /** Peer (cross-channel a2a) operations. See PeerHandle for the four
   *  methods. The `callerAssistantId` is closure-captured here so the
   *  agent doesn't have to thread it through every call. */
  peers: PeerHandle;
}

/**
 * Args the fork's dispatch function receives. Kept deliberately flat
 * and dependency-free so the fork can adapt them onto whatever shape
 * Gobot's internal pipeline expects.
 */
export interface DispatchArgs {
  origin: "bgos";
  agentRoute: string;
  assistantId: number;
  chatId: number;
  userId: string;
  text: string;
  /** Local file paths the user attached (already downloaded). Empty
   *  when the user only sent text. */
  attachments: Array<{
    localPath: string;
    fileName: string;
    mimeType: string;
    kind: "photo" | "video" | "document" | "voice";
  }>;
  /** Append to the agent's existing system prompt (hints injection
   *  happens here so every dispatch carries them). */
  systemPrompt: string;
  /** Reply handle scoped to BGOS — the agent only talks back via this. */
  replyHandle: ReplyHandle;
  /** Slash-command metadata if `messageType==='slash_command'`. */
  command?: { name: string; args: string };
  messageType: InboundMessagePayload["messageType"];
}

export type DispatchFn = (args: DispatchArgs) => Promise<void>;

export interface InboundHandlerDeps {
  outbound: BgosOutbound;
  /** Map an assistant id to the bound agent route. Adapter-provided. */
  getRouteForAssistant(assistantId: number): string | null;
  /** The fork-supplied dispatch function. May be `null` until the fork
   *  calls `setDispatch(fn)` — early WS messages then no-op safely. */
  getDispatch(): DispatchFn | null;
  /** Optional system-prompt prefix (e.g. agent persona). The handler
   *  appends `BGOS_AGENT_HINTS` to whatever this returns. */
  getSystemPrompt?(agentRoute: string): string;
}

/**
 * Build the inbound-event handler. Returns an async function the
 * adapter wires onto `BgosWs`'s `inbound_message` event.
 */
export function createInboundHandler(
  deps: InboundHandlerDeps,
): (event: InboundMessagePayload) => Promise<void> {
  return async function handleInbound(event): Promise<void> {
    const route = deps.getRouteForAssistant(event.assistantId);
    if (!route) {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] inbound for unknown assistant_id=" +
          event.assistantId +
          " — dropping",
      );
      return;
    }

    // Persist the cursor BEFORE dispatch. A crash inside the agent
    // handler should not cause an infinite replay on restart (matches
    // Hermes behavior — see hermes_integration_shipped.md).
    saveLastId(event.messageId);

    // Bridge-local intercept — `/new`, `/retry`, `/status`, `/peers`,
    // `/peer-status`, `/peer-send`, `/peer-complete`. Handled by the
    // adapter; never reach the agent. Mirrors the Hermes adapter's pattern.
    if (
      event.messageType === "slash_command" &&
      event.commandName &&
      BRIDGE_LOCAL_COMMAND_NAMES.has(event.commandName.toLowerCase())
    ) {
      await handleBridgeLocalCommand({
        outbound: deps.outbound,
        peerClient: new BgosPeerClient(deps.outbound.api),
        assistantId: event.assistantId,
        chatId: event.chatId,
        command: event.commandName.toLowerCase(),
        args: event.commandArgs ?? "",
      });
      return;
    }

    // Translate BGOS attachments to local file paths. Failures are
    // surfaced as a single agent_error and the message is still
    // dispatched without attachments — better degraded behavior than
    // dropping the user's text entirely.
    const attachments: DispatchArgs["attachments"] = [];
    for (const f of event.files ?? []) {
      try {
        const ingested = await ingestBgosAttachment(
          f as unknown as BgosInboundAttachment,
        );
        attachments.push({
          localPath: ingested.localPath,
          fileName: (f.filename || "attachment") as string,
          mimeType: ingested.mimeType,
          kind: ingested.kind,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          "[gobot-channel-bgos] attachment ingest failed for " +
            (f.filename || "<unnamed>") +
            ": " +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // Peer (a2a) handle — closure-captures the caller assistant id so
    // the agent code doesn't have to thread it through every call.
    const peerClient = new BgosPeerClient(deps.outbound.api);
    const peerHandle: PeerHandle = {
      list: () => peerClient.listPeers(event.assistantId),
      status: ({ peerAssistantId }) =>
        peerClient.peerStatus(event.assistantId, peerAssistantId),
      send: (input) =>
        peerClient.sendToPeer({
          ...input,
          callerAssistantId: event.assistantId,
        }),
      complete: (input) =>
        peerClient.completePeerThread({
          ...input,
          callerAssistantId: event.assistantId,
        }),
    };

    // Track the most recent open peer conversation per chat for the
    // [[BGOS_PEER_COMPLETE]] marker (which doesn't carry the peer id).
    let trackedPeerForChat:
      | { peerAssistantId: number; conversationId: number }
      | null = null;

    /** Wrap deps.outbound.sendText so it auto-extracts inline peer
     *  collaboration markers from the agent's reply text. The user-
     *  visible reply is the cleaned text; markers are dispatched AFTER
     *  the post (so the SideConversationCard has a parent to anchor to). */
    const sendTextWithPeerMarkers = async (
      text: string,
    ): Promise<{ id: number }> => {
      const { cleaned, sends, completes } = extractPeerDirectives(text);
      const sent = await deps.outbound.sendText({
        assistantId: event.assistantId,
        chatId: event.chatId,
        text: cleaned || text,
      });
      if (sends.length === 0 && completes.length === 0) return sent;
      // Dispatch in order. Failures are surfaced as a follow-up assistant
      // message rather than thrown; never crash the reply path.
      for (const attrs of sends) {
        try {
          const nameOrId = attrs.name ?? attrs.id ?? "";
          if (!nameOrId || !attrs.text) {
            continue;
          }
          let peer: PeerEntry | null = null;
          if (/^\d+$/.test(nameOrId)) {
            peer = {
              assistantId: Number(nameOrId),
              name: `#${nameOrId}`,
              introduced: false,
            };
          } else {
            const list = await peerClient.listPeers(event.assistantId);
            peer = list.find(
              (p) => p.name.toLowerCase() === nameOrId.toLowerCase(),
            ) ?? null;
          }
          if (!peer) continue;
          const result = await peerClient.sendToPeer({
            callerAssistantId: event.assistantId,
            targetAssistantId: peer.assistantId,
            text: attrs.text,
            parentMessageId: sent.id,
            waitForReply: (attrs.wait ?? "false").toLowerCase() === "true",
            turnState: attrs.turn as
              | "expecting_reply"
              | "more_coming"
              | "final"
              | undefined,
          });
          if (result.status === "requires_introduction") {
            await deps.outbound.sendText({
              assistantId: event.assistantId,
              chatId: event.chatId,
              text: `**Cannot send to ${peer.name}** — the user has not enabled this direction in the BGOS Agent Permissions matrix.`,
            });
            continue;
          }
          if (result.conversationId) {
            trackedPeerForChat = {
              peerAssistantId: peer.assistantId,
              conversationId: result.conversationId,
            };
          }
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await deps.outbound
            .sendText({
              assistantId: event.assistantId,
              chatId: event.chatId,
              text: `**Peer send failed:** ${reason}`,
            })
            .catch(() => {});
        }
      }
      for (const attrs of completes) {
        if (!trackedPeerForChat) continue;
        try {
          await peerClient.completePeerThread({
            callerAssistantId: event.assistantId,
            peerAssistantId: trackedPeerForChat.peerAssistantId,
            summary: attrs.summary || undefined,
          });
          trackedPeerForChat = null;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await deps.outbound
            .sendText({
              assistantId: event.assistantId,
              chatId: event.chatId,
              text: `**Peer complete failed:** ${reason}`,
            })
            .catch(() => {});
        }
      }
      return sent;
    };

    // Build the BGOS-scoped ReplyHandle. Closure-captures the outbound
    // adapter + identifiers so the agent code never needs to know the
    // chat/assistant ids — it just calls `replyHandle.sendText("...")`.
    const replyHandle: ReplyHandle = {
      origin: "bgos",
      sendText: sendTextWithPeerMarkers,
      sendButtons: (text, options) =>
        deps.outbound.sendButtons({
          assistantId: event.assistantId,
          chatId: event.chatId,
          text,
          options,
        }),
      sendApprovalRequest: (text, meta) =>
        deps.outbound.sendApprovalRequest({
          assistantId: event.assistantId,
          chatId: event.chatId,
          text,
          meta,
        }),
      sendAskUserInput: (prompt, options, modal) =>
        deps.outbound.sendAskUserInput({
          assistantId: event.assistantId,
          chatId: event.chatId,
          prompt,
          options,
          modal,
        }),
      sendFile: (filePath, caption) =>
        deps.outbound.sendFile({
          assistantId: event.assistantId,
          chatId: event.chatId,
          filePath,
          caption,
        }),
      sendImage: (filePath, caption) =>
        deps.outbound.sendImage({
          assistantId: event.assistantId,
          chatId: event.chatId,
          filePath,
          caption,
        }),
      sendVideo: (filePath, caption) =>
        deps.outbound.sendVideo({
          assistantId: event.assistantId,
          chatId: event.chatId,
          filePath,
          caption,
        }),
      sendTyping: () =>
        deps.outbound.sendTyping({
          assistantId: event.assistantId,
          chatId: event.chatId,
        }),
      uploadFile: (filePath, opts) =>
        publishMediaPath(deps.outbound.api, filePath, opts),
      peers: peerHandle,
    };

    const dispatch = deps.getDispatch();
    if (!dispatch) {
      // Fork hasn't installed the dispatch function yet — log and keep
      // going. The cursor was saved above so this message won't replay
      // on restart; users should ensure dispatch is set before pairing.
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] no dispatch fn registered — message_id=" +
          event.messageId +
          " dropped. Ensure the fork called adapter.setDispatch().",
      );
      return;
    }

    const baseSystemPrompt = deps.getSystemPrompt?.(route) ?? "";
    const systemPrompt = buildSystemPromptWithHints(baseSystemPrompt);

    const command =
      event.messageType === "slash_command"
        ? {
            name: (event.commandName ?? "").toLowerCase(),
            args: event.commandArgs ?? "",
          }
        : undefined;

    try {
      await dispatch({
        origin: "bgos",
        agentRoute: route,
        assistantId: event.assistantId,
        chatId: event.chatId,
        userId: event.userId,
        text: event.text,
        attachments,
        systemPrompt,
        replyHandle,
        command,
        messageType: event.messageType,
      });
    } catch (err) {
      // Fork's dispatch should never throw — but if it does, surface
      // the failure as an `agent_error` so the user sees something
      // rather than a silent dead chat.
      const reason = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(
        "[gobot-channel-bgos] dispatch threw for assistant_id=" +
          event.assistantId +
          ": " +
          reason,
      );
      try {
        await deps.outbound.sendAgentError({
          assistantId: event.assistantId,
          chatId: event.chatId,
          reason,
        });
      } catch {
        /* swallow — best-effort */
      }
    }
  };
}

// ─── Bridge-local handler (adapter-side, never reaches the agent) ───────────
//
// Per-chat tracking for `/peer-complete`. Module-scoped because the
// adapter runs as a singleton inside the Gobot host process; multiple
// handlers all share this map.
const peerConversationByChat = new Map<
  number,
  { peerAssistantId: number; conversationId: number }
>();
/** Last assistant message id we posted, per chat. Used as the
 *  parentMessageId for `/peer-send` so the SideConversationCard has
 *  something to anchor to. */
const lastAssistantMessageByChat = new Map<number, number>();

async function resolvePeerArg(
  peerClient: BgosPeerClient,
  callerAssistantId: number,
  arg: string,
): Promise<PeerEntry | null> {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) {
    return { assistantId: Number(arg), name: `#${arg}`, introduced: false };
  }
  try {
    const list = await peerClient.listPeers(callerAssistantId);
    const target = arg.toLowerCase();
    return list.find((p) => p.name.toLowerCase() === target) ?? null;
  } catch {
    return null;
  }
}

async function handleBridgeLocalCommand(input: {
  outbound: BgosOutbound;
  peerClient: BgosPeerClient;
  assistantId: number;
  chatId: number;
  command: string;
  args: string;
}): Promise<void> {
  const { outbound, peerClient, assistantId, chatId, command, args } = input;
  try {
    if (command === "new") {
      await outbound.sendText({
        assistantId,
        chatId,
        text: "Conversation reset. Next message starts fresh.",
      });
      return;
    }
    if (command === "retry") {
      await outbound.sendText({
        assistantId,
        chatId,
        text: "Retry — re-send your last message manually for now.",
      });
      return;
    }
    if (command === "status") {
      await outbound.sendText({
        assistantId,
        chatId,
        text: `**BGOS adapter status**\n- Open peer conversations: ${peerConversationByChat.size}`,
      });
      return;
    }
    if (command === "peers") {
      const list = await peerClient.listPeers(assistantId);
      if (list.length === 0) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: "No peer assistants on this account.",
        });
        return;
      }
      const lines = ["**Peer assistants:**", ""];
      for (const p of list) {
        const mark = p.introduced ? "✓" : "✗";
        lines.push(`- ${mark} **${p.name}** (id \`${p.assistantId}\`)`);
      }
      lines.push("");
      lines.push(
        "_✓ = introduced. ✗ = enable in BGOS Settings → Agent Permissions._",
      );
      await outbound.sendText({
        assistantId,
        chatId,
        text: lines.join("\n"),
      });
      return;
    }
    if (command === "peer-status") {
      const peer = await resolvePeerArg(peerClient, assistantId, args.trim());
      if (!peer) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: "Usage: `/peer-status <name|id>`. Run `/peers` first.",
        });
        return;
      }
      const status = await peerClient.peerStatus(assistantId, peer.assistantId);
      await outbound.sendText({
        assistantId,
        chatId,
        text:
          `**${peer.name} (#${peer.assistantId}):** ` +
          (status.online ? "🟢 online" : "⚪ offline") +
          `\n- Last seen: ${status.lastSeenAt ?? "never"}\n` +
          `- Open conversation: ${status.hasOpenConversation ? "yes" : "no"}`,
      });
      return;
    }
    if (command === "peer-send") {
      let wait = false;
      let trimmed = args;
      if (trimmed.startsWith("--wait ")) {
        wait = true;
        trimmed = trimmed.slice("--wait ".length);
      } else if (trimmed.endsWith(" --wait")) {
        wait = true;
        trimmed = trimmed.slice(0, -" --wait".length);
      }
      const sep = trimmed.indexOf(" ");
      if (sep === -1) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: "Usage: `/peer-send <name|id> <text>` (append `--wait` to block).",
        });
        return;
      }
      const peer = await resolvePeerArg(
        peerClient,
        assistantId,
        trimmed.slice(0, sep),
      );
      if (!peer) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: `No peer matches \`${trimmed.slice(0, sep)}\`.`,
        });
        return;
      }
      let parentMessageId = lastAssistantMessageByChat.get(chatId);
      if (!parentMessageId) {
        const anchor = await outbound.sendText({
          assistantId,
          chatId,
          text: `Looping in ${peer.name}…`,
        });
        if (anchor?.id) {
          parentMessageId = anchor.id;
          lastAssistantMessageByChat.set(chatId, anchor.id);
        }
      }
      if (!parentMessageId) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: "Could not anchor the side-thread — try a normal reply first.",
        });
        return;
      }
      const result = await peerClient.sendToPeer({
        callerAssistantId: assistantId,
        targetAssistantId: peer.assistantId,
        text: trimmed.slice(sep + 1).trim(),
        parentMessageId,
        waitForReply: wait,
      });
      if (result.status === "requires_introduction") {
        await outbound.sendText({
          assistantId,
          chatId,
          text: `**Cannot send to ${peer.name}** — open BGOS Settings → Agent Permissions to enable this direction first.`,
        });
        return;
      }
      if (result.conversationId) {
        peerConversationByChat.set(chatId, {
          peerAssistantId: peer.assistantId,
          conversationId: result.conversationId,
        });
      }
      const reply = result.reply;
      await outbound.sendText({
        assistantId,
        chatId,
        text: reply
          ? `${peer.name} replied: ${reply.text}`
          : `Sent to ${peer.name} (message \`${result.messageId}\`).`,
      });
      return;
    }
    if (command === "peer-complete") {
      const tracked = peerConversationByChat.get(chatId);
      if (!tracked) {
        await outbound.sendText({
          assistantId,
          chatId,
          text: "No open peer conversation in this chat. Send via `/peer-send` first.",
        });
        return;
      }
      const summary = args.trim() || undefined;
      await peerClient.completePeerThread({
        callerAssistantId: assistantId,
        peerAssistantId: tracked.peerAssistantId,
        summary,
      });
      peerConversationByChat.delete(chatId);
      await outbound.sendText({
        assistantId,
        chatId,
        text: `Closed conversation with peer #${tracked.peerAssistantId}${summary ? `: ${summary}` : "."}`,
      });
      return;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn("[gobot-channel-bgos] bridge-local failed", { command, reason });
    await outbound
      .sendText({
        assistantId,
        chatId,
        text: `**/${command} failed:** ${reason}`,
      })
      .catch(() => {});
  }
}
