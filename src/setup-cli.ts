#!/usr/bin/env node
/**
 * `gobot-channel-bgos setup <BGOS-CODE>` one-paste installer.
 *
 * Collapses the 13-step Gobot integration playbook into one command: detect
 * the host, scan for a competing Telegram poller (the only interactive y/n),
 * acquire the fork source (clone upstream + apply the public BGOS hook patch,
 * or reuse an existing clone), install deps + the vendor package, pair against
 * BGOS, write the managed env block, wire a supervisor, and verify.
 *
 * Idempotent: a re-run skips stages already satisfied (hook applied, valid
 * secrets, supervisor loaded). `--dry-run` prints the exact per-stage commands
 * without executing any destructive step, so the flow is safe to inspect.
 *
 * All BGOS business logic lives in this same package; the fork just brokers
 * the loader hook. See BrandGrowthOS/gobot-bgos-patch for the hook patch.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { BgosApi } from "./bgos-api.js";
import { pairBgos } from "./pair-cli.js";
import { getPackageVersion } from "./version.js";
import type { AgentCatalogEntry } from "./types.js";
import { parseSetupArgs, type SetupOptions } from "./setup/args.js";
import { invokedAsCliEntry } from "./setup/entry.js";
import { composeEnvBlock, mergeEnvFile } from "./setup/env-block.js";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  pickSupervisor,
  renderLaunchdPlist,
  renderSystemdUnit,
  type SupervisorKind,
} from "./setup/supervisor.js";
import { parseCompetitorScan, type Competitor } from "./setup/competitors.js";
import { planStages, type EnvFacts, type Stage } from "./setup/plan.js";
import { competitorPrompt, formatSuccessLine } from "./setup/messages.js";

// ---------------------------------------------------------------------------
// Small IO helpers (the untested imperative shell).
// ---------------------------------------------------------------------------

function log(msg: string): void {
  process.stdout.write(msg + "\n");
}
function warn(msg: string): void {
  process.stderr.write("! " + msg + "\n");
}
function step(name: string, detail: string): void {
  log(`\n== ${name} ==\n   ${detail}`);
}

interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command, streaming to the console. Returns ok=false on non-zero. */
function run(
  cmd: string,
  args: string[],
  cwd?: string,
  capture = false,
): RunResult {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

/** Run and capture stdout, never throwing (used for detection). */
function probe(cmd: string, args: string[]): string {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8" });
    return (res.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function resolveBunPath(): string {
  const viaPath = probe("bash", ["-lc", "command -v bun"]);
  if (viaPath) return viaPath;
  if (process.execPath.endsWith("bun")) return process.execPath;
  return platform() === "darwin" ? "/opt/homebrew/bin/bun" : "bun";
}

function resolveGobotHome(): string {
  const fromEnv = process.env.GOBOT_HOME?.trim();
  if (fromEnv) {
    return fromEnv.startsWith("~")
      ? join(homedir(), fromEnv.slice(1))
      : fromEnv;
  }
  return join(homedir(), ".gobot");
}

function secretsValid(): boolean {
  const path = join(resolveGobotHome(), "secrets", "bgos.json");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      pairingToken?: string;
    };
    return !!parsed.pairingToken && parsed.pairingToken.length >= 20;
  } catch {
    return false;
  }
}

function hasScript(installDir: string, name: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(join(installDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    return !!pkg.scripts && name in pkg.scripts;
  } catch {
    return false;
  }
}

function supervisorLoaded(plat: string): boolean {
  if (plat === "darwin") {
    return probe("launchctl", ["list"]).includes(LAUNCHD_LABEL);
  }
  if (plat === "linux") {
    return probe("systemctl", ["--user", "is-active", SYSTEMD_UNIT]) === "active";
  }
  return false;
}

function scanCompetitors(installDir: string): Competitor[] {
  const ps = probe("ps", ["-eo", "pid,command"]) || probe("ps", ["-ef"]);
  return parseCompetitorScan(ps, {
    selfPid: String(process.pid),
    selfInstallDir: installDir,
  });
}

function parseAgentCatalog(raw: string): AgentCatalogEntry[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [route, name] = entry.split(":").map((p) => p.trim());
      return route ? { agent_route: route, name: name || route } : null;
    })
    .filter((a): a is AgentCatalogEntry => a !== null);
}

async function askYesNo(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) =>
    rl.question(prompt, resolve),
  );
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ---------------------------------------------------------------------------
// Fact gathering
// ---------------------------------------------------------------------------

