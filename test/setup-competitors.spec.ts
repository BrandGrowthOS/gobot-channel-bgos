import { describe, expect, it } from "vitest";

import { parseCompetitorScan } from "../src/setup/competitors.js";

describe("parseCompetitorScan", () => {
  it("flags a Claude Code Telegram channel poller", () => {
    const ps = [
      "kc 4521 1 0 9:00AM ?? 0:03.10 node claude --channels telegram --plugin foo",
      "kc 4599 1 0 9:00AM ?? 0:00.01 grep claude",
    ].join("\n");
    const found = parseCompetitorScan(ps);
    expect(found).toHaveLength(1);
    expect(found[0].pid).toBe("4521");
    expect(found[0].source).toBe("claude-code-telegram-channel");
  });

  it("returns nothing when no poller is present", () => {
    const ps = "kc 100 1 0 9AM ?? 0:00 /usr/bin/some-daemon\n";
    expect(parseCompetitorScan(ps)).toEqual([]);
  });

  it("ignores our own install and our own pid", () => {
    const ps = [
      "kc 4000 1 0 9AM ?? 0:10 bun run /Users/kc/src/gobot-bgos/src/bot.ts",
      "kc 4010 1 0 9AM ?? 0:10 bun run /Users/kc/src/other-gobot/src/bot.ts",
    ].join("\n");
    const found = parseCompetitorScan(ps, {
      selfInstallDir: "/Users/kc/src/gobot-bgos",
      selfPid: "9999",
    });
    expect(found).toHaveLength(1);
    expect(found[0].command).toContain("other-gobot");
    expect(found[0].source).toBe("other-gobot");
  });

  it("does not flag our own setup invocation (path mentions gobot)", () => {
    const ps = [
      "kc 76962 1 0 9AM ?? 0:01 node /Users/kc/Projects/BGOS/gobot-channel-bgos/dist/setup-cli.js setup BGOS-1",
      "kc 76970 1 0 9AM ?? 0:00 bunx gobot-channel-bgos setup BGOS-1 --dry-run",
    ].join("\n");
    expect(parseCompetitorScan(ps)).toEqual([]);
  });

  it("dedupes by pid", () => {
    const line = "kc 7 1 0 9AM ?? 0:10 node telegram-bot getUpdates";
    const found = parseCompetitorScan(line + "\n" + line);
    expect(found).toHaveLength(1);
  });
});
