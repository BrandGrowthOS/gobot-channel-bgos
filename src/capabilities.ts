/**
 * Capability bootstrap (fetch-on-connect).
 *
 * The BGOS backend owns the machine-readable capability canon and serves it per
 * channel at `GET /api/v1/integrations/capabilities?channel=gobot`. The daemon
 * fetches it once at connect and injects the returned `text` into every
 * dispatch's system prompt (see inbound-handler.ts), so a connected agent always
 * sees the current canon without a daemon release. When the endpoint is
 * unreachable (old backend, network, revoked token, malformed body) the daemon
 * keeps the frozen `BGOS_AGENT_HINTS` copy it shipped with. A fetch failure
 * NEVER hard-fails the daemon.
 *
 * This module holds only PURE helpers (no I/O), so the validate-and-choose and
 * idempotent-append logic is unit-tested; the fetch lives in bgos-api.ts and the
 * per-dispatch injection in inbound-handler.ts.
 */
import { BGOS_AGENT_HINTS } from "./agent-hints.js";

/**
 * The bundled, offline fallback shipped with the daemon. It already carries its
 * own leading separator (see agent-hints.ts), so it is appended to a base system
 * prompt as-is.
 */
export const BUNDLED_AGENT_HINTS = BGOS_AGENT_HINTS;

/** Shape of GET /integrations/capabilities?channel=gobot. */
export interface ServedCapabilities {
  channel: string;
  version: string;
  text: string;
  core: string;
  channelSyntax: string;
}

/**
 * Whether a payload looks like a real BGOS capability canon. The served text
 * opens with "# BGOS Channel Agent Capabilities" and the bundled copy heading is
 * "BGOS Channel - Agent Capabilities"; both carry the two dash-free markers, so
 * matching on both accepts either form while rejecting an empty or garbage body.
 */
export function hasCanonMarkers(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  return text.includes("BGOS Channel") && text.includes("Agent Capabilities");
}

/**
 * Wrap the served canon as an injectable system-prompt addendum. The bundled
 * BGOS_AGENT_HINTS already has a leading separator; the served text does not, so
 * we prepend a dash-free one.
 */
function toInjectableHints(servedText: string): string {
  return "\n\n---\n" + servedText.trim() + "\n";
}

export interface PickedAgentHints {
  /** The addendum to append to the base system prompt. */
  hints: string;
  source: "backend" | "bundled";
}

/**
 * Choose the agent-hints addendum to inject: the served canon when it is present
 * and well-formed, else the bundled fallback. Pure and total (never throws), so
 * the connect path can call it on any input, including a failed fetch (pass
 * null).
 */
export function pickAgentHints(
  fetched: ServedCapabilities | null | undefined,
): PickedAgentHints {
  const served = fetched?.text;
  if (
    typeof served === "string" &&
    served.trim().length > 0 &&
    hasCanonMarkers(served)
  ) {
    return { hints: toInjectableHints(served), source: "backend" };
  }
  return { hints: BUNDLED_AGENT_HINTS, source: "bundled" };
}

/**
 * Append the agent-capability hints to a base system prompt, idempotently. The
 * duplication guard matches BOTH the bundled heading (which uses an em dash) and
 * the served heading (dash-free) by probing for the two dash-free substrings, so
 * we never double-inject regardless of which copy is active.
 */
export function appendAgentHints(base: string, hints: string): string {
  const b = base ?? "";
  if (b.includes("BGOS Channel") && b.includes("Agent Capabilities")) {
    return b;
  }
  return b + hints;
}
