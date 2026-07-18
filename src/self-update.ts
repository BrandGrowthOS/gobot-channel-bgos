import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  candidateSatisfiesForkPluginConstraint,
  parseExactStableNpmVersion,
  parseForkPluginConstraint,
} from "./update-version-policy.js";

export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const MAX_UPDATE_JITTER_MS = 6 * 60 * 60 * 1000;
export const HEALTHY_BOOT_MS = 60_000;
export const ACTIVE_WORK_RETRY_MS = 60_000;
export const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
export const REGISTRY_TIMEOUT_MS = 10_000;
export const PLUGIN_PACKAGE_NAME = "gobot-channel-bgos";
export const PLUGIN_REGISTRY_URL =
  `https://registry.npmjs.org/${PLUGIN_PACKAGE_NAME}/latest`;
export const WRAPPED_BOOT_COMMIT_ENV =
  "BGOS_INTERNAL_WRAPPED_BOOT_COMMIT";

const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const;
const DEPENDENCY_FILES = ["package.json", ...LOCKFILES] as const;

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
  previousPluginVersion: string;
  targetCommit: string;
  targetPluginVersion: string;
  crashCount: number;
  bootStartedAtMs: number | null;
  dependencyFilesChanged: boolean;
  rollbackRequired: boolean;
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
      previousPluginVersion: string;
      targetCommit: string;
      targetPluginVersion: string;
      dependencyFilesChanged: boolean;
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
      previousPluginVersion: event.previousPluginVersion,
      targetCommit: event.targetCommit,
      targetPluginVersion: event.targetPluginVersion,
      crashCount: 0,
      bootStartedAtMs: null,
      dependencyFilesChanged: event.dependencyFilesChanged,
      rollbackRequired: false,
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
  if (pending.rollbackRequired) {
    return { state: current, action: "rollback" };
  }
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
    pending.rollbackRequired = true;
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
    /^[0-9a-f]{40,64}$/i.test(pending.previousCommit) &&
    typeof pending.previousPluginVersion === "string" &&
    parseExactStableNpmVersion(pending.previousPluginVersion) !== null &&
    typeof pending.targetCommit === "string" &&
    /^[0-9a-f]{40,64}$/i.test(pending.targetCommit) &&
    typeof pending.targetPluginVersion === "string" &&
    parseExactStableNpmVersion(pending.targetPluginVersion) !== null &&
    Number.isInteger(pending.crashCount) &&
    (pending.crashCount ?? -1) >= 0 &&
    (pending.bootStartedAtMs === null ||
      (typeof pending.bootStartedAtMs === "number" &&
        Number.isFinite(pending.bootStartedAtMs))) &&
    typeof pending.dependencyFilesChanged === "boolean" &&
    typeof pending.rollbackRequired === "boolean"
  );
}

function isState(value: unknown): value is AutoUpdateState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<AutoUpdateState>;
  return (
    state.schemaVersion === 1 &&
    typeof state.disabled === "boolean" &&
    typeof state.resetSeen === "boolean" &&
    (state.upstreamRef === null ||
      (typeof state.upstreamRef === "string" &&
        isSafeUpstreamRef(state.upstreamRef))) &&
    (state.pending === null || isPendingState(state.pending))
  );
}

export class MalformedAutoUpdateStateError extends Error {
  constructor(path: string) {
    super(`auto-update state is malformed: ${path}`);
    this.name = "MalformedAutoUpdateStateError";
  }
}

export function readAutoUpdateState(path: string): AutoUpdateState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(EMPTY_AUTO_UPDATE_STATE);
    }
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isState(parsed)) return parsed;
  } catch {
    throw new MalformedAutoUpdateStateError(path);
  }
  throw new MalformedAutoUpdateStateError(path);
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
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: "SIGTERM",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
  commit: string;
}

export type GitCheckDecision =
  | "update-available"
  | "current"
  | "major-blocked"
  | "incompatible-plugin"
  | "unsafe-plugin-constraint"
  | "not-fast-forward"
  | "not-gobot-checkout"
  | "no-upstream"
  | "invalid-version"
  | "check-failed";

