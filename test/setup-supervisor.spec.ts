import { describe, expect, it } from "vitest";

import {
  disableLegacyAutoUpdateArgs,
  disableLegacyLaunchdArgs,
  LAUNCHD_LABEL,
  LEGACY_AUTO_UPDATE_LABEL,
  LEGACY_RELAY_LABEL,
  legacyAutoUpdatePlist,
  legacyRelayPlist,
  pickSupervisor,
  removeLegacyLaunchdArgs,
  renderLaunchdPlist,
  renderSystemdUnit,
  stableSupervisorAssetCopies,
  stableSupervisorPaths,
  wrapperProgramArguments,
} from "../src/setup/supervisor.js";

describe("stable supervisor paths", () => {
  it("keeps all pre-import runtime files outside the updated checkout", () => {
    expect(stableSupervisorPaths("/Users/kc/.gobot")).toEqual({
      directory: "/Users/kc/.gobot/supervisor",
      wrapper: "/Users/kc/.gobot/supervisor/daemon-wrapper.js",
      selfUpdate: "/Users/kc/.gobot/supervisor/self-update.js",
      stateHome: "/Users/kc/.gobot/supervisor/state-home.js",
      versionPolicy: "/Users/kc/.gobot/supervisor/update-version-policy.js",
    });
    expect(
      stableSupervisorAssetCopies(
        "/package/dist",
        "/Users/kc/.gobot",
      ),
    ).toEqual([
      {
        source: "/package/dist/update-version-policy.js",
        destination:
          "/Users/kc/.gobot/supervisor/update-version-policy.js",
      },
      {
        source: "/package/dist/state-home.js",
        destination: "/Users/kc/.gobot/supervisor/state-home.js",
      },
      {
        source: "/package/dist/self-update.js",
        destination: "/Users/kc/.gobot/supervisor/self-update.js",
      },
      {
        source: "/package/dist/daemon-wrapper.js",
        destination: "/Users/kc/.gobot/supervisor/daemon-wrapper.js",
      },
    ]);
  });

  it("uses the resolved Bun path and one checkout argument", () => {
    expect(
      wrapperProgramArguments({
        bunPath: "/opt/homebrew/bin/bun",
        installDir: "/Users/kc/src/gobot-bgos",
        gobotHome: "/Users/kc/.gobot",
      }),
    ).toEqual([
      "/opt/homebrew/bin/bun",
      "run",
      "/Users/kc/.gobot/supervisor/daemon-wrapper.js",
      "/Users/kc/src/gobot-bgos",
    ]);
  });
});

describe("legacy launchd isolation", () => {
  it("identifies and persistently unloads both old services", () => {
    const relay = legacyRelayPlist("/Users/kc");
    const updater = legacyAutoUpdatePlist("/Users/kc");
    expect(relay).toBe(
      `/Users/kc/Library/LaunchAgents/${LEGACY_RELAY_LABEL}.plist`,
    );
    expect(updater).toBe(
      `/Users/kc/Library/LaunchAgents/${LEGACY_AUTO_UPDATE_LABEL}.plist`,
    );
    expect(disableLegacyLaunchdArgs(relay)).toEqual([
      "unload",
      "-w",
      relay,
    ]);
    expect(disableLegacyAutoUpdateArgs(updater)).toEqual([
      "unload",
      "-w",
      updater,
    ]);
    expect(removeLegacyLaunchdArgs(LEGACY_RELAY_LABEL)).toEqual([
      "remove",
      LEGACY_RELAY_LABEL,
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

  it("runs the stable wrapper under the BGOS label", () => {
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>/opt/homebrew/bin/bun</string>");
    expect(plist).toContain("<string>run</string>");
    expect(plist).toContain(
      "<string>/Users/kc/.gobot/supervisor/daemon-wrapper.js</string>",
    );
    expect(plist).toContain(
      "<string>/Users/kc/src/gobot-bgos</string>",
    );
    expect(plist).not.toContain("src/bot.ts");
    expect(plist).toContain(
      "<key>WorkingDirectory</key><string>/Users/kc/src/gobot-bgos</string>",
    );
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("/Users/kc/.gobot/logs/gobot.log");
    expect(plist).toContain("/Users/kc/.gobot/logs/gobot.err");
  });

  it("escapes path content as plist XML", () => {
    const escaped = renderLaunchdPlist({
      bunPath: "/Applications/Bun & Tools/bun",
      installDir: "/Users/kc/Gobot <live>",
      gobotHome: "/Users/kc/.gobot",
    });
    expect(escaped).toContain("Bun &amp; Tools");
    expect(escaped).toContain("Gobot &lt;live&gt;");
  });
});

describe("renderSystemdUnit", () => {
  const unit = renderSystemdUnit({
    bunPath: "/usr/local/bin/bun",
    installDir: "/home/u/src/gobot-bgos",
    gobotHome: "/home/u/.gobot",
  });

  it("runs the stable wrapper and restarts every exit", () => {
    expect(unit).toContain('WorkingDirectory="/home/u/src/gobot-bgos"');
    expect(unit).toContain(
      'EnvironmentFile="/home/u/src/gobot-bgos/.env"',
    );
    expect(unit).toContain(
      'ExecStart="/usr/local/bin/bun" "run" "/home/u/.gobot/supervisor/daemon-wrapper.js" "/home/u/src/gobot-bgos"',
    );
    expect(unit).not.toContain("src/bot.ts");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});