function gatherFacts(opts: SetupOptions): EnvFacts {
  const plat = platform();
  return {
    platform: plat,
    installDirExists: existsSync(opts.installDir),
    installDirIsGitRepo: existsSync(join(opts.installDir, ".git")),
    hookPresent: existsSync(
      join(opts.installDir, "src", "adapters", "bgos", "loader.ts"),
    ),
    vendorInstalled: existsSync(
      join(opts.installDir, "node_modules", "gobot-channel-bgos"),
    ),
    secretsValid: secretsValid(),
    supervisorPresent: supervisorLoaded(plat),
    hasSetupLaunchdScript: hasScript(opts.installDir, "setup:launchd"),
    competitorCount: scanCompetitors(opts.installDir).length,
  };
}

// ---------------------------------------------------------------------------
// Stages (each honors dryRun: print the command, do not execute).
// ---------------------------------------------------------------------------

function stageAcquireSource(opts: SetupOptions, facts: EnvFacts): void {
  const patchTmp = join(
    mkdtempSync(join(tmpdir(), "gobot-patch-")),
    "hook.patch",
  );
  if (opts.dryRun) {
    if (facts.hookPresent) {
      log("   [skip] BGOS hook already present");
      return;
    }
    if (!facts.installDirExists) {
      log(`   [dry-run] git clone ${opts.upstreamRepo} ${opts.installDir}`);
    }
    log(`   [dry-run] download ${opts.patchUrl} -> ${patchTmp}`);
    log(`   [dry-run] git -C ${opts.installDir} am --3way ${patchTmp}`);
    log(
      `   [dry-run] on am failure: git am --abort; checkout recorded base; git am`,
    );
    return;
  }

  if (facts.hookPresent) {
    log("   BGOS hook already applied, leaving source as is");
    return;
  }

  if (!facts.installDirExists) {
    mkdirSync(dirname(opts.installDir), { recursive: true });
    const c = run("git", ["clone", opts.upstreamRepo, opts.installDir]);
    if (!c.ok) throw new Error("git clone failed");
  }

  // Download the public hook patch.
  const patch = downloadTextSync(opts.patchUrl);
  writeFileSync(patchTmp, patch);

  // Apply with a 3-way merge; abort cleanly on failure.
  const am = run("git", ["-C", opts.installDir, "am", "--3way", patchTmp]);
  if (!am.ok) {
    run("git", ["-C", opts.installDir, "am", "--abort"], undefined, true);
    throw new Error(
      "git am failed to apply the BGOS hook patch. The upstream clone may " +
        "have diverged; try again or apply the patch manually (see " +
        "BrandGrowthOS/gobot-bgos-patch).",
    );
  }
  log("   applied the BGOS channel hook patch");
}

/** Synchronous fetch of a text URL via a subprocess (curl), no extra deps. */
function downloadTextSync(url: string): string {
  const res = spawnSync("curl", ["-fsSL", url], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`failed to download ${url}: ${res.stderr ?? "no output"}`);
  }
  return res.stdout;
}

function stageInstallDeps(opts: SetupOptions): void {
  if (opts.dryRun) {
    log(`   [dry-run] (cd ${opts.installDir} && bun install)`);
    log(`   [dry-run] (cd ${opts.installDir} && bun add gobot-channel-bgos@latest)`);
    return;
  }
  const bun = resolveBunPath();
  if (!run(bun, ["install"], opts.installDir).ok)
    throw new Error("bun install failed");
  if (!run(bun, ["add", "gobot-channel-bgos@latest"], opts.installDir).ok)
    throw new Error("bun add gobot-channel-bgos failed");
}

async function stagePair(opts: SetupOptions, facts: EnvFacts): Promise<void> {
  if (facts.secretsValid) {
    log("   [skip] already paired (valid secrets file)");
    return;
  }
  if (!opts.code) {
    throw new Error(
      "no pair code supplied and no valid pairing found. Open BGOS, " +
        "Integrations, Gobot card, generate a code, then re-run: " +
        "bunx gobot-channel-bgos setup BGOS-XXXX-XX",
    );
  }
  const label = opts.deviceLabel ?? `${hostname()} (Gobot)`;
  if (opts.dryRun) {
    log(
      `   [dry-run] pairBgos(code=${opts.code}, label="${label}", ` +
        `baseUrl=${opts.baseUrl})`,
    );
    log(`   [dry-run] equivalent CLI: bunx gobot-pair-bgos ${opts.code} --device-label "${label}"`);
    return;
  }
  const { tokenFile, pairing } = await pairBgos({
    baseUrl: opts.baseUrl,
    code: opts.code,
    deviceLabel: label,
    agentCatalog: parseAgentCatalog(opts.agents),
  });
  log(
    `   paired: pairing_id=${pairing.pairing_id} user_id=${pairing.user_id}, ` +
      `secret at ${tokenFile}`,
  );
}