export interface GitUpdateCheck {
  decision: GitCheckDecision;
  detail: string;
  checkoutRoot?: string;
  runningDaemonVersion?: string;
  candidateDaemonVersion?: string;
  currentCommit?: string;
  targetCommit?: string;
  dependencyFilesChanged?: boolean;
  pluginConstraint?: string;
  upstreamRef?: string;
}

export type RegistryVersionReader = () => Promise<string>;

export interface GitUpdateOptions {
  checkoutDir?: string;
  expectedPackageName?: string;
  upstreamRef?: string;
  runningDaemonVersion?: string;
  registryVersionReader?: RegistryVersionReader;
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
    };
    if (manifest.name !== (options.expectedPackageName ?? "gobot")) {
      return { detail: `checkout package is ${manifest.name ?? "unknown"}, expected ${options.expectedPackageName ?? "gobot"}` };
    }
    const head = runner("git", ["rev-parse", "HEAD"], root);
    const commit = head.stdout.trim();
    if (head.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      return { detail: "checkout HEAD could not be resolved" };
    }
    return { info: { root, commit } };
  } catch {
    return { detail: "checkout package.json could not be read" };
  }
}

export async function readLatestRegistryVersion(): Promise<string> {
  const response = await fetch(PLUGIN_REGISTRY_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`npm registry returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string") {
    throw new Error("npm registry response has no version");
  }
  return body.version;
}

function pluginConstraintFromManifest(
  manifest: Record<string, unknown>,
): string | null {
  const dependencyGroups = ["optionalDependencies", "dependencies"] as const;
  const specs = new Set<string>();
  for (const groupName of dependencyGroups) {
    const group = manifest[groupName];
    if (!group || typeof group !== "object") continue;
    const spec = (group as Record<string, unknown>)[PLUGIN_PACKAGE_NAME];
    if (typeof spec === "string") specs.add(spec);
  }
  return specs.size === 1 ? [...specs][0] : null;
}

export function readInstalledPluginVersion(
  checkoutRoot: string,
): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(
        join(
          checkoutRoot,
          "node_modules",
          PLUGIN_PACKAGE_NAME,
          "package.json",
        ),
        "utf8",
      ),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

export async function checkGitUpdate(
  options: GitUpdateOptions = {},
): Promise<GitUpdateCheck> {
  const runner = options.runner ?? runCommand;
  try {
    const checkout = readCheckout(options);
    if (!checkout.info) {
      return {
        decision: "not-gobot-checkout",
        detail: checkout.detail ?? "install checkout could not be verified",
      };
    }
    const { root, commit } = checkout.info;
    const runningDaemonVersion = options.runningDaemonVersion ?? "";
    if (!parseExactStableNpmVersion(runningDaemonVersion)) {
      return {
        decision: "invalid-version",
        detail: `running daemon version is not an exact stable version: ${runningDaemonVersion || "missing"}`,
        checkoutRoot: root,
        currentCommit: commit,
      };
    }
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
        runningDaemonVersion,
        currentCommit: commit,
      };
    }

    const fetched = runner("git", ["fetch", "--quiet"], root);
    if (fetched.status !== 0) {
      return {
        decision: "check-failed",
        detail: `git fetch failed: ${commandFailure(fetched)}`,
        checkoutRoot: root,
        runningDaemonVersion,
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
        runningDaemonVersion,
        currentCommit: commit,
      };
    }
    if (targetCommit !== commit) {
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
          runningDaemonVersion,
          currentCommit: commit,
          targetCommit,
        };
      }
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
        runningDaemonVersion,
        currentCommit: commit,
        targetCommit,
      };
    }
    let targetManifest: Record<string, unknown>;
    try {
      targetManifest = JSON.parse(latestManifest.stdout) as Record<
        string,
        unknown
      >;
      if (
        targetManifest.name !== (options.expectedPackageName ?? "gobot")
      ) {
        throw new Error("unexpected package");
      }
    } catch {
      return {
        decision: "check-failed",
        detail: "upstream package.json is invalid",
        checkoutRoot: root,
        runningDaemonVersion,
        currentCommit: commit,
        targetCommit,
      };
    }

    const pluginConstraint = pluginConstraintFromManifest(targetManifest);
    const parsedConstraint = pluginConstraint
      ? parseForkPluginConstraint(pluginConstraint)
      : null;
    if (!pluginConstraint || !parsedConstraint) {
      return {
        decision: "unsafe-plugin-constraint",
        detail: "upstream package.json has no safe exact or caret gobot-channel-bgos constraint",
        checkoutRoot: root,
        runningDaemonVersion,
        currentCommit: commit,
        targetCommit,
      };
    }

    let candidateDaemonVersion: string;
    try {
      candidateDaemonVersion = await (
        options.registryVersionReader ?? readLatestRegistryVersion
      )();
    } catch (error) {
      return {
        decision: "check-failed",
        detail: `npm registry lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        checkoutRoot: root,
        runningDaemonVersion,
        currentCommit: commit,
        targetCommit,
        pluginConstraint,
      };
    }
    if (!parseExactStableNpmVersion(candidateDaemonVersion)) {
      return {
        decision: "invalid-version",
        detail: `npm registry candidate is not an exact stable version: ${candidateDaemonVersion}`,
        checkoutRoot: root,
        runningDaemonVersion,
        currentCommit: commit,
        targetCommit,
        pluginConstraint,
      };
    }
    if (
      !candidateSatisfiesForkPluginConstraint(
        candidateDaemonVersion,
        parsedConstraint,
      )
    ) {
      return {
        decision: "incompatible-plugin",
        detail: `registry daemon ${candidateDaemonVersion} is outside fork constraint ${pluginConstraint}`,
        checkoutRoot: root,
        runningDaemonVersion,
        candidateDaemonVersion,
        currentCommit: commit,
        targetCommit,
        pluginConstraint,
      };
    }

    const versionDecision = decideVersionUpdate(
      runningDaemonVersion,
      candidateDaemonVersion,
    );
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
            ? `registry daemon ${candidateDaemonVersion} changes major from ${runningDaemonVersion}`
            : decision === "invalid-version"
              ? `could not compare daemon versions ${runningDaemonVersion} and ${candidateDaemonVersion}`
              : `running daemon ${runningDaemonVersion} is not older than registry ${candidateDaemonVersion}`,
        checkoutRoot: root,
        runningDaemonVersion,
        candidateDaemonVersion,
        currentCommit: commit,
        targetCommit,
        pluginConstraint,
        upstreamRef,
      };
    }

    let dependencyFilesChanged = false;
    if (targetCommit !== commit) {
      const dependencyDiff = runner(
        "git",
        [
          "diff",
          "--name-only",
          commit,
          targetCommit,
          "--",
          ...DEPENDENCY_FILES,
        ],
        root,
      );
      if (dependencyDiff.status !== 0) {
        return {
          decision: "check-failed",
          detail: "dependency file comparison failed",
          checkoutRoot: root,
          runningDaemonVersion,
          candidateDaemonVersion,
          currentCommit: commit,
          targetCommit,
          pluginConstraint,
        };
      }
      const changedNames = new Set(
        dependencyDiff.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      dependencyFilesChanged = DEPENDENCY_FILES.some((name) =>
        changedNames.has(name),
      );
    }
    return {
      decision: "update-available",
      detail: `registry daemon ${candidateDaemonVersion} is available for running ${runningDaemonVersion} within fork constraint ${pluginConstraint}`,
      checkoutRoot: root,
      runningDaemonVersion,
      candidateDaemonVersion,
      currentCommit: commit,
      targetCommit,
      dependencyFilesChanged,
      pluginConstraint,
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
  hasActiveWork?: () => boolean;
  preImportOnly?: boolean;
  installedPluginVersionReader?: (checkoutRoot: string) => string | null;
}

export type AutoUpdateStartResult =
  | "inactive"
  | "running"
  | "retry-required"
  | "exit-requested";

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
  private readonly hasActiveWork: () => boolean;
  private readonly preImportOnly: boolean;
  private readonly installedPluginVersionReader: (
    checkoutRoot: string,
  ) => string | null;
  private timer: NodeJS.Timeout | null = null;
  private healthyTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private currentCommit: string | null = null;
  private checking = false;
  private cleanShutdownOwnedByWrapper = false;

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
    this.hasActiveWork = deps.hasActiveWork ?? (() => false);
    this.preImportOnly = deps.preImportOnly ?? false;
    this.installedPluginVersionReader =
      deps.installedPluginVersionReader ?? readInstalledPluginVersion;
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
      let state: AutoUpdateState;
      try {
        state = readAutoUpdateState(this.statePath);
      } catch (error) {
        if (error instanceof MalformedAutoUpdateStateError) {
          this.log(
            "[gobot-channel-bgos] auto-update state is malformed; updates are disabled until one off boot resets the state",
          );
          return "inactive";
        }
        throw error;
      }
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
      const wrappedCommit = this.env[WRAPPED_BOOT_COMMIT_ENV];
      this.cleanShutdownOwnedByWrapper =
        !this.preImportOnly && wrappedCommit === checkout.info.commit;
      const boot = this.cleanShutdownOwnedByWrapper
        ? { state, action: "continue" as const }
        : transitionRollbackState(state, {
            type: "boot",
            nowMs: this.now(),
            currentCommit: checkout.info.commit,
          });
      state = boot.state;
      if (!this.cleanShutdownOwnedByWrapper) {
        writeAutoUpdateState(this.statePath, state);
      }
      if (this.preImportOnly) {
        this.env[WRAPPED_BOOT_COMMIT_ENV] = checkout.info.commit;
      }

      if (boot.action === "rollback" && state.pending) {
        return await this.rollback(checkout.info.root, state);
      }
      if (state.pending) {
        if (this.preImportOnly) return "running";
        this.armHealthyTimer(
          checkout.info.commit,
          this.remainingHealthyDelay(state.pending.bootStartedAtMs),
        );
        return "running";
      }
      if (this.preImportOnly) return "running";

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
    if (this.cleanShutdownOwnedByWrapper) return;
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
    const check = await checkGitUpdate({
      checkoutDir: this.deps.checkoutDir,
      expectedPackageName: this.deps.expectedPackageName,
      runningDaemonVersion: this.deps.runningDaemonVersion,
      registryVersionReader: this.deps.registryVersionReader,
      runner: this.runner,
    });
    this.log(formatGitUpdateDecision(check));
    return check;
  }

  private recordFlagReset(): void {
    try {
      let state: AutoUpdateState;
      try {
        state = readAutoUpdateState(this.statePath);
      } catch (error) {
        if (!(error instanceof MalformedAutoUpdateStateError)) throw error;
        writeAutoUpdateState(this.statePath, {
          schemaVersion: 1,
          disabled: true,
          resetSeen: true,
          upstreamRef: null,
          pending: null,
        });
        return;
      }
      if (!state.disabled || state.resetSeen) return;
      const next = transitionRollbackState(state, { type: "flag-off" });
      writeAutoUpdateState(this.statePath, next.state);
    } catch {
      this.log(
        "[gobot-channel-bgos] auto-update reset marker could not be recorded; updates remain off",
      );
    }
  }

  private remainingHealthyDelay(bootStartedAtMs: number | null): number {
    if (bootStartedAtMs === null) return HEALTHY_BOOT_MS;
    const age = Math.max(0, this.now() - bootStartedAtMs);
    return Math.max(0, HEALTHY_BOOT_MS - age);
  }

  private armHealthyTimer(commit: string, delayMs = HEALTHY_BOOT_MS): void {
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
    }, delayMs);
    this.healthyTimer.unref?.();
  }

  private armNextCheck(delayOverrideMs?: number): void {
    if (this.stopped || this.timer) return;
    const delay =
      delayOverrideMs ?? UPDATE_INTERVAL_MS + updateJitterMs(this.random());
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.stopped) return;
      if (this.hasActiveWork()) {
        this.armNextCheck(ACTIVE_WORK_RETRY_MS);
        return;
      }
      void this.checkAndApply().finally(() => this.armNextCheck());
    }, delay);
    this.timer.unref?.();
  }

  private async checkAndApply(): Promise<AutoUpdateStartResult> {
    if (this.checking || this.stopped) return "running";
    this.checking = true;
    try {
      const persisted = readAutoUpdateState(this.statePath);
      const check = await checkGitUpdate({
        checkoutDir: this.deps.checkoutDir,
        expectedPackageName: this.deps.expectedPackageName,
        runningDaemonVersion: this.deps.runningDaemonVersion,
        registryVersionReader: this.deps.registryVersionReader,
        ...(persisted.upstreamRef
          ? { upstreamRef: persisted.upstreamRef }
          : {}),
        runner: this.runner,
      });
      this.log(formatGitUpdateDecision(check));
      if (
        check.decision !== "update-available" ||
        !check.checkoutRoot ||
        !check.runningDaemonVersion ||
        !check.candidateDaemonVersion ||
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
          previousPluginVersion: check.runningDaemonVersion,
          targetCommit: check.targetCommit,
          targetPluginVersion: check.candidateDaemonVersion,
          dependencyFilesChanged: check.dependencyFilesChanged ?? false,
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

      let installFailure: CommandResult | null = null;
      if (check.dependencyFilesChanged) {
        const installed = this.installDependencies(check.checkoutRoot);
        if (installed.status !== 0) installFailure = installed;
      }
      if (!installFailure) {
        const pluginInstalled = this.installExactPlugin(
          check.checkoutRoot,
          check.candidateDaemonVersion,
        );
        if (pluginInstalled.status !== 0) installFailure = pluginInstalled;
      }
      if (installFailure) {
        this.log(
          `[gobot-channel-bgos] dependency refresh failed after update: ${commandFailure(installFailure)}`,
        );
        const restored = this.restoreCommit(
          check.checkoutRoot,
          check.currentCommit,
          check.dependencyFilesChanged ?? false,
          check.runningDaemonVersion,
        );
        if (this.restoreReady(restored)) {
          this.cancelStagedUpdate();
        } else {
          this.markRollbackRequired();
          this.stopped = true;
          this.log(
            "[gobot-channel-bgos] update recovery is incomplete; rollback remains pending for the next supervised boot",
          );
        }
        await this.resume();
        return "running";
      }

      await this.shutdownForRestart();
      this.log(
        `[gobot-channel-bgos] auto-update installed daemon ${check.runningDaemonVersion} to ${check.candidateDaemonVersion} at checkout ${check.targetCommit}; exiting cleanly for supervisor restart`,
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

  private markRollbackRequired(): void {
    const state = readAutoUpdateState(this.statePath);
    if (!state.pending) return;
    state.pending.rollbackRequired = true;
    writeAutoUpdateState(this.statePath, state);
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
      pending.dependencyFilesChanged,
      pending.previousPluginVersion,
    );
    if (!this.restoreReady(restored)) {
      this.stopped = true;
      const targetRestored = this.restoreCommit(
        checkoutRoot,
        pending.targetCommit,
        pending.dependencyFilesChanged,
        pending.targetPluginVersion,
      );
      this.log(
        this.restoreReady(targetRestored)
          ? "[gobot-channel-bgos] rollback restoration failed; the target environment was restored and rollback will retry on the next boot"
          : "[gobot-channel-bgos] rollback restoration failed; rollback remains pending and requires operator attention",
      );
      await this.resume();
      return this.preImportOnly ? "retry-required" : "running";
    }
    const rolledBack = transitionRollbackState(state, { type: "rolled-back" });
    writeAutoUpdateState(this.statePath, rolledBack.state);
    await this.shutdownForRestart();
    this.log(
      `[gobot-channel-bgos] auto-update rolled back checkout ${pending.previousCommit} and daemon ${pending.previousPluginVersion} after two short boots; updates are disabled until the flag is reset`,
    );
    this.stopped = true;
    this.exit(0);
    return "exit-requested";
  }

  private restoreCommit(
    checkoutRoot: string,
    commit: string,
    reinstallDependencies: boolean,
    pluginVersion: string,
  ): {
    checkoutRestored: boolean;
    dependenciesReady: boolean;
    pluginReady: boolean;
  } {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
      return {
        checkoutRestored: false,
        dependenciesReady: false,
        pluginReady: false,
      };
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
      return {
        checkoutRestored: false,
        dependenciesReady: false,
        pluginReady: false,
      };
    }
    let dependenciesReady = true;
    if (reinstallDependencies) {
      const installed = this.installDependencies(checkoutRoot);
      if (installed.status !== 0) {
        this.log(
          `[gobot-channel-bgos] rollback dependency install failed: ${commandFailure(installed)}`,
        );
        dependenciesReady = false;
      }
    }
    const pluginInstalled = this.installExactPlugin(
      checkoutRoot,
      pluginVersion,
    );
    const pluginReady = pluginInstalled.status === 0;
    if (!pluginReady) {
      this.log(
        `[gobot-channel-bgos] rollback daemon package restore failed: ${commandFailure(pluginInstalled)}`,
      );
    }
    return { checkoutRestored: true, dependenciesReady, pluginReady };
  }

  private restoreReady(restored: {
    checkoutRestored: boolean;
    dependenciesReady: boolean;
    pluginReady: boolean;
  }): boolean {
    return (
      restored.checkoutRestored &&
      restored.dependenciesReady &&
      restored.pluginReady
    );
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
    const tracked = this.trackedDependencyFiles(checkoutRoot);
    if (!tracked.files) return tracked.failure;
    const hasTrackedLockfile = tracked.files.some((name) =>
      (LOCKFILES as readonly string[]).includes(name),
    );
    return this.runBunPreservingTrackedFiles(
      checkoutRoot,
      hasTrackedLockfile
        ? ["install", "--frozen-lockfile"]
        : ["install"],
      tracked.files,
    );
  }

  private installExactPlugin(
    checkoutRoot: string,
    version: string,
  ): CommandResult {
    if (!parseExactStableNpmVersion(version)) {
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: `unsafe daemon package version: ${version}`,
      };
    }
    const tracked = this.trackedDependencyFiles(checkoutRoot);
    if (!tracked.files) return tracked.failure;
    const installed = this.runBunPreservingTrackedFiles(
      checkoutRoot,
      ["install", `${PLUGIN_PACKAGE_NAME}@${version}`, "--no-save"],
      tracked.files,
    );
    if (installed.status !== 0) return installed;
    const actual = this.installedPluginVersionReader(checkoutRoot);
    if (actual !== version) {
      return {
        status: null,
        stdout: installed.stdout,
        stderr: installed.stderr,
        error: `installed daemon version is ${actual ?? "missing"}, expected ${version}`,
      };
    }
    return installed;
  }

  private trackedDependencyFiles(checkoutRoot: string):
    | { files: string[]; failure?: never }
    | { files?: never; failure: CommandResult } {
    const listed = this.runner(
      "git",
      ["ls-files", "--", ...DEPENDENCY_FILES],
      checkoutRoot,
    );
    if (listed.status !== 0) {
      return {
        failure: {
          status: listed.status,
          stdout: listed.stdout,
          stderr: listed.stderr,
          error: listed.error ?? "tracked dependency files could not be listed",
        },
      };
    }
    const allowed = new Set<string>(DEPENDENCY_FILES);
    const files = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => allowed.has(line));
    if (!files.includes("package.json")) {
      return {
        failure: {
          status: null,
          stdout: "",
          stderr: "",
          error: "tracked package.json could not be verified",
        },
      };
    }
    return { files };
  }

  private runBunPreservingTrackedFiles(
    checkoutRoot: string,
    args: readonly string[],
    trackedFiles: readonly string[],
  ): CommandResult {
    let snapshots: Array<{
      path: string;
      contents: Buffer;
      mode: number;
    }>;
    try {
      snapshots = trackedFiles.map((name) => {
        const path = join(checkoutRoot, name);
        return {
          path,
          contents: readFileSync(path),
          mode: statSync(path).mode & 0o777,
        };
      });
    } catch (error) {
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: `tracked dependency snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const result = this.runner(
      this.deps.bunPath ?? "bun",
      args,
      checkoutRoot,
    );
    try {
      for (const snapshot of snapshots) {
        try {
          if (readFileSync(snapshot.path).equals(snapshot.contents)) continue;
        } catch {
          // Restore a missing or unreadable tracked file below.
        }
        const temporary = `${snapshot.path}.${process.pid}.restore.tmp`;
        writeFileSync(temporary, snapshot.contents, { mode: snapshot.mode });
        renameSync(temporary, snapshot.path);
        if (!readFileSync(snapshot.path).equals(snapshot.contents)) {
          throw new Error(`${snapshot.path} did not verify after restore`);
        }
      }
    } catch (error) {
      return {
        status: null,
        stdout: result.stdout,
        stderr: result.stderr,
        error: `tracked dependency restore failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return result;
  }
}
