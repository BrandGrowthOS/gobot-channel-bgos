/**
 * Pure argument parsing for `gobot-channel-bgos setup <CODE> [flags]`.
 *
 * No IO. The imperative shell (setup-cli.ts) resolves the environment and
 * home directory, then hands them here so this stays unit-testable.
 */
import { join } from "node:path";

export type HomeChannel = "both" | "telegram" | "bgos";

export interface SetupOptions {
  /** Pair code (BGOS-XXXX-XX). Optional on a re-run that is already paired. */
  code?: string;
  dryRun: boolean;
  baseUrl: string;
  homeChannel: HomeChannel;
  agents: string;
  installDir: string;
  pollInterval: number;
  /** Auto-answer the competing-poller prompt (non-interactive). */
  assumeYes: boolean;
  deviceLabel?: string;
  patchUrl: string;
  upstreamRepo: string;
}

export const DEFAULT_AGENTS =
  "general:General,research:Research,content:Content,finance:Finance," +
  "strategy:Strategy,cto:CTO,coo:COO,critic:Critic";
export const DEFAULT_BASE_URL = "https://api.brandgrowthos.ai";
export const DEFAULT_PATCH_URL =
  "https://raw.githubusercontent.com/BrandGrowthOS/gobot-bgos-patch/main/" +
  "patches/0001-bgos-channel-hook.patch";
export const DEFAULT_UPSTREAM_REPO = "https://github.com/autonomee/gobot.git";

const HOME_CHANNELS: readonly HomeChannel[] = ["both", "telegram", "bgos"];

function takeFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  argv.splice(idx, 2);
  return val;
}

function takeBool(argv: string[], flag: string): boolean {
  const idx = argv.indexOf(flag);
  if (idx < 0) return false;
  argv.splice(idx, 1);
  return true;
}

/**
 * Parse the args that follow the binary name. Tolerates a leading `setup`
 * subcommand token. Reads defaults from the supplied env + home dir so the
 * function is deterministic in tests.
 */
export function parseSetupArgs(
  rawArgv: string[],
  env: Record<string, string | undefined> = {},
  home = ".",
): SetupOptions {
  const argv = [...rawArgv];
  if (argv[0] === "setup") argv.shift();

  const dryRun = takeBool(argv, "--dry-run");
  const assumeYes = takeBool(argv, "--yes") || takeBool(argv, "-y");
  const baseUrl = (
    takeFlag(argv, "--base-url") ??
    env.BGOS_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  const homeChannelRaw =
    takeFlag(argv, "--home-channel") ?? env.GOBOT_HOME_CHANNEL ?? "both";
  const homeChannel: HomeChannel = HOME_CHANNELS.includes(
    homeChannelRaw as HomeChannel,
  )
    ? (homeChannelRaw as HomeChannel)
    : "both";

  const agents = takeFlag(argv, "--agents") ?? env.GOBOT_AGENTS ?? DEFAULT_AGENTS;

  const installDir =
    takeFlag(argv, "--install-dir") ??
    env.GOBOT_INSTALL_DIR ??
    join(home, "src", "gobot-bgos");

  const pollRaw =
    takeFlag(argv, "--poll-interval") ?? env.GOBOT_POLL_INTERVAL ?? "5";
  const pollParsed = Number.parseInt(pollRaw, 10);
  const pollInterval =
    Number.isFinite(pollParsed) && pollParsed >= 0 ? pollParsed : 5;

  const deviceLabel = takeFlag(argv, "--device-label");
  const patchUrl =
    takeFlag(argv, "--patch-url") ?? env.GOBOT_PATCH_URL ?? DEFAULT_PATCH_URL;
  const upstreamRepo =
    takeFlag(argv, "--upstream-repo") ??
    env.GOBOT_UPSTREAM_REPO ??
    DEFAULT_UPSTREAM_REPO;

  const code = argv.find((a) => !a.startsWith("-"));

  return {
    code,
    dryRun,
    baseUrl,
    homeChannel,
    agents,
    installDir,
    pollInterval,
    assumeYes,
    deviceLabel,
    patchUrl,
    upstreamRepo,
  };
}
