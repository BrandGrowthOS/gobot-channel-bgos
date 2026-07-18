/** Pure process-supervisor paths and rendering. No IO. */
import { join } from "node:path";

export const LAUNCHD_LABEL = "ai.brandgrowthos.gobot";
export const LEGACY_RELAY_LABEL = "com.go.telegram-relay";
export const LEGACY_AUTO_UPDATE_LABEL = "com.go.auto-update";
export const SYSTEMD_UNIT = "gobot-bgos.service";

export interface StableSupervisorPaths {
  directory: string;
  wrapper: string;
  selfUpdate: string;
  versionPolicy: string;
}

export interface StableSupervisorAssetCopy {
  source: string;
  destination: string;
}

export function stableSupervisorPaths(gobotHome: string): StableSupervisorPaths {
  const directory = join(gobotHome, "supervisor");
  return {
    directory,
    wrapper: join(directory, "daemon-wrapper.js"),
    selfUpdate: join(directory, "self-update.js"),
    versionPolicy: join(directory, "update-version-policy.js"),
  };
}

export function stableSupervisorAssetCopies(
  packageDistDirectory: string,
  gobotHome: string,
): StableSupervisorAssetCopy[] {
  const paths = stableSupervisorPaths(gobotHome);
  return [
    {
      source: join(packageDistDirectory, "update-version-policy.js"),
      destination: paths.versionPolicy,
    },
    {
      source: join(packageDistDirectory, "self-update.js"),
      destination: paths.selfUpdate,
    },
    {
      source: join(packageDistDirectory, "daemon-wrapper.js"),
      destination: paths.wrapper,
    },
  ];
}

export function legacyRelayPlist(home: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${LEGACY_RELAY_LABEL}.plist`,
  );
}

export function legacyAutoUpdatePlist(home: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${LEGACY_AUTO_UPDATE_LABEL}.plist`,
  );
}

export function disableLegacyLaunchdArgs(plistPath: string): string[] {
  return ["unload", "-w", plistPath];
}

export function removeLegacyLaunchdArgs(label: string): string[] {
  return ["remove", label];
}

export function disableLegacyAutoUpdateArgs(plistPath: string): string[] {
  return disableLegacyLaunchdArgs(plistPath);
}

export type SupervisorKind = "launchd" | "systemd" | "manual";

export function pickSupervisor(platform: string): SupervisorKind {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "manual";
}

export interface SupervisorRenderOptions {
  bunPath: string;
  installDir: string;
  gobotHome: string;
  label?: string;
}

export function wrapperProgramArguments(
  opts: SupervisorRenderOptions,
): string[] {
  return [
    opts.bunPath,
    "run",
    stableSupervisorPaths(opts.gobotHome).wrapper,
    opts.installDir,
  ];
}

function plistString(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderLaunchdPlist(opts: SupervisorRenderOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const outLog = join(opts.gobotHome, "logs", "gobot.log");
  const errLog = join(opts.gobotHome, "logs", "gobot.err");
  const programArguments = wrapperProgramArguments(opts)
    .map((value) => `    <string>${plistString(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistString(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key><string>${plistString(opts.installDir)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
    <key>GOBOT_INSTALL_DIR</key><string>${plistString(opts.installDir)}</string>
  </dict>
  <key>StandardOutPath</key><string>${plistString(outLog)}</string>
  <key>StandardErrorPath</key><string>${plistString(errLog)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderSystemdUnit(opts: SupervisorRenderOptions): string {
  const envFile = join(opts.installDir, ".env");
  const execStart = wrapperProgramArguments(opts).map(systemdQuote).join(" ");
  return `[Unit]
Description=Gobot with BGOS integration
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(opts.installDir)}
EnvironmentFile=${systemdQuote(envFile)}
Environment=NODE_ENV=production
Environment=${systemdQuote(`GOBOT_INSTALL_DIR=${opts.installDir}`)}
ExecStart=${execStart}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}
