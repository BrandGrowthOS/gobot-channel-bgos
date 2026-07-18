import { describe, expect, it } from "vitest";

import {
  disableLegacyAutoUpdateArgs,
  forkRelaySetupArgs,
  LAUNCHD_LABEL,
  LEGACY_AUTO_UPDATE_LABEL,
  legacyAutoUpdatePlist,
  pickSupervisor,
  renderLaunchdPlist,
  renderSystemdUnit,
} from "../src/setup/supervisor.js";

describe("private fork supervisor isolation", () => {
  it("configures only the relay and identifies the old updater plist", () => {
    expect(forkRelaySetupArgs()).toEqual([
      "run",
      "setup:launchd",
      "--",
      "--service",
      "telegram-relay",
    ]);
    expect(legacyAutoUpdatePlist("/Users/kc")).toBe(
      `/Users/kc/Library/LaunchAgents/${LEGACY_AUTO_UPDATE_LABEL}.plist`,
    );
    expect(
      disableLegacyAutoUpdateArgs(
        `/Users/kc/Library/LaunchAgents/${LEGACY_AUTO_UPDATE_LABEL}.plist`,
      ),
    ).toEqual([
      "unload",
      "-w",
      `/Users/kc/Library/LaunchAgents/${LEGACY_AUTO_UPDATE_LABEL}.plist`,
    ]);
  });
});

describe("pickSupervisor", () => {
  it("maps platform to supervisor kind", () => {
    expect(pickSupervisor("darwin")).toBe("launchd");
    expect(pickSupervisor("linux")).toBe("systemd");
    expect(pickSupervisor("win32")).toBe("manual");
  });
});

describe("renderLaunchdPlist", () => {
  const plist = renderLaunchdPlist({
    bunPath: "/opt/homebrew/bin/bun",
    installDir: "/Users/kc/src/gobot-bgos",
    gobotHome: "/Users/kc/.gobot",
  });

  it("runs the bot via bun under the managed label with keepalive", () => {
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain(
      "<string>/Users/kc/src/gobot-bgos/src/bot.ts</string>",
    );
    expect(plist).toContain(
      "<key>WorkingDirectory</key><string>/Users/kc/src/gobot-bgos</string>",
    );
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("/Users/kc/.gobot/logs/gobot.log");
    expect(plist).toContain("/Users/kc/.gobot/logs/gobot.err");
  });
});

describe("renderSystemdUnit", () => {
  const unit = renderSystemdUnit({
    bunPath: "/usr/local/bin/bun",
    installDir: "/home/u/src/gobot-bgos",
    gobotHome: "/home/u/.gobot",
  });

  it("uses EnvironmentFile + restart-always", () => {
    expect(unit).toContain("WorkingDirectory=/home/u/src/gobot-bgos");
    expect(unit).toContain("EnvironmentFile=/home/u/src/gobot-bgos/.env");
    expect(unit).toContain("ExecStart=/usr/local/bin/bun run src/bot.ts");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});
