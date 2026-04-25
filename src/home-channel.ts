/**
 * Home-channel resolver for proactive (agent-initiated) messages.
 *
 * Background:
 *   Gobot can fire proactive messages that have no inbound origin — cron
 *   wakeups, goal-deadline reminders, multi-agent `/board` results, etc.
 *   For inbound-driven replies the destination is obvious: it's whichever
 *   channel the user wrote in (Telegram or BGOS). For proactive messages
 *   we need a deliberate routing decision.
 *
 *   `GOBOT_HOME_CHANNEL` env var controls the destination:
 *     - `telegram` — send only via Telegram
 *     - `bgos`     — send only via BGOS
 *     - `both`     — fan out to Telegram AND BGOS (default)
 *
 *   `both` is V1's default because the user pays nothing for redundant
 *   delivery and never misses a notification while we tune the routing.
 */
const VALID_VALUES = ["telegram", "bgos", "both"] as const;

export type HomeChannel = (typeof VALID_VALUES)[number];

const DEFAULT: HomeChannel = "both";

/**
 * Read GOBOT_HOME_CHANNEL and return a normalized HomeChannel value.
 *
 * - Empty / unset → default (`'both'`).
 * - Valid value (case-insensitive) → that value.
 * - Anything else → log a one-line warning and return the default.
 *
 * Pure function modulo console.warn — safe to call repeatedly. Resolves
 * the env var on every call so the host can change it without a restart.
 */
export function resolveHomeChannel(): HomeChannel {
  const raw = (process.env.GOBOT_HOME_CHANNEL ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT;
  if ((VALID_VALUES as readonly string[]).includes(raw)) {
    return raw as HomeChannel;
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[gobot-channel-bgos] GOBOT_HOME_CHANNEL=${JSON.stringify(raw)} ` +
      `is not a recognized value (expected one of ${VALID_VALUES.join(
        ", ",
      )}). Falling back to "${DEFAULT}".`,
  );
  return DEFAULT;
}
