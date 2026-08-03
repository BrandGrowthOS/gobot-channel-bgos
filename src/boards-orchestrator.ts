/**
 * Agent Boards round trip wiring for the Gobot channel (the impure half;
 * the pure parse / plan / format functions live in `boards-marker.ts`).
 *
 * Mirrors the Hermes `bgos_adapter.py` boards lane, adapted to Gobot's
 * shapes:
 *
 *   - INTERCEPTION happens where Gobot's agent replies flow: the
 *     ReplyHandle `sendText` path (see `buildReplyHandle` in
 *     inbound-handler.ts), the equivalent of Hermes `send()`. Blocks are
 *     stripped synchronously; execution and the result turn run in a
 *     tracked background task so the reply path never blocks on REST.
 *     This runs BEFORE `BgosOutbound`'s mission marker stripping and the
 *     two lanes compose: distinct delimiters, boards first, missions on
 *     whatever text survives.
 *   - The RESULT comes back as ONE synthetic system turn dispatched
 *     through the fork-registered DispatchFn with `system: true` and
 *     `messageId: 0`, the mechanism the voice lane's `runBrainTurn`
 *     already uses. The agent keeps its session context and simply
 *     continues; it may emit new blocks in its next reply (chained
 *     queries are intended).
 *   - A per-chat LOOP GUARD counts consecutive board result turns; a real
 *     inbound message or button click resets it (see the reset calls in
 *     inbound-handler.ts and the adapter's routeInboundClick). At the
 *     limit it refuses ONCE with an explanation and then goes QUIET,
 *     because a guard that keeps replying becomes the loop it exists to
 *     stop. The synthetic result turn bypasses the inbound handlers by
 *     construction (a direct dispatch call), so it can never reset its
 *     own guard.
 *   - Backend bodies, denials included, pass through VERBATIM; malformed
 *     blocks are answered with `malformed_request`, never silenced.
 *   - The `attach` op reads a LOCAL file and therefore goes through the
 *     same `resolveAllowedMediaPath` allowlist as every other outbound
 *     file send (media-guard.ts); a path outside the media root answers
 *     `path_not_allowed` and no bytes are read.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

import type { BgosApi } from "./bgos-api.js";
import {
  BOARDS_LOOP_GUARD_LIMIT,
  buildResultTurn,
  parseBoardsBlocks,
  planRequest,
  type BoardsCallResult,
  type BoardsParseError,
  type BoardsRequest,
} from "./boards-marker.js";
import { S3_THRESHOLD } from "./attachment-bridge.js";
import { MediaPathError, resolveAllowedMediaPath } from "./media-guard.js";
import type { DispatchFn, ReplyHandle } from "./inbound-handler.js";

/** 25 MB document cap, same ceiling discipline as outbound media. */
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;

/** Minimal extension to MIME map for attach uploads (mirrors the outbound
 *  media inference; the backend re-validates). */
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".zip": "application/zip",
};

