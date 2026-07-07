import {
  BGOSAdapter,
  type BgosConfig,
  type ButtonClickInfo,
  type FatalInfo,
} from "./adapter.js";
import type { DispatchFn } from "./inbound-handler.js";

/**
 * Args the fork's loader passes to `createAdapter`. The fork stays
 * channel-agnostic — its dispatch takes a normalized shape — so this
 * factory adapts the BGOS-specific `DispatchFn` onto it.
 */
export interface ForkLoaderOpts {
  getAgentSystemPrompt?: (route: string) => string;
  dispatch: (args: ForkDispatchArgs) => Promise<void>;
  /** Called ONCE when the pairing is revoked/rotated (contract C2). */
  onFatal?: (info: FatalInfo) => void;
  /** Called for a non-approval inline-button tap (contract C6). */
  onButtonClick?: (info: ButtonClickInfo) => void | Promise<void>;
}

export interface ForkDispatchArgs {
  agentName: string;
  text: string;
  attachments?: Array<{
    kind: "image" | "video" | "document" | "voice" | "file";
    path?: string;
    url?: string;
    mimeType?: string;
    fileName?: string;
  }>;
  replyHandle: unknown;
  origin: "telegram" | "bgos";
  meta?: Record<string, unknown>;
}

type ForkAttachmentKind = "image" | "video" | "document" | "voice" | "file";

const KIND_VENDOR_TO_FORK: Record<string, ForkAttachmentKind> = {
  photo: "image",
  video: "video",
  document: "document",
  voice: "voice",
};

export interface CreatedAdapter {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /**
   * Set (or clear) an assistant's status line (contract C4). Mirrors
   * `BGOSAdapter.setStatus` so the fork's loader can feature-detect + drive it
   * on the object createAdapter returns. Delegates to the underlying adapter.
   */
  setStatus: (
    assistantId: number,
    body: { statusText: string | null; statusEmoji?: string | null },
  ) => Promise<void>;
  /** Underlying adapter — for the fork to access outbound primitives if needed. */
  raw: BGOSAdapter;
}

/**
 * Construct a BGOSAdapter wired to the fork's normalized dispatch +
 * system-prompt resolver. Returns an object with start/stop matching
 * the fork loader's contract.
 */
export function createAdapter(
  config: BgosConfig,
  opts: ForkLoaderOpts,
): CreatedAdapter {
  const merged: BgosConfig = {
    ...config,
    getSystemPrompt:
      config.getSystemPrompt ?? opts.getAgentSystemPrompt ?? (() => ""),
    ...(opts.onFatal ? { onFatal: opts.onFatal } : {}),
    ...(opts.onButtonClick ? { onButtonClick: opts.onButtonClick } : {}),
  };

  const adapter = new BGOSAdapter(merged);

  const wrapped: DispatchFn = async (args) => {
    await opts.dispatch({
      origin: "bgos",
      agentName: args.agentRoute,
      text: args.text,
      replyHandle: args.replyHandle,
      attachments: (args.attachments ?? []).map((a) => ({
        kind: KIND_VENDOR_TO_FORK[a.kind] ?? "file",
        path: a.localPath,
        fileName: a.fileName,
        mimeType: a.mimeType,
      })),
      meta: {
        assistantId: args.assistantId,
        chatId: args.chatId,
        userId: args.userId,
        systemPrompt: args.systemPrompt,
        messageType: args.messageType,
        command: args.command,
      },
    });
  };
  adapter.setDispatch(wrapped);

  return {
    raw: adapter,
    start: () => adapter.start(),
    stop: () => adapter.stop(),
    setStatus: (assistantId, body) => adapter.setStatus(assistantId, body),
  };
}
