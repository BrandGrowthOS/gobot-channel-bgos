/**
 * One-click update telemetry (wire contract v1, section 1 heartbeat
 * extension; canonical contract: BrandGrowthOS/BGOS
 * docs/handoff/one-click-plugin-update/wire-contract.md).
 *
 * Assembles the two OPTIONAL heartbeat fields the backend renders into the
 * pairing's update_state:
 *   latestKnownVersion  - newest version this daemon found at its OWN pinned
 *                         source (the npm registry), checked at most daily,
 *                         null on any failure.
 *   updateReadiness     - { supervised, autoUpdateEnabled, rollbackLatched,
 *                         pendingRestartVersion }.
 *
 * Everything here is best-effort and fail-closed: a broken state file reads
 * as latched, a missing fork root reads as no pending restart, a registry
 * failure reads as null. Telemetry must never break a heartbeat.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  autoUpdateStatePath,
  parseAutoUpdateFlag,
  readAutoUpdateState,
  readInstalledPluginVersion,
  readLatestRegistryVersion,
  PLUGIN_PACKAGE_NAME,
  WRAPPED_BOOT_COMMIT_ENV,
} from "./self-update.js";
import { parseExactStableNpmVersion, parseForkPluginConstraint, candidateSatisfiesForkPluginConstraint } from "./update-version-policy.js";

/** Contract enum for updateReadiness.supervised (besides 'none'). */
export const SUPERVISED_KINDS = [
  "systemd",
  "launchd",
  "launcher",
  "supervise-npm",
  "pm2",
] as const;

export type SupervisedKind = (typeof SUPERVISED_KINDS)[number] | "none";

/**
 * Resolve whether a supervisor will relaunch this host after an exit.
 * The host declares its own supervisor via BGOS_SUPERVISED (contract enum
 * values only; anything else is ignored). Without a declaration, a boot
 * under the package-owned daemon wrapper counts as 'launcher': the wrapper
 * child inherits the wrapped-boot commit marker, and setup only installs
 * the wrapper under launchd or systemd. Everything else is 'none'.
 */
export function resolveSupervised(
  env: Record<string, string | undefined> = process.env,
): SupervisedKind {
  const declared = (env.BGOS_SUPERVISED ?? "").trim();
  if ((SUPERVISED_KINDS as readonly string[]).includes(declared)) {
    return declared as SupervisedKind;
  }
  if (env[WRAPPED_BOOT_COMMIT_ENV]) return "launcher";
  return "none";
}

export interface UpdateReadiness {
  supervised: SupervisedKind;
  autoUpdateEnabled: boolean;
  rollbackLatched: boolean;
  pendingRestartVersion: string | null;
}

/** The in-process host's dependency range is stricter than same-major. */
export function forkAcceptsPluginVersion(root: string, version: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const spec = manifest.dependencies?.[PLUGIN_PACKAGE_NAME] ?? manifest.optionalDependencies?.[PLUGIN_PACKAGE_NAME];
    const constraint = typeof spec === "string" ? parseForkPluginConstraint(spec) : null;
    return constraint !== null && candidateSatisfiesForkPluginConstraint(version, constraint);
  } catch {
    return false;
  }
}

export interface UpdateTelemetry {
  latestKnownVersion: string | null;
  updateReadiness: UpdateReadiness;
}

/**
 * The rollback latch: after an automatic rollback the state file records
 * disabled until one supervised boot with BGOS_AUTO_UPDATE=off resets it.
 * A malformed (or unreadable) state file also keeps updates off, so it
 * reads as latched here - fail closed, matching AutoUpdateController.
 */
export function readRollbackLatched(
  env: Record<string, string | undefined> = process.env,
): boolean {
  try {
    const state = readAutoUpdateState(autoUpdateStatePath(env));
    return state.disabled && !state.resetSeen;
  } catch {
    return true;
  }
}

const FORK_ROOT_MAX_WALK = 30;

/**
 * Resolve the fork checkout root: walk UP from GOBOT_INSTALL_DIR (or the
 * working directory) to the nearest package.json that lists
 * gobot-channel-bgos in dependencies or optionalDependencies - the manifest
 * shape the fork loader contract requires. Returns null when no such
 * manifest exists on the path to the filesystem root.
 */
