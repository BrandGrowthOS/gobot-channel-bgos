/**
 * Pure detection of competing Telegram pollers from a `ps` snapshot. No IO.
 *
 * A second process polling the same TELEGRAM_BOT_TOKEN makes Telegram return
 * repeated 409 Conflicts and crash-loops the bot. The most common source is a
 * Claude Code session started with the --channels Telegram plugin. We surface
 * competitors so the shell can offer the single allowed y/n (kill vs keep).
 */
export interface Competitor {
  pid: string;
  command: string;
  source: string;
}

const CLAUDE_CHANNELS = /claude.*--channels|plugin:telegram/i;
const GENERIC_POLLER = /telegram-bot|node-telegram|getUpdates|grammy/i;
// A real competing Gobot actually RUNS the bot entry (bot.ts). A bare mention
// of "gobot" in a path (the install dir, the vendor pkg, our own setup command)
// is not a poller, so require bot.ts here.
const GOBOT_BOT = /\b(?:bun|node)\b[^\n]*\bbot\.ts\b/i;
// Our own tooling is never the competitor: the setup CLI and the vendor package
// name both contain "gobot" but neither polls Telegram.
const OWN_TOOLING = /setup-cli|gobot-channel-bgos/i;

/**
 * Parse `ps -ef` (or `ps -eo pid,command`) output into competitor descriptors.
 * `selfPid` and `selfInstallDir` filter out this install's own processes.
 */
export function parseCompetitorScan(
  psOutput: string,
  opts: { selfPid?: string; selfInstallDir?: string } = {},
): Competitor[] {
  const out: Competitor[] = [];
  const seen = new Set<string>();
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/\bgrep\b/.test(trimmed)) continue;
    // Never flag our own setup CLI or vendor-package invocation.
    if (OWN_TOOLING.test(trimmed) && !GOBOT_BOT.test(trimmed)) continue;

    const m = trimmed.match(/^\s*\S+\s+(\d+)/) ?? trimmed.match(/^(\d+)\s/);
    const pid = m ? m[1] : "";
    if (pid && opts.selfPid && pid === opts.selfPid) continue;

    let source = "";
    if (CLAUDE_CHANNELS.test(trimmed)) source = "claude-code-telegram-channel";
    else if (GOBOT_BOT.test(trimmed)) {
      // Another Gobot bot process. Only a competitor if it is a DIFFERENT
      // install than ours (filter by cwd is the shell's job; here we drop
      // lines that name our own install dir).
      if (opts.selfInstallDir && trimmed.includes(opts.selfInstallDir)) continue;
      source = "other-gobot";
    } else if (GENERIC_POLLER.test(trimmed)) source = "telegram-poller";
    else continue;

    const key = pid || trimmed;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ pid, command: trimmed, source });
  }
  return out;
}
