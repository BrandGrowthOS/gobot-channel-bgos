import { describe, expect, it } from "vitest";

import {
  composeEnvBlock,
  MANAGED_HEADER,
  mergeEnvFile,
} from "../src/setup/env-block.js";

describe("composeEnvBlock", () => {
  it("emits the managed GOBOT lines", () => {
    const block = composeEnvBlock({
      homeChannel: "both",
      agents: "general:General,cto:CTO",
      pollInterval: 5,
    });
    expect(block).toContain(MANAGED_HEADER);
    expect(block).toContain("GOBOT_HOME_CHANNEL=both");
    expect(block).toContain("GOBOT_AGENTS=general:General,cto:CTO");
    expect(block).toContain("GOBOT_POLL_INTERVAL=5");
    expect(block).not.toContain("GOBOT_HOME=");
    expect(block.endsWith("\n")).toBe(true);
  });

  it("includes GOBOT_HOME only when a custom home is given", () => {
    const block = composeEnvBlock({
      homeChannel: "bgos",
      agents: "x:X",
      pollInterval: 3,
      gobotHome: "/data/.gobot",
    });
    expect(block).toContain("GOBOT_HOME=/data/.gobot");
  });
});

describe("mergeEnvFile", () => {
  const block = composeEnvBlock({
    homeChannel: "both",
    agents: "general:General",
    pollInterval: 5,
  });

  it("preserves foreign lines and never touches the Telegram token", () => {
    const existing =
      "TELEGRAM_BOT_TOKEN=123:abc\nANTHROPIC_API_KEY=sk-xyz\n";
    const merged = mergeEnvFile(existing, block);
    expect(merged).toContain("TELEGRAM_BOT_TOKEN=123:abc");
    expect(merged).toContain("ANTHROPIC_API_KEY=sk-xyz");
    expect(merged).toContain("GOBOT_HOME_CHANNEL=both");
  });

  it("replaces stale managed lines instead of duplicating them", () => {
    const existing =
      "TELEGRAM_BOT_TOKEN=123:abc\n" +
      "# Gobot + BGOS integration (managed by gobot-channel-bgos setup)\n" +
      "GOBOT_HOME_CHANNEL=telegram\n" +
      "GOBOT_AGENTS=old:Old\n" +
      "GOBOT_POLL_INTERVAL=99\n" +
      "BGOS_BASE_URL=https://old\n" +
      "BGOS_AUTO_UPDATE=on\n";
    const merged = mergeEnvFile(existing, block);
    expect(merged.match(/GOBOT_HOME_CHANNEL=/g)).toHaveLength(1);
    expect(merged).toContain("GOBOT_HOME_CHANNEL=both");
    expect(merged).not.toContain("GOBOT_AGENTS=old:Old");
    expect(merged).not.toContain("GOBOT_POLL_INTERVAL=99");
    expect(merged).toContain("BGOS_BASE_URL=https://old");
    expect(merged).toContain("BGOS_AUTO_UPDATE=on");
    expect(merged).toContain("TELEGRAM_BOT_TOKEN=123:abc");
  });

  it("is idempotent", () => {
    const once = mergeEnvFile("TELEGRAM_BOT_TOKEN=t\n", block);
    const twice = mergeEnvFile(once, block);
    expect(twice).toBe(once);
  });
});
