import { describe, expect, it } from "vitest";

import { competitorPrompt, formatSuccessLine } from "../src/setup/messages.js";

describe("formatSuccessLine", () => {
  it("summarizes the connected install", () => {
    const line = formatSuccessLine({
      installDir: "/Users/kc/src/gobot-bgos",
      agentCount: 8,
      supervisor: "launchd",
      homeChannel: "both",
      paired: true,
    });
    expect(line).toContain("8 agents");
    expect(line).toContain("launchd");
    expect(line).toContain("home channel both");
  });

  it("uses singular for one agent", () => {
    const line = formatSuccessLine({
      installDir: "/x",
      agentCount: 1,
      supervisor: "systemd",
      homeChannel: "bgos",
      paired: true,
    });
    expect(line).toContain("1 agent ");
    expect(line).not.toContain("1 agents");
  });
});

describe("competitorPrompt", () => {
  it("names the pid and the single y/N choice", () => {
    const p = competitorPrompt({
      pid: "4521",
      command: "node claude --channels telegram",
      source: "claude-code-telegram-channel",
    });
    expect(p).toContain("4521");
    expect(p).toContain("[y/N]");
  });
});
