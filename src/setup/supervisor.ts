/**
 * Pure process-supervisor rendering. No IO.
 *
 * A fresh public-patch install has no fork setup scripts, so setup writes a
 * bot-only supervisor directly: a launchd agent on macOS, a systemd user unit
 * on Linux. The label is the BGOS-managed relay label the watchdog and the
 * fork's launchd guard both key on.
 */
import { join } from "node:path";

/** The BGOS-managed relay label. Two pollers on one token = 409 loop, so the
 * fork's configure-launchd refuses to also install com.go.telegram-relay when
 * this label is loaded. Keep the value in sync with the fork. */
export const LAUNCHD_LABEL = "ai.brandgrowthos.gobot";
export const LEGACY_AUTO_UPDATE_LABEL = "com.go.auto-update";
export const SYSTEMD_UNIT = "gobot-bgos.service";

export function forkRelaySetupArgs(): string[] {
  return ["run", "setup:launchd", "--", "--service", "telegram-relay"];
}

export function legacyAutoUpdatePlist(home: string): string {
  return join(
    home,
    "Library",
    "LaunchAgents",
    `${LEGACY_AUTO_UPDATE_LABEL}.plist`,
  );
}

export function disableLegacyAutoUpdateArgs(plistPath: string): string[] {
  return ["unload", "-w", plistPath];
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

export function renderLaunchdPlist(opts: SupervisorRenderOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const botEntry = join(opts.installDir, "src", "bot.ts");
  const outLog = join(opts.gobotHome, "logs", "gobot.log");
  const errLog = join(opts.gobotHome, "logs", "gobot.err");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>run</string>
    <string>${botEntry}</string>
  </array>
  <key>WorkingDirectory</key><string>${opts.installDir}</string>
  <key>EnvironmentVariables</key><dict>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>StandardOutPath</key><string>${outLog}</string>
  <key>StandardErrorPath</key><string>${errLog}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: SupervisorRenderOptions): string {
  const botEntry = join("src", "bot.ts");
  const envFile = join(opts.installDir, ".env");
  return `[Unit]
Description=Gobot with BGOS integration
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.installDir}
EnvironmentFile=${envFile}
Environment=NODE_ENV=production
ExecStart=${opts.bunPath} run ${botEntry}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}