export function resolveForkRoot(
  opts: {
    startDir?: string;
    env?: Record<string, string | undefined>;
  } = {},
): string | null {
  const env = opts.env ?? process.env;
  const configured =
    opts.startDir ?? env.GOBOT_INSTALL_DIR ?? process.cwd();
  let dir = resolve(
    configured.startsWith("~")
      ? join(homedir(), configured.slice(1))
      : configured,
  );
  for (let step = 0; step < FORK_ROOT_MAX_WALK; step++) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      for (const groupName of ["dependencies", "optionalDependencies"]) {
        const group = manifest[groupName];
        if (!group || typeof group !== "object") continue;
        const spec = (group as Record<string, unknown>)[PLUGIN_PACKAGE_NAME];
        if (typeof spec === "string") return dir;
      }
    } catch {
      /* no manifest here (or unreadable); keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** How often the npm registry is asked for the latest version (daily). */
export const LATEST_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateTelemetrySourceDeps {
  /** The RUNNING daemon version (getPackageVersion()). */
  runningVersion: string;
  env?: Record<string, string | undefined>;
  /** Injectable for tests; defaults to the npm registry latest read. */
  registryVersionReader?: () => Promise<string>;
  forkRootResolver?: () => string | null;
  installedPluginVersionReader?: (checkoutRoot: string) => string | null;
  latchReader?: () => boolean;
  now?: () => number;
}

/**
 * Snapshot provider the HeartbeatController pulls per network post. The
 * snapshot itself is synchronous (a heartbeat must never wait on the npm
 * registry); it kicks a background daily refresh of latestKnownVersion and
 * serves the cached value (null until the first refresh lands, null again
 * after a failed one).
 */
export class UpdateTelemetrySource {
  private latestKnownVersion: string | null = null;
  private lastCheckAtMs: number | null = null;
  private refreshInFlight: Promise<void> | null = null;

  private readonly env: Record<string, string | undefined>;
  private readonly registryVersionReader: () => Promise<string>;
  private readonly forkRootResolver: () => string | null;
  private readonly installedPluginVersionReader: (
    checkoutRoot: string,
  ) => string | null;
  private readonly latchReader: () => boolean;
  private readonly now: () => number;

  constructor(private readonly deps: UpdateTelemetrySourceDeps) {
    this.env = deps.env ?? process.env;
    this.registryVersionReader =
      deps.registryVersionReader ?? readLatestRegistryVersion;
    this.forkRootResolver =
      deps.forkRootResolver ?? (() => resolveForkRoot({ env: this.env }));
    this.installedPluginVersionReader =
      deps.installedPluginVersionReader ?? readInstalledPluginVersion;
    this.latchReader = deps.latchReader ?? (() => readRollbackLatched(this.env));
    this.now = deps.now ?? (() => Date.now());
  }

  snapshot(): UpdateTelemetry {
    this.maybeRefresh();
    return {
      latestKnownVersion: this.latestKnownVersion,
      updateReadiness: {
        supervised: resolveSupervised(this.env),
        autoUpdateEnabled: parseAutoUpdateFlag(this.env.BGOS_AUTO_UPDATE) === "on",
        rollbackLatched: this.safeLatchRead(),
        pendingRestartVersion: this.readPendingRestartVersion(),
      },
    };
  }

  /** Awaitable seam for tests (and callers that want a fresh read now). */
  whenIdle(): Promise<void> {
    return this.refreshInFlight ?? Promise.resolve();
  }

  private maybeRefresh(): void {
    if (this.refreshInFlight) return;
    const now = this.now();
    if (
      this.lastCheckAtMs !== null &&
      now - this.lastCheckAtMs < LATEST_CHECK_INTERVAL_MS
    ) {
      return;
    }
    this.lastCheckAtMs = now;
    this.refreshInFlight = this.refreshLatest().finally(() => {
      this.refreshInFlight = null;
    });
  }

  private async refreshLatest(): Promise<void> {
    try {
      const latest = await this.registryVersionReader();
      this.latestKnownVersion = parseExactStableNpmVersion(latest)
        ? latest
        : null;
    } catch {
      this.latestKnownVersion = null;
    }
  }

  private safeLatchRead(): boolean {
    try {
      return this.latchReader();
    } catch {
      return true;
    }
  }

  /**
   * The version installed ON DISK at the fork root when it differs from the
   * version RUNNING in this process - i.e. a staged update awaiting the next
   * host restart. Null when they match or nothing is resolvable.
   */
  private readPendingRestartVersion(): string | null {
    try {
      const forkRoot = this.forkRootResolver();
      if (!forkRoot) return null;
      const installed = this.installedPluginVersionReader(forkRoot);
      if (!installed || installed === this.deps.runningVersion) return null;
      return installed;
    } catch {
      return null;
    }
  }
}
