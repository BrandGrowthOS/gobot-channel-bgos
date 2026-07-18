/**
 * Pure composition + merge of the managed GOBOT env block. No IO.
 *
 * The setup subcommand owns only the lines emitted below. Every other line,
 * including BGOS_AUTO_UPDATE and custom endpoint settings, is preserved on a
 * re-run so setup never changes an operator's opt-in decision.
 */
import type { HomeChannel } from "./args.js";

export const MANAGED_HEADER =
  "# Gobot + BGOS integration (managed by gobot-channel-bgos setup)";

export interface EnvBlockOptions {
  homeChannel: HomeChannel;
  agents: string;
  pollInterval: number;
  /** Absolute GOBOT_HOME override. Omitted when the default ~/.gobot is used. */
  gobotHome?: string;
}

/** Build the managed env block (the lines setup owns). */
export function composeEnvBlock(opts: EnvBlockOptions): string {
  const lines = [MANAGED_HEADER];
  if (opts.gobotHome) lines.push(`GOBOT_HOME=${opts.gobotHome}`);
  lines.push(`GOBOT_HOME_CHANNEL=${opts.homeChannel}`);
  lines.push(`GOBOT_AGENTS=${opts.agents}`);
  lines.push(`GOBOT_POLL_INTERVAL=${opts.pollInterval}`);
  return lines.join("\n") + "\n";
}

const MANAGED_LINE =
  /^\s*(GOBOT_HOME|GOBOT_HOME_CHANNEL|GOBOT_AGENTS|GOBOT_POLL_INTERVAL)\s*=/;
const MANAGED_COMMENT = /^# Gobot \+ BGOS integration/;

/**
 * Merge the managed block into an existing `.env`, stripping any previous
 * managed lines (and the managed comment header) while keeping every foreign
 * line. Idempotent: merging twice yields the same result.
 */
export function mergeEnvFile(existing: string, block: string): string {
  const kept = existing
    .split("\n")
    .filter((line) => !MANAGED_LINE.test(line) && !MANAGED_COMMENT.test(line));

  // Trim trailing blank lines from the kept content.
  while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();

  const head = kept.length ? kept.join("\n") + "\n\n" : "";
  return head + block;
}
