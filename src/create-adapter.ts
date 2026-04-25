import { BGOSAdapter, type BgosConfig } from "./adapter.js";
import type { DispatchFn } from "./inbound-handler.js";

/**
 * Args the fork's loader passes to `createAdapter`. The fork stays
 * channel-agnostic — its dispatch takes a normalized shape — so this
 * factory adapts the BGOS-specific `DispatchFn` onto it.
 */
export interface ForkLoaderOpts {
  getAgentSystemPrompt?: (route: string) => string;
  dispatch: (args: ForkDispatchArgs) => Promise<void>;
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
  };
}