function stageWriteEnv(opts: SetupOptions): void {
  const envPath = join(opts.installDir, ".env");
  const block = composeEnvBlock({
    homeChannel: opts.homeChannel,
    agents: opts.agents,
    pollInterval: opts.pollInterval,
  });
  if (opts.dryRun) {
    log(`   [dry-run] merge managed block into ${envPath} (chmod 600):`);
    for (const line of block.trimEnd().split("\n")) log(`     ${line}`);
    return;
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const merged = mergeEnvFile(existing, block);
  writeFileSync(envPath, merged, { mode: 0o600 });
  try {
    chmodSync(envPath, 0o600);
  } catch {
    /* best effort */
  }
  log(`   wrote managed GOBOT env block to ${envPath}`);
}

function stageSupervisor(
  opts: SetupOptions,
  facts: EnvFacts,
  kind: SupervisorKind,
): void {
  const bun = resolveBunPath();
  const gobotHome = resolveGobotHome();

  // Full private fork path: reuse its launchd configurator when present.
  if (kind === "launchd" && facts.hasSetupLaunchdScript) {
    if (opts.dryRun) {
      log(`   [dry-run] (cd ${opts.installDir} && bun run setup:launchd)`);
      return;
    }
    if (!run(bun, ["run", "setup:launchd"], opts.installDir).ok)
      throw new Error("bun run setup:launchd failed");
    return;
  }

  if (kind === "launchd") {
    const plist = renderLaunchdPlist({
      bunPath: bun,
      installDir: opts.installDir,
      gobotHome,
    });
    const plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    );
    if (opts.dryRun) {
      log(`   [dry-run] mkdir -p ${join(gobotHome, "logs")}`);
      log(`   [dry-run] write launchd plist -> ${plistPath}`);
      for (const line of plist.trimEnd().split("\n")) log(`     ${line}`);
      log(`   [dry-run] launchctl unload ${plistPath} (ignore errors)`);
      log(`   [dry-run] launchctl load ${plistPath}`);
      return;
    }
    mkdirSync(join(gobotHome, "logs"), { recursive: true });
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, plist);
    run("launchctl", ["unload", plistPath], undefined, true);
    if (!run("launchctl", ["load", plistPath]).ok)
      throw new Error("launchctl load failed");
    log(`   loaded launchd agent ${LAUNCHD_LABEL}`);
    return;
  }

  if (kind === "systemd") {
    const unit = renderSystemdUnit({
      bunPath: bun,
      installDir: opts.installDir,
      gobotHome,
    });
    const unitPath = join(
      homedir(),
      ".config",
      "systemd",
      "user",
      SYSTEMD_UNIT,
    );
    if (opts.dryRun) {
      log(`   [dry-run] write systemd unit -> ${unitPath}`);
      for (const line of unit.trimEnd().split("\n")) log(`     ${line}`);
      log(`   [dry-run] systemctl --user daemon-reload`);
      log(`   [dry-run] systemctl --user enable --now ${SYSTEMD_UNIT}`);
      return;
    }
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, unit);
    run("systemctl", ["--user", "daemon-reload"]);
    if (!run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]).ok)
      throw new Error("systemctl enable failed");
    log(`   enabled systemd user unit ${SYSTEMD_UNIT}`);
    return;
  }

  warn(
    `unsupported platform for auto-supervisor. Run manually: ` +
      `cd ${opts.installDir} && bun run src/bot.ts`,
  );
}

