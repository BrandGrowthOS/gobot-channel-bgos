import type { BgosOutbound } from "./outbound.js";
import type {
  ApprovalMeta,
  CallbackResultPayload,
} from "./types.js";

/**
 * Approval request / response bridge.
 *
 * When an OpenClaw agent requests consent (native approval flow), call
 * requestApproval(...). It POSTs an approval_request message to BGOS and
 * returns a promise that resolves when the user clicks Approve/Deny via
 * the corresponding callback_result WS event.
 *
 * Correlation happens via ApprovalMeta.request_id, embedded into each
 * option's callback_data as `ea:<decision>:<req_id>` (Telegram parity). The
 * legacy `__approval__:<decision>:<req_id>` form is still accepted for compat.
 * handleCallbackResult(...) is the wiring hook for the WS inbound_click lane.
 */

export type ApprovalDecision = "approve" | "deny";

export interface PendingApproval {
  requestId: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

export class ApprovalHandler {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(private readonly outbound: BgosOutbound) {}

  /**
   * Post an approval_request and wait for Approve/Deny.
   * Resolves with the decision or rejects after `timeoutMs` (default 30 min).
   */
  requestApproval(params: {
    assistantId: number;
    chatId: number;
    text: string;
    meta: ApprovalMeta;
    timeoutMs?: number;
  }): Promise<ApprovalDecision> {
    // Register the pending entry SYNCHRONOUSLY so a callback that arrives
    // before the POST resolves still matches. POST is fired in parallel;
    // if it fails we reject the pending promise.
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const ms = params.timeoutMs ?? 30 * 60 * 1000;
      const timeout = setTimeout(() => {
        this.pending.delete(params.meta.request_id);
        reject(new Error("approval timeout"));
      }, ms);
      this.pending.set(params.meta.request_id, {
        requestId: params.meta.request_id,
        resolve,
        reject,
        timeout,
      });
      this.outbound
        .sendApprovalRequest({
          assistantId: params.assistantId,
          chatId: params.chatId,
          text: params.text,
          meta: params.meta,
        })
        .catch((err) => {
          clearTimeout(timeout);
          this.pending.delete(params.meta.request_id);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  /**
   * Wire this into the WS inbound_click lane. Decodes
   * `ea:<decision>:<req_id>` (or legacy `__approval__:<decision>:<req_id>`)
   * from the option's callback_data and resolves the matching pending
   * approval, if any.
   *
   * The 4-button bubble uses decisions once|session|always|deny; once/session/
   * always all resolve to `approve` (the scope choice is applied by the fork's
   * approval store, not here), and deny resolves to `deny`.
   *
   * Returns true if the payload matched a pending approval, false otherwise
   * (regular button click: caller should route it to the fork's onButtonClick
   * handler; an approval-consumed click is NOT also forwarded).
   */
  handleCallbackResult(
    payload: CallbackResultPayload & { callbackData?: string },
  ): boolean {
    const cb = payload.callbackData;
    if (!cb) return false;
    if (!cb.startsWith("ea:") && !cb.startsWith("__approval__:")) return false;
    const [, decision, reqId] = cb.split(":");
    if (!decision || !reqId) return false;
    const entry = this.pending.get(reqId);
    if (!entry) return false;
    clearTimeout(entry.timeout);
    this.pending.delete(reqId);
    if (decision === "deny") {
      entry.resolve("deny");
    } else if (
      decision === "approve" ||
      decision === "once" ||
      decision === "session" ||
      decision === "always"
    ) {
      entry.resolve("approve");
    } else {
      entry.reject(new Error(`unknown approval decision: ${decision}`));
    }
    return true;
  }

  /** Graceful teardown — rejects all pending. */
  shutdown(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("plugin shutting down"));
    }
    this.pending.clear();
  }
}
