import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_UPDATE_JITTER_MS = 6 * 60 * 60 * 1000;
export const HEALTHY_BOOT_MS = 60_000;

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;

export type AutoUpdateFlag = "on" | "off" | "invalid";

export function parseAutoUpdateFlag(value: string | undefined): AutoUpdateFlag {
  if (value === "on") return "on";
  if (value === "off") return "off";
  return "invalid";
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export type VersionDecision =
  | "update"
  | "current"
  | "major-blocked"
  | "invalid";

export function decideVersionUpdate(
  runningVersion: string,
  latestVersion: string,
): VersionDecision {
  const running = parseVersion(runningVersion);
  const latest = parseVersion(latestVersion);
  if (!running || !latest) return "invalid";
  if (running.major !== latest.major) return "major-blocked";
  return compareVersions(runningVersion, latestVersion) === -1
    ? "update"
    : "current";
}

export function updateJitterMs(randomValue: number): number {
  const safe = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0;
  return Math.floor(safe * MAX_UPDATE_JITTER_MS);
}

export type DrainDecision = "idle" | "begin" | "wait" | "apply";

export function decideDrainBeforeUpdate(input: {
  updateReady: boolean;
  draining: boolean;
  activeMessages: number;
}): DrainDecision {
  if (!input.updateReady) return "idle";
  if (!input.draining) return "begin";
  return input.activeMessages > 0 ? "wait" : "apply";
}

export interface PendingUpdateState {
  previousCommit: string;
  previousVersion: string;
  targetCommit: string;
  targetVersion: string;
  crashCount: number;
  bootStartedAtMs: number | null;
  lockfileChanged: boolean;
}

export interface AutoUpdateState {
  schemaVersion: 1;
  disabled: boolean;
  resetSeen: boolean;
  upstreamRef: string | null;
  pending: PendingUpdateState | null;
}

export const EMPTY_AUTO_UPDATE_STATE: AutoUpdateState = {
  schemaVersion: 1,
  disabled: false,
  resetSeen: false,
  upstreamRef: null,
  pending: null,
};

export type RollbackEvent =
  | { type: "flag-off" }
  | { type: "boot"; nowMs: number; currentCommit: string }
  | {
      type: "update-staged";
      previousCommit: string;
      previousVersion: string;
      targetCommit: string;
      targetVersion: string;
      lockfileChanged: boolean;
      upstreamRef: string;
    }
  | { type: "update-cancelled" }
  | { type: "healthy"; currentCommit: string }
  | { type: "clean-shutdown"; currentCommit: string }
  | { type: "rolled-back" };

export type RollbackAction = "continue" | "disabled" | "rollback";

export function transitionRollbackState(
  state: AutoUpdateState,
  event: RollbackEvent,
): { state: AutoUpdateState; action: RollbackAction } {
  const current = structuredClone(state);

  if (event.type === "flag-off") {
    if (current.disabled) current.resetSeen = true;
    return { state: current, action: "continue" };
  }

  if (event.type === "rolled-back") {
    return {
      state: {
        schemaVersion: 1,
        disabled: true,
        resetSeen: false,
        upstreamRef: current.upstreamRef,
        pending: null,
      },
      action: "disabled",
    };
  }

  if (event.type === "update-staged") {
    current.pending = {
      previousCommit: event.previousCommit,
      previousVersion: event.previousVersion,
      targetCommit: event.targetCommit,
      targetVersion: event.targetVersion,
      crashCount: 0,
      bootStartedAtMs: null,
      lockfileChanged: event.lockfileChanged,
    };
    current.upstreamRef = event.upstreamRef;
    return { state: current, action: "continue" };
  }

  if (event.type === "update-cancelled") {
    current.pending = null;
    return { state: current, action: "continue" };
  }

  if (event.type === "healthy") {
    if (current.pending?.targetCommit === event.currentCommit) {
      current.pending = null;
    }
    return { state: current, action: "continue" };
  }

  if (event.type === "clean-shutdown") {
    if (current.pending?.targetCommit === event.currentCommit) {
      current.pending.bootStartedAtMs = null;
    }
    return { state: current, action: "continue" };
  }

  if (current.disabled) {
    if (!current.resetSeen) return { state: current, action: "disabled" };
    current.disabled = false;
    current.resetSeen = false;
  }

  const pending = current.pending;
  if (!pending) return { state: current, action: "continue" };
  if (pending.targetCommit !== event.currentCommit) {
    current.pending = null;
    return { state: current, action: "continue" };
  }

  if (pending.bootStartedAtMs !== null) {
    const age = event.nowMs - pending.bootStartedAtMs;
    if (age >= HEALTHY_BOOT_MS) {
      current.pending = null;
      return { state: current, action: "continue" };
    }
    if (age >= 0) pending.crashCount += 1;
  }

  if (pending.crashCount >= 2) {
    return { state: current, action: "rollback" };
  }
  pending.bootStartedAtMs = event.nowMs;
  return { state: current, action: "continue" };
}

function isPendingState(value: unknown): value is PendingUpdateState {
  if (!value || typeof value !== "object") return false;
  const pending = value as Partial<PendingUpdateState>;
  return (
    typeof pending.previousCommit === "string" &&
    typeof pending.previousVersion === "string" &&
    typeof pending.targetCommit === "string" &&
    typeof pending.targetVersion === "string" &&
    typeof pending.crashCount === "number" &&
    (pending.bootStartedAtMs === null ||
      typeof pending.bootStartedAtMs === "number") &&
    typeof pending.lockfileChanged === "boolean"
  );
}

function isState(value: unknown): value is AutoUpdateState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AutoUpdateState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.disabled === "boolean" &&
    typeof state.resetSeen === "boolean" &&
    (state.upstreamRef === null || typeof state.upstreamRef === "string") &&
    (state.pending === null || isPendingState(state.pending))
  );
}