async function stageVerify(opts: SetupOptions): Promise<void> {
  if (opts.dryRun) {
    log(`   [dry-run] GET ${opts.baseUrl}/api/v1/integrations/me (whoami)`);
    return;
  }
  const path = join(resolveGobotHome(), "secrets", "bgos.json");
  const secrets = JSON.parse(readFileSync(path, "utf8")) as {
    pairingToken: string;
    baseUrl?: string;
  };
  const api = new BgosApi({
    baseUrl: secrets.baseUrl ?? opts.baseUrl,
    pairingToken: secrets.pairingToken,
    reconnect: { initialDelayMs: 1000, maxDelayMs: 30000 },
  });
  const me = await api.whoami();
  log(
    `   whoami OK: user=${me.user_id} pairing_id=${me.pairing_id} ` +
      `integration=${me.integration} assistants=${me.assistants?.length ?? 0}`,
  );
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function printPlan(stages: Stage[]): void {
  log("\nPlan:");
  for (const s of stages) {
    const tag =
      s.action === "skip" ? "skip  " : s.action === "reload" ? "reload" : "run   ";
    log(`  [${tag}] ${s.stage}  (${s.reason})`);
  }
}

async function handleCompetitors(
  opts: SetupOptions,
  competitors: Competitor[],
): Promise<void> {
  if (competitors.length === 0) {
    log("   no competing Telegram poller found");
    return;
  }
  warn(`${competitors.length} competing Telegram poller(s) detected:`);
  for (const c of competitors) warn(`  pid ${c.pid} (${c.source}): ${c.command}`);

  if (opts.dryRun) {
    log("   [dry-run] would prompt: kill the competitor(s)? [y/N]");
    return;
  }
  if (opts.assumeYes || !process.stdin.isTTY) {
    warn(
      "leaving competitor(s) running (non-interactive). The fork rides out " +
        "409 conflicts with retry-on-409 backoff; kill them yourself if the " +
        "bot crash-loops.",
    );
    return;
  }
  const kill = await askYesNo(competitorPrompt(competitors[0]));
  if (kill) {
    for (const c of competitors) {
      if (c.pid) run("kill", ["-TERM", c.pid], undefined, true);
    }
    log("   sent SIGTERM to the competitor(s)");
  } else {
    log("   leaving competitor(s) running (relying on retry-on-409 backoff)");
  }
}

function usage(): void {
  log(
    "usage: bunx gobot-channel-bgos setup <BGOS-CODE> [flags]\n\n" +
      "Flags:\n" +
      "  --dry-run              print the plan and commands, change nothing\n" +
      "  --install-dir PATH     where the Gobot fork lives (default ~/src/gobot-bgos)\n" +
      "  --home-channel VALUE   both | telegram | bgos (default both)\n" +
      "  --agents LIST          route:Name,route:Name,... (default all 8)\n" +
      "  --poll-interval N      backfill seconds (default 5)\n" +
      "  --device-label NAME    label shown in BGOS (default hostname)\n" +
      "  --base-url URL         BGOS API base (default https://api.brandgrowthos.ai)\n" +
      "  --yes                  do not prompt; leave any competing poller running\n",
  );
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw[0] === "-h" || raw[0] === "--help" || raw.length === 0) {
    usage();
    process.exit(raw.length === 0 ? 2 : 0);
  }

  const opts = parseSetupArgs(raw, process.env, homedir());
  log(
    `gobot-channel-bgos setup v${getPackageVersion()}` +
      (opts.dryRun ? "  (dry run)" : ""),
  );
  log(`install dir: ${opts.installDir}`);

  const facts = gatherFacts(opts);
  const stages = planStages(facts, { hasCode: !!opts.code });
  printPlan(stages);

  const kind = pickSupervisor(facts.platform);

  for (const s of stages) {
    if (s.stage === "detect") {
      step("detect", s.reason);
      log(
        `   platform=${facts.platform} bun=${resolveBunPath() || "not found"} ` +
          `hook=${facts.hookPresent} vendor=${facts.vendorInstalled} ` +
          `paired=${facts.secretsValid} supervisor=${facts.supervisorPresent}`,
      );
      continue;
    }
    if (s.stage === "scan-competitors") {
      step("scan-competitors", s.reason);
      await handleCompetitors(opts, scanCompetitors(opts.installDir));
      continue;
    }
    if (s.stage === "acquire-source") {
      step("acquire-source", s.reason);
      stageAcquireSource(opts, facts);
      continue;
    }
    if (s.stage === "install-deps") {
      step("install-deps", s.reason);
      stageInstallDeps(opts);
      continue;
    }
    if (s.stage === "pair") {
      step("pair", s.reason);
      await stagePair(opts, facts);
      continue;
    }
    if (s.stage === "write-env") {
      step("write-env", s.reason);
      stageWriteEnv(opts);
      continue;
    }
    if (s.stage === "supervisor") {
      step("supervisor", s.reason);
      stageSupervisor(opts, facts, kind);
      continue;
    }
    if (s.stage === "verify") {
      step("verify", s.reason);
      await stageVerify(opts);
      continue;
    }
  }

  const agentCount = parseAgentCatalog(opts.agents).length;
  log("");
  log(
    formatSuccessLine({
      installDir: opts.installDir,
      agentCount,
      supervisor: kind,
      homeChannel: opts.homeChannel,
      paired: true,
    }),
  );
  if (opts.dryRun) log("\n(dry run complete: nothing was changed)");
}

// Run when invoked as a CLI (not when imported). Uses import.meta.main when the
// runtime provides it (Bun, Node >= 24) and a realpath fallback otherwise, so a
// `bunx gobot-channel-bgos ...` bin-name shim still triggers main().
const invokedAsCli = invokedAsCliEntry(
  import.meta as unknown as { url: string; main?: boolean },
  process.argv[1],
);
if (invokedAsCli) {
  main().catch((err: unknown) => {
    const e = err as { message?: string };
    process.stderr.write(`setup failed: ${e?.message ?? String(err)}\n`);
    process.exit(1);
  });
}

export { main };
