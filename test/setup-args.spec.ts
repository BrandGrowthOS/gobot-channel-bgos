import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENTS,
  DEFAULT_BASE_URL,
  DEFAULT_PATCH_URL,
  DEFAULT_UPSTREAM_REPO,
  parseSetupArgs,
} from "../src/setup/args.js";

describe("parseSetupArgs", () => {
  it("parses a bare code with all defaults", () => {
    const o = parseSetupArgs(["setup", "BGOS-AB12-CD"], {}, "/home/u");
    expect(o.code).toBe("BGOS-AB12-CD");
    expect(o.dryRun).toBe(false);
    expect(o.assumeYes).toBe(false);
    expect(o.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(o.homeChannel).toBe("both");
    expect(o.agents).toBe(DEFAULT_AGENTS);
    expect(o.pollInterval).toBe(5);
    expect(o.installDir).toBe("/home/u/src/gobot-bgos");
    expect(o.patchUrl).toBe(DEFAULT_PATCH_URL);
    expect(o.upstreamRepo).toBe(DEFAULT_UPSTREAM_REPO);
  });

  it("tolerates no leading setup token", () => {
    const o = parseSetupArgs(["BGOS-XX-01"], {}, "/h");
    expect(o.code).toBe("BGOS-XX-01");
  });

  it("reads flags and strips a trailing slash from base url", () => {
    const o = parseSetupArgs(
      [
        "setup",
        "BGOS-1",
        "--dry-run",
        "--yes",
        "--base-url",
        "https://stg.example.com/",
        "--home-channel",
        "bgos",
        "--agents",
        "general:General",
        "--install-dir",
        "/opt/gobot",
        "--poll-interval",
        "10",
        "--device-label",
        "mini",
      ],
      {},
      "/h",
    );
    expect(o.dryRun).toBe(true);
    expect(o.assumeYes).toBe(true);
    expect(o.baseUrl).toBe("https://stg.example.com");
    expect(o.homeChannel).toBe("bgos");
    expect(o.agents).toBe("general:General");
    expect(o.installDir).toBe("/opt/gobot");
    expect(o.pollInterval).toBe(10);
    expect(o.deviceLabel).toBe("mini");
  });

  it("falls back to env then defaults, and code is optional", () => {
    const o = parseSetupArgs(
      ["setup"],
      {
        GOBOT_HOME_CHANNEL: "telegram",
        GOBOT_AGENTS: "cto:CTO",
        GOBOT_POLL_INTERVAL: "0",
        BGOS_BASE_URL: "https://api.example.com",
      },
      "/h",
    );
    expect(o.code).toBeUndefined();
    expect(o.homeChannel).toBe("telegram");
    expect(o.agents).toBe("cto:CTO");
    expect(o.pollInterval).toBe(0);
    expect(o.baseUrl).toBe("https://api.example.com");
  });

  it("rejects an invalid home channel and a negative poll interval", () => {
    const o = parseSetupArgs(
      ["setup", "BGOS-1", "--home-channel", "sideways", "--poll-interval", "-3"],
      {},
      "/h",
    );
    expect(o.homeChannel).toBe("both");
    expect(o.pollInterval).toBe(5);
  });
});