export function readAutoUpdateState(path: string): AutoUpdateState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isState(parsed) ? parsed : structuredClone(EMPTY_AUTO_UPDATE_STATE);
  } catch {
    return structuredClone(EMPTY_AUTO_UPDATE_STATE);
  }
}

export function writeAutoUpdateState(
  path: string,
  state: AutoUpdateState,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function autoUpdateStatePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.GOBOT_HOME?.trim();
  const root = configured
    ? configured.startsWith("~")
      ? join(homedir(), configured.slice(1))
      : configured
    : join(homedir(), ".gobot");
  return join(root, "bgos_auto_update.json");
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => CommandResult;

export const runCommand: CommandRunner = (command, args, cwd) => {
  try {
    const result = spawnSync(command, [...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error.message } : {}),
    };
  } catch (error) {
    return {
      status: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

interface CheckoutInfo {
  root: string;
  version: string;
  commit: string;
}

export type GitCheckDecision =
  | "update-available"
  | "current"
  | "major-blocked"
  | "not-fast-forward"
  | "not-gobot-checkout"
  | "no-upstream"
  | "invalid-version"
  | "check-failed";

export interface GitUpdateCheck {
  decision: GitCheckDecision;
  detail: string;
  checkoutRoot?: string;
  runningVersion?: string;
  latestVersion?: string;
  currentCommit?: string;
  targetCommit?: string;
  lockfileChanged?: boolean;
  upstreamRef?: string;
}

export interface GitUpdateOptions {
  checkoutDir?: string;
  expectedPackageName?: string;
  upstreamRef?: string;
  runner?: CommandRunner;
}

function isSafeUpstreamRef(value: string): boolean {
  return (
    /^refs\/remotes\/[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith("/")
  );
}

function commandFailure(result: CommandResult): string {
  return (result.error || result.stderr || result.stdout || "command failed").trim();
}

function readCheckout(
  options: GitUpdateOptions,
): { info?: CheckoutInfo; detail?: string } {
  const runner = options.runner ?? runCommand;
  const configured =
    options.checkoutDir ?? process.env.GOBOT_INSTALL_DIR ?? process.cwd();
  const candidate = resolve(
    configured.startsWith("~")
      ? join(homedir(), configured.slice(1))
      : configured,
  );
  const top = runner("git", ["rev-parse", "--show-toplevel"], candidate);
  if (top.status !== 0) return { detail: "install directory is not a git checkout" };

  let root: string;
  try {
    root = realpathSync(top.stdout.trim());
  } catch {
    return { detail: "git checkout root could not be resolved" };
  }

  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
    };
    if (manifest.name !== (options.expectedPackageName ?? "gobot")) {
      return { detail: `checkout package is ${manifest.name ?? "unknown"}, expected ${options.expectedPackageName ?? "gobot"}` };
    }
    if (typeof manifest.version !== "string") {
      return { detail: "checkout package version is missing" };
    }
    const head = runner("git", ["rev-parse", "HEAD"], root);
    const commit = head.stdout.trim();
    if (head.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      return { detail: "checkout HEAD could not be resolved" };
    }
    return { info: { root, version: manifest.version, commit } };
  } catch {
    return { detail: "checkout package.json could not be read" };
  }
}

export function checkGitUpdate(options: GitUpdateOptions = {}): GitUpdateCheck {
  const runner = options.runner ?? runCommand;
  try {
    const checkout = readCheckout(options);
    if (!checkout.info) {
      return {
        decision: "not-gobot-checkout",
        detail: checkout.detail ?? "install checkout could not be verified",
      };
    }
    const { root, version, commit } = checkout.info;
    let upstreamRef = options.upstreamRef ?? "";
    if (!upstreamRef) {
      const upstream = runner(
        "git",
        ["rev-parse", "--symbolic-full-name", "@{upstream}"],
        root,
      );
      if (upstream.status === 0) upstreamRef = upstream.stdout.trim();
    }
    if (!isSafeUpstreamRef(upstreamRef)) {
      return {
        decision: "no-upstream",
        detail: "checkout has no safe remote tracking ref",
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
      };
    }

    const fetched = runner("git", ["fetch", "--quiet"], root);
    if (fetched.status !== 0) {
      return {
        decision: "check-failed",
        detail: `git fetch failed: ${commandFailure(fetched)}`,
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
      };
    }

    const target = runner("git", ["rev-parse", upstreamRef], root);
    const targetCommit = target.stdout.trim();
    if (target.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(targetCommit)) {
      return {
        decision: "check-failed",
        detail: "upstream commit could not be resolved",
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
      };
    }
    if (targetCommit === commit) {
      return {
        decision: "current",
        detail: `version ${version} is current`,
        checkoutRoot: root,
        runningVersion: version,
        latestVersion: version,
        currentCommit: commit,
        targetCommit,
        lockfileChanged: false,
        upstreamRef,
      };
    }

    const ancestor = runner(
      "git",
      ["merge-base", "--is-ancestor", "HEAD", targetCommit],
      root,
    );
    if (ancestor.status !== 0) {
      return {
        decision: "not-fast-forward",
        detail: "upstream cannot be applied as a fast-forward",
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
        targetCommit,
      };
    }

    const latestManifest = runner(
      "git",
      ["show", `${targetCommit}:package.json`],
      root,
    );
    if (latestManifest.status !== 0) {
      return {
        decision: "check-failed",
        detail: "upstream package.json could not be read",
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
        targetCommit,
      };
    }
    let latestVersion: string;
    try {
      const parsed = JSON.parse(latestManifest.stdout) as { version?: string };
      if (typeof parsed.version !== "string") throw new Error("missing version");
      latestVersion = parsed.version;
    } catch {
      return {
        decision: "invalid-version",
        detail: "upstream package version is invalid",
        checkoutRoot: root,
        runningVersion: version,
        currentCommit: commit,
        targetCommit,
      };
    }

    const versionDecision = decideVersionUpdate(version, latestVersion);
    if (versionDecision !== "update") {
      const decision =
        versionDecision === "major-blocked"
          ? "major-blocked"
          : versionDecision === "invalid"
            ? "invalid-version"
            : "current";
      return {
        decision,
        detail:
          decision === "major-blocked"
            ? `version ${latestVersion} changes major from ${version}`
            : decision === "invalid-version"
              ? `could not compare versions ${version} and ${latestVersion}`
              : `version ${version} is not older than ${latestVersion}`,
        checkoutRoot: root,
        runningVersion: version,
        latestVersion,
        currentCommit: commit,
        targetCommit,
      };
    }

    const lockDiff = runner(
      "git",
      ["diff", "--name-only", commit, targetCommit, "--", ...LOCKFILES],
      root,
    );
    if (lockDiff.status !== 0) {
      return {
        decision: "check-failed",
        detail: "lockfile comparison failed",
        checkoutRoot: root,
        runningVersion: version,
        latestVersion,
        currentCommit: commit,
        targetCommit,
      };
    }
    const changedNames = new Set(
      lockDiff.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    );
    const lockfileChanged = LOCKFILES.some((name) => changedNames.has(name));
    return {
      decision: "update-available",
      detail: `version ${latestVersion} is available within major ${parseVersion(version)?.major}`,
      checkoutRoot: root,
      runningVersion: version,
      latestVersion,
      currentCommit: commit,
      targetCommit,
      lockfileChanged,
      upstreamRef,
    };
  } catch (error) {
    return {
      decision: "check-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatGitUpdateDecision(check: GitUpdateCheck): string {
  return `[gobot-channel-bgos] auto-update check: ${check.decision}: ${check.detail}`;
}

export interface AutoUpdateControllerDeps extends GitUpdateOptions {
  env?: Record<string, string | undefined>;
  statePath?: string;
  log?: (message: string) => void;
  drain?: () => Promise<void>;
  resume?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  exit?: (code: number) => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
  bunPath?: string;
}

export type AutoUpdateStartResult = "inactive" | "running" | "exit-requested";

export class AutoUpdateController {
  private readonly env: Record<string, string | undefined>;
  private readonly statePath: string;
  private readonly runner: CommandRunner;
  private readonly log: (message: string) => void;
  private readonly drain: () => Promise<void>;
  private readonly resume: () => Promise<void>;
  private readonly shutdown: () => Promise<void>;
  private readonly exit: (code: number) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private timer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private currentCommit: string | null = null;
  private checking = false;

  constructor(private readonly deps: AutoUpdateControllerDeps = {}) {
    this.env = deps.env ?? process.env;
    this.statePath = deps.statePath ?? autoUpdateStatePath(this.env);
    this.runner = deps.runner ?? runCommand;
    this.log = deps.log ?? ((message) => console.log(message));
    this.drain = deps.drain ?? (async () => undefined);
    this.resume = deps.resume ?? (async () => undefined);
    this.shutdown = deps.shutdown ?? (async () => undefined);
    this.exit = deps.exit ?? ((code) => process.exit(code));
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? (() => Math.random());
    this.setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  async start(): Promise<AutoUpdateStartResult> {
    this.stopped = false;
    const flag = parseAutoUpdateFlag(this.env.BGOS_AUTO_UPDATE);
    if (flag === "off") {
      this.recordFlagReset();
      return "inactive";
    }
    if (flag !== "on") return "inactive";

    try {
      let state = readAutoUpdateState(this.statePath);
      if (state.disabled && !state.resetSeen) {
        this.log(
          "[gobot-channel-bgos] auto-update is disabled after rollback; run one supervised boot with BGOS_AUTO_UPDATE=off before enabling it again",
        );
        return "inactive";
      }

      const checkout = readCheckout({
        checkoutDir: this.deps.checkoutDir,
        expectedPackageName: this.deps.expectedPackageName,
        runner: this.runner,
      });
      if (!checkout.info) {
        this.log(
          `[gobot-channel-bgos] auto-update skipped: ${checkout.detail ?? "Gobot checkout was not verified"}`,
        );
        return "inactive";
      }
      this.currentCommit = checkout.info.commit;
      const boot = transitionRollbackState(state, {
        type: "boot",
        nowMs: this.now(),
        currentCommit: checkout.info.commit,
      });
      state = boot.state;
      writeAutoUpdateState(this.statePath, state);

      if (boot.action === "rollback" && state.pending) {
        return await this.rollback(checkout.info.root, state);
      }
      if (state.pending) {
        this.armHealthyTimer(checkout.info.commit);
        return "running";
      }

      const result = await this.checkAndApply();
      if (result === "exit-requested") return result;
      this.armNextCheck();
      return "running";
    } catch (error) {
      this.log(
        `[gobot-channel-bgos] auto-update check failed; daemon will continue: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "running";
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    if (this.healthyTimer) this.clearTimer(this.healthyTimer);
    this.timer = null;
    this.healthyTimer = null;
    if (!this.currentCommit) return;
    try {
      const state = readAutoUpdateState(this.statePath);
      const next = transitionRollbackState(state, {
        type: "clean-shutdown",
        currentCommit: this.currentCommit,
      });
      writeAutoUpdateState(this.statePath, next.state);
    } catch {
      this.log(
        "[gobot-channel-bgos] auto-update could not record clean shutdown; daemon shutdown will continue",
      );
    }
  }

  async dryRunCheck(): Promise<GitUpdateCheck> {
    const check = checkGitUpdate({
      checkoutDir: this.deps.checkoutDir,
      expectedPackageName: this.deps.expectedPackageName,
      runner: this.runner,
    });
    this.log(formatGitUpdateDecision(check));
    return check;
  }

  private recordFlagReset(): void {
    try {
      const state = readAutoUpdateState(this.statePath);
      if (!state.disabled || state.resetSeen) return;
      const next = transitionRollbackState(state, { type: "flag-off" });
      writeAutoUpdateState(this.statePath, next.state);
    } catch {
      this.log(
        "[gobot-channel-bgos] auto-update reset marker could not be recorded; updates remain off",
      );
    }
  }

  private armHealthyTimer(commit: string): void {
    this.healthyTimer = this.setTimer(() => {
      try {
        const state = readAutoUpdateState(this.statePath);
        const next = transitionRollbackState(state, {
          type: "healthy",
          currentCommit: commit,
        });
        writeAutoUpdateState(this.statePath, next.state);
        this.armNextCheck();
      } catch {
        this.log(
          "[gobot-channel-bgos] auto-update could not record healthy boot; rollback protection remains armed",
        );
      }
    }, HEALTHY_BOOT_MS);
    this.healthyTimer.unref?.();
  }

  private armNextCheck(): void {
    if (this.stopped || this.timer) return;
    const delay = UPDATE_INTERVAL_MS + updateJitterMs(this.random());
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.checkAndApply().finally(() => this.armNextCheck());
    }, delay);
    this.timer.unref?.();
  }

  private async checkAndApply(): Promise<AutoUpdateStartResult> {
    if (this.checking || this.stopped) return "running";
    this.checking = true;
    try {
      const persisted = readAutoUpdateState(this.statePath);
      const check = checkGitUpdate({
        checkoutDir: this.deps.checkoutDir,
        expectedPackageName: this.deps.expectedPackageName,
        ...(persisted.upstreamRef
          ? { upstreamRef: persisted.upstreamRef }
          : {}),
        runner: this.runner,
      });
      this.log(formatGitUpdateDecision(check));
      if (
        check.decision !== "update-available" ||
        !check.checkoutRoot ||
        !check.runningVersion ||
        !check.latestVersion ||
        !check.currentCommit ||
        !check.targetCommit ||
        !check.upstreamRef
      ) {
        return "running";
      }

      const staged = transitionRollbackState(
        readAutoUpdateState(this.statePath),
        {
          type: "update-staged",
          previousCommit: check.currentCommit,
          previousVersion: check.runningVersion,
          targetCommit: check.targetCommit,
          targetVersion: check.latestVersion,
          lockfileChanged: check.lockfileChanged ?? false,
          upstreamRef: check.upstreamRef,
        },
      );
      writeAutoUpdateState(this.statePath, staged.state);
      await this.drain();

      const merged = this.runner(
        "git",
        ["merge", "--ff-only", check.targetCommit],
        check.checkoutRoot,
      );
      if (merged.status !== 0) {
        this.cancelStagedUpdate();
        this.log(
          `[gobot-channel-bgos] auto-update was not applied because the fast-forward failed: ${commandFailure(merged)}`,
        );
        await this.resume();
        return "running";
      }

      if (check.lockfileChanged) {
        const installed = this.installDependencies(check.checkoutRoot);
        if (installed.status !== 0) {
          this.log(
            `[gobot-channel-bgos] dependency install failed after update: ${commandFailure(installed)}`,
          );
          const restored = this.restoreCommit(
            check.checkoutRoot,
            check.currentCommit,
            true,
          );
          if (restored.checkoutRestored && restored.dependenciesReady) {
            this.cancelStagedUpdate();
          } else if (restored.checkoutRestored) {
            const disabled = transitionRollbackState(
              readAutoUpdateState(this.statePath),
              { type: "rolled-back" },
            );
            writeAutoUpdateState(this.statePath, disabled.state);
            this.stopped = true;
            this.log(
              "[gobot-channel-bgos] auto-update restored the previous commit but could not restore dependencies; updates are disabled until the flag is reset",
            );
          } else {
            this.stopped = true;
          }
          await this.resume();
          return "running";
        }
      }

      await this.shutdownForRestart();
      this.log(
        `[gobot-channel-bgos] auto-update applied ${check.runningVersion} to ${check.latestVersion}; exiting cleanly for supervisor restart`,
      );
      this.stopped = true;
      this.exit(0);
      return "exit-requested";
    } catch (error) {
      this.log(
        `[gobot-channel-bgos] auto-update check failed; daemon will continue: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await this.resume();
      } catch {
        this.log(
          "[gobot-channel-bgos] auto-update could not resume intake after a failed update attempt",
        );
      }
      return "running";
    } finally {
      this.checking = false;
    }
  }

  private cancelStagedUpdate(): void {
    const next = transitionRollbackState(readAutoUpdateState(this.statePath), {
      type: "update-cancelled",
    });
    writeAutoUpdateState(this.statePath, next.state);
  }

  private async rollback(
    checkoutRoot: string,
    state: AutoUpdateState,
  ): Promise<AutoUpdateStartResult> {
    const pending = state.pending;
    if (!pending) return "running";
    await this.drain();
    const restored = this.restoreCommit(
      checkoutRoot,
      pending.previousCommit,
      pending.lockfileChanged,
    );
    if (!restored.checkoutRestored) {
      this.log(
        "[gobot-channel-bgos] rollback could not restore the previous commit; daemon will continue without running another update check",
      );
      await this.resume();
      return "running";
    }
    const rolledBack = transitionRollbackState(state, { type: "rolled-back" });
    writeAutoUpdateState(this.statePath, rolledBack.state);
    await this.shutdownForRestart();
    this.log(
      `[gobot-channel-bgos] auto-update rolled back to ${pending.previousVersion} after two short boots; updates are disabled until the flag is reset`,
    );
    this.stopped = true;
    this.exit(0);
    return "exit-requested";
  }

  private restoreCommit(
    checkoutRoot: string,
    commit: string,
    reinstall: boolean,
  ): { checkoutRestored: boolean; dependenciesReady: boolean } {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      return { checkoutRestored: false, dependenciesReady: false };
    }
    const restored = this.runner(
      "git",
      ["checkout", "--detach", commit],
      checkoutRoot,
    );
    if (restored.status !== 0) {
      this.log(
        `[gobot-channel-bgos] rollback checkout failed: ${commandFailure(restored)}`,
      );
      return { checkoutRestored: false, dependenciesReady: false };
    }
    if (reinstall) {
      const installed = this.installDependencies(checkoutRoot);
      if (installed.status !== 0) {
        this.log(
          `[gobot-channel-bgos] rollback dependency install failed: ${commandFailure(installed)}`,
        );
        return { checkoutRestored: true, dependenciesReady: false };
      }
    }
    return { checkoutRestored: true, dependenciesReady: true };
  }

  private async shutdownForRestart(): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      this.log(
        `[gobot-channel-bgos] graceful shutdown reported an error; supervisor restart will continue: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private installDependencies(checkoutRoot: string): CommandResult {
    const hasLockfile = LOCKFILES.some((name) =>
      existsSync(join(checkoutRoot, name)),
    );
    return this.runner(
      this.deps.bunPath ?? "bun",
      hasLockfile ? ["install", "--frozen-lockfile"] : ["install"],
      checkoutRoot,
    );
  }
}
