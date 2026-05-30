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
import { randomUUID } from "node:crypto";

import {
  ingestBgosAttachment,
  publishMediaPath,
  type BgosInboundAttachment,
} from "./attachment-bridge.js";
import { buildSystemPromptWithHints } from "./agent-hints.js";
import { saveLastId } from "./last-id-store.js";
import type { BgosOutbound } from "./outbound.js";
import type {
  ApprovalMeta,
  InboundMessagePayload,
  MessageOption,
} from "./types.js";

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
   *  the agent emits structured tool output rather than a `MEDIA:` line.
   *  The `filePath` is validated against the `GOBOT_MEDIA_ROOT` allowlist
   *  (see media-guard.ts) before any bytes are read — paths outside the
   *  root, traversal, escaping symlinks, and sensitive locations throw. */
  uploadFile: (
    filePath: string,
    opts?: { fileName?: string; mimeType?: string },
  ) => Promise<{ fileName: string; fileMimeType: string; size: number }>;
  /**
   * Record that a tool just started executing in the current agent turn.
   * The plugin emits a live `tool_progress` card in BGOS — POSTing on the
   * first call per turn, PATCHing on subsequent calls (debounced).
   *
   * Gobot fork wiring: call this from `callClaudeStreaming`'s `onToolStart`
   * hook on the BGOS dispatch path:
   *
   *   onToolStart: (toolName) => replyHandle.sendToolStart(toolName)
   *
   * No-op when the adapter wasn't constructed with a tool-progress
   * orchestrator (old host code) — safe to call unconditionally.
   * `args` is optional, ≤120 chars (truncated by the plugin).
   */
  sendToolStart: (toolName: string, args?: string) => Promise<void>;
  /**
   * End-of-turn signal — transitions the active tool_progress card from
   * state="running" to "done" so the frontend auto-collapses it. The
   * fork should call this AFTER the agent's text reply has been sent
   * via `sendText` (or even if the turn ends without a reply). Idempotent
   * — safe to call multiple times. No-op when no card exists for this
   * chat (turn used no tools).
   */
  finalizeTurn: () => Promise<void>;
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
  /** Tool-progress card orchestrator — adapter-provided. The factory
   *  wires `replyHandle.sendToolStart` + `replyHandle.finalizeTurn`
   *  through this. Optional for back-compat; older host code that
   *  doesn't call these methods continues to work, just without cards. */
  toolProgress?: import("./tool-progress.js").ToolProgressOrchestrator;
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

    // Build the BGOS-scoped ReplyHandle. Closure-captures the outbound
    // adapter + identifiers so the agent code never needs to know the
    // chat/assistant ids — it just calls `replyHandle.sendText("...")`.
    const replyHandle: ReplyHandle = {
      origin: "bgos",
      sendText: (text) =>
        deps.outbound.sendText({
          assistantId: event.assistantId,
          chatId: event.chatId,
          text,
        }),
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
          // SECURITY: ignore any agent-supplied request_id and mint a
          // fork-generated UUID. The request_id keys the approval-callback
          // correlation map (ea:<decision>:<reqId>); an agent that picks
          // its own value could collide with another in-flight approval
          // and steal/clobber its decision. A v4 UUID is collision-free.
          meta: { ...meta, request_id: randomUUID() },
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
      // tool_progress wiring — gracefully no-ops when older host code
      // constructed the adapter without an orchestrator. New host code
      // (fork v2026-05-16+) passes the orchestrator via adapter.toolProgress.
      sendToolStart: async (toolName, args) => {
        if (!deps.toolProgress) return;
        await deps.toolProgress.sendToolStart({
          assistantId: event.assistantId,
          chatId: event.chatId,
          toolName,
          args,
        });
      },
      finalizeTurn: async () => {
        if (!deps.toolProgress) return;
        await deps.toolProgress.finalizeTurn(event.chatId);
      },
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