function guessMime(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Everything the orchestrator needs to dispatch a synthetic turn back into
 * the agent for one (assistant, chat). Null when the turn cannot be
 * dispatched (fork dispatch not registered yet, or route unbound); the
 * batch is then logged and dropped, matching the package's existing "no
 * dispatch fn registered" convention.
 */
export interface BoardsTurnContext {
  dispatch: DispatchFn;
  agentRoute: string;
  userId: string;
  systemPrompt: string;
  replyHandle: ReplyHandle;
}

export interface BoardsOrchestratorDeps {
  api: BgosApi;
  getTurnContext(
    assistantId: number,
    chatId: number,
  ): BoardsTurnContext | null;
  log?: (msg: string) => void;
}

/** A locally minted error body (never a backend body). */
function localError(error: string, message: string): BoardsCallResult["body"] {
  return { error, message };
}

export class BoardsOrchestrator {
  private readonly deps: BoardsOrchestratorDeps;
  /** Consecutive board result turns per chat since the last real inbound. */
  private readonly consecutiveResults = new Map<number, number>();
  /** In-flight executor tasks, awaited by flush() (tests + stop()). */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: BoardsOrchestratorDeps) {
    this.deps = deps;
  }

  private log(msg: string): void {
    if (this.deps.log) {
      this.deps.log(msg);
    } else {
      // eslint-disable-next-line no-console
      console.warn("[gobot-channel-bgos] " + msg);
    }
  }

  /**
   * Strip `[[BGOS_BOARDS]]` blocks from one outbound agent reply and, when
   * any are present, schedule their execution in the background. Returns
   * the cleaned visible text; a boards-only reply cleans to "" and the
   * caller must then post nothing (no empty bubble).
   */
  interceptOutbound(
    assistantId: number,
    chatId: number,
    text: string,
  ): { cleanedText: string; hadBlocks: boolean } {
    const { cleanedText, requests, errors } = parseBoardsBlocks(text);
    if (requests.length === 0 && errors.length === 0) {
      return { cleanedText: text, hadBlocks: false };
    }
    const task = this.runBoardsRequests(assistantId, chatId, requests, errors)
      .catch((err) => {
        // Background task, never propagate into the send path.
        this.log(
          "boards request execution failed on chat " +
            chatId +
            ": " +
            (err instanceof Error ? err.message : String(err)),
        );
      });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    return { cleanedText, hadBlocks: true };
  }

  /**
   * A real inbound user interaction (typed message or button click)
   * re-arms board calls for this chat.
   */
  resetLoopGuard(chatId: number): void {
    this.consecutiveResults.delete(chatId);
  }

  /** Await every in-flight executor task (tests and adapter stop()). */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /**
   * Execute one reply's board calls and dispatch the result turn. Every
   * outcome, success, backend denial, malformed block, transport failure,
   * becomes a section of ONE synthetic system turn; backend bodies pass
   * through VERBATIM (the boards denial wording is a leak-proof contract).
   */
  private async runBoardsRequests(
    assistantId: number,
    chatId: number,
    requests: BoardsRequest[],
    errors: BoardsParseError[],
  ): Promise<void> {
    const count = this.consecutiveResults.get(chatId) ?? 0;
    if (count >= BOARDS_LOOP_GUARD_LIMIT) {
      if (count > BOARDS_LOOP_GUARD_LIMIT) {
        // Already refused once; go quiet until real inbound resets the
        // counter, otherwise the refusal itself sustains the loop it
        // exists to stop.
        this.log(
          `boards loop guard: dropping ${requests.length + errors.length} ` +
            `request(s) on chat ${chatId}`,
        );
        return;
      }
      const refusal = localError(
        "loop_guard",
        `more than ${BOARDS_LOOP_GUARD_LIMIT} consecutive board result ` +
          "turns without a user message. No call was executed. Reply to " +
          "the user; board calls resume on the next real inbound message.",
      );
      const refused: BoardsCallResult[] = requests.map((r) => ({
        reqId: r.reqId,
        op: r.op,
        ok: false,
        status: 0,
        body: refusal,
      }));
      if (refused.length === 0) {
        refused.push({
          reqId: "loop",
          op: "parse",
          ok: false,
          status: 0,
          body: refusal,
        });
      }
      this.consecutiveResults.set(chatId, count + 1);
      await this.dispatchResultTurn(
        assistantId,
        chatId,
        buildResultTurn(refused),
      );
      return;
    }

    const results: BoardsCallResult[] = [];
    for (const err of errors) {
      results.push({
        reqId: err.reqId,
        op: "parse",
        ok: false,
        status: 0,
        body: localError("malformed_request", err.message),
      });
    }
    for (const req of requests) {
      results.push(await this.executeRequest(assistantId, req));
    }
    if (results.length === 0) return;
    this.consecutiveResults.set(chatId, count + 1);
    await this.dispatchResultTurn(
      assistantId,
      chatId,
      buildResultTurn(results),
    );
  }

  /**
   * One call, one result. `boardsCall` keeps status + body verbatim for
   * every HTTP answer; anything thrown becomes a transport_error section.
   */
  private async executeRequest(
    assistantId: number,
    req: BoardsRequest,
  ): Promise<BoardsCallResult> {
    try {
      const plan = planRequest(req);
      if (plan.kind === "attach") {
        return await this.executeAttach(assistantId, req);
      }
      const { status, body } = await this.deps.api.boardsCall({
        assistantId,
        method: plan.method,
        path: plan.path,
        json: plan.json,
        params: plan.params,
      });
      return {
        reqId: req.reqId,
        op: req.op,
        ok: status >= 200 && status < 300,
        status,
        body,
      };
    } catch (err) {
      this.log(
        `boards ${req.op} failed on assistant ${assistantId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return {
        reqId: req.reqId,
        op: req.op,
        ok: false,
        status: 0,
        body: localError(
          "transport_error",
          err instanceof Error ? err.constructor.name : String(err),
        ),
      };
    }
  }

  /**
   * Execute an attach op: read the local file, then either the inline
   * content_base64 one-shot (at or under S3_THRESHOLD) or the presigned
   * flow (create meta, PUT bytes, complete). 25 MB document cap, same
   * ceiling discipline as outbound media. `path` is a local file readable
   * by the Gobot host and is validated against the SAME
   * `resolveAllowedMediaPath` allowlist as every other outbound file send
   * (media-guard.ts), so boards attach cannot become an exfiltration
   * route around the media root.
   */
  private async executeAttach(
    assistantId: number,
    req: BoardsRequest,
  ): Promise<BoardsCallResult> {
    const fail = (
      status: number,
      body: BoardsCallResult["body"],
    ): BoardsCallResult => ({
      reqId: req.reqId,
      op: req.op,
      ok: false,
      status,
      body,
    });
    const args = req.args;
    const filePath = String(args.path);
    const board = encodeURIComponent(String(args.board));
    const row = encodeURIComponent(String(args.row));
    let size: number;
    try {
      const st = statSync(filePath);
      if (!st.isFile()) throw new Error("not a file");
      size = st.size;
    } catch {
      return fail(
        0,
        localError("file_not_found", `no readable file at ${filePath}`),
      );
    }
    if (size > ATTACH_MAX_BYTES) {
      return fail(
        0,
        localError("file_too_large", "attachments are capped at 25 MB"),
      );
    }
    // SECURITY: allowlist check BEFORE reading any bytes. Throws on
    // traversal, out-of-root paths, sensitive locations, and escaping
    // symlinks; the resolved real path is what we read from.
    let safePath: string;
    try {
      safePath = resolveAllowedMediaPath(filePath);
    } catch (err) {
      if (err instanceof MediaPathError) {
        return fail(0, localError("path_not_allowed", err.message));
      }
      throw err;
    }
    const data = readFileSync(safePath);
    const name = String(args.name || basename(filePath));
    const mime = String(args.mime || guessMime(name));
    const attachPath = `/${board}/rows/${row}/attachments`;
    const metaBody: Record<string, unknown> = { name, size, mime };
    if (args.fieldKey) metaBody.field_key = args.fieldKey;

    if (size <= S3_THRESHOLD) {
      metaBody.content_base64 = data.toString("base64");
      const { status, body } = await this.deps.api.boardsCall({
        assistantId,
        method: "POST",
        path: attachPath,
        json: metaBody,
      });
      return {
        reqId: req.reqId,
        op: req.op,
        ok: status >= 200 && status < 300,
        status,
        body,
      };
    }

    const meta = await this.deps.api.boardsCall({
      assistantId,
      method: "POST",
      path: attachPath,
      json: metaBody,
    });
    if (meta.status < 200 || meta.status >= 300) {
      return fail(meta.status, meta.body);
    }
    const metaObj = (meta.body ?? {}) as Record<string, unknown>;
    const uploadUrl = metaObj.uploadUrl;
    const attachmentId = metaObj.attachmentId;
    if (typeof uploadUrl !== "string" || !uploadUrl || attachmentId == null) {
      return fail(
        0,
        localError(
          "bad_attach_response",
          "backend returned no presigned upload target",
        ),
      );
    }
    await this.deps.api.putBytes(uploadUrl, data, mime);
    const complete = await this.deps.api.boardsCall({
      assistantId,
      method: "POST",
      path: `/${board}/attachments/${encodeURIComponent(
        String(attachmentId),
      )}/complete`,
      json: {},
    });
    let body = complete.body;
    // Parity with the inline path, whose answer carries the attachmentId:
    // the agent needs the id to mint a download URL later.
    if (
      body !== null &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      !("attachmentId" in (body as Record<string, unknown>))
    ) {
      body = { ...(body as Record<string, unknown>), attachmentId };
    }
    return {
      reqId: req.reqId,
      op: req.op,
      ok: complete.status >= 200 && complete.status < 300,
      status: complete.status,
      body,
    };
  }

  /**
   * Deliver the boards result back into the agent's session as ONE
   * synthetic system turn, the mechanism the voice lane's `runBrainTurn`
   * uses: the fork-registered DispatchFn with a real BGOS ReplyHandle so
   * the agent's continuation (including chained boards blocks) flows
   * through the normal reply path. `system: true` marks the provenance so
   * nothing downstream mistakes it for the human (and `messageId: 0`
   * marks a synthetic turn, the voice-lane convention); the turn text
   * ALSO opens with the [BGOS boards result] header for meta-blind
   * consumers.
   */
  private async dispatchResultTurn(
    assistantId: number,
    chatId: number,
    text: string,
  ): Promise<void> {
    const ctx = this.deps.getTurnContext(assistantId, chatId);
    if (!ctx) {
      this.log(
        `boards result turn dropped for assistant ${assistantId} chat ` +
          `${chatId}: no dispatch context (dispatch not registered or ` +
          "route unbound)",
      );
      return;
    }
    await ctx.dispatch({
      origin: "bgos",
      agentRoute: ctx.agentRoute,
      assistantId,
      chatId,
      messageId: 0,
      userId: ctx.userId,
      text,
      attachments: [],
      systemPrompt: ctx.systemPrompt,
      replyHandle: ctx.replyHandle,
      messageType: "standard",
      system: true,
    });
  }
}
