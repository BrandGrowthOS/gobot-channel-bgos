/**
 * update_rpc frame handler - the Gobot plugin side of BGOS's one-click
 * plugin update control plane (wire contract v1, sections 3 + 6; canonical
 * contract: BrandGrowthOS/BGOS
 * docs/handoff/one-click-plugin-update/wire-contract.md; lifecycle template:
 * the backend DoctorRpcService, daemon-side pattern: voice-rpc.ts).
 *
 * The backend pushes `update_rpc {rpcId, op:'update_now'}` into the
 * `pairing:<id>` room. The frame carries NO version, NO url, NO script by
 * design: this daemon resolves the target from its OWN pinned source (the
 * npm registry latest for gobot-channel-bgos) and refuses anything outside
 * the running major. We ACK immediately (cancels the backend's 1.5 s
 * retry-emit), then report progress:
 *
 *   POST /api/v1/integrations/update-rpc/:rpcId/ack
 *   POST /api/v1/integrations/update-rpc/:rpcId/progress
 *     { stage: 'draining'|'installing'|'restarting'|'staged'|'error',
 *       targetVersion?, message? }
 *
 * 'staged' and 'error' are daemon-terminal. After 'restarting' the backend
 * declares 'done' only from a heartbeat of THIS pairing whose daemonVersion
 * is >= targetVersion (never faked success), or 'unknown' after 5 minutes.
 *
 * Fail-closed everywhere: kill switch off -> 'updates_disabled'; rollback
 * latch -> 'rollback_latched'; no fork root -> 'fork_root_not_found'; not
 * newer / major jump / registry failure -> 'no_update_available'; install
 * failure -> 'install_failed'; installed major != running major ->
 * 'contract_major_mismatch'. The daemon NEVER exits without a verified
 * supervisor: an unsupervised host installs to disk, reports 'staged', and
 * lets pendingRestartVersion ride the next heartbeat instead.
 */

import {
  decideVersionUpdate,
  installExactPluginVersion,
  readInstalledPluginVersion,
  readLatestRegistryVersion,
  parseAutoUpdateFlag,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./self-update.js";
import { parseExactStableNpmVersion } from "./update-version-policy.js";
import {
  readRollbackLatched,
  forkAcceptsPluginVersion,
  resolveForkRoot,
  resolveSupervised,
  type SupervisedKind,
} from "./update-telemetry.js";

export type UpdateRpcOp = "update_now";

export interface UpdateRpcFrame {
  rpcId: string;
  op: UpdateRpcOp;
}

export type UpdateProgressStage =
  | "draining"
  | "installing"
  | "restarting"
  | "staged"
  | "error";

export interface UpdateRpcProgressBody {
  stage: UpdateProgressStage;
  targetVersion?: string;
  message?: string;
}

/**
 * Validate an update_rpc control frame. Ops are WHITELISTED (the voice-rpc
 * G2 lesson): a malformed frame is dropped here and the backend's own ack
 * timeout surfaces the failure as 'unreachable'.
 */
export function normalizeUpdateRpc(raw: unknown): UpdateRpcFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const rpcId = typeof r.rpcId === "string" ? r.rpcId : "";
  if (!rpcId || r.op !== "update_now") return null;
  return { rpcId, op: "update_now" };
}

/** The two REST replies the handler needs. Matches BgosApi's methods -
 *  declared structurally here so this module has no import cycle. */
export interface UpdateRpcApi {
  postUpdateRpcAck(rpcId: string): Promise<unknown>;
  postUpdateRpcProgress(
    rpcId: string,
    body: UpdateRpcProgressBody,
  ): Promise<unknown>;
}

/** Delay between the resolved 'restarting' progress POST and the graceful
 *  shutdown + supervisor restart request. */
export const RESTART_DELAY_MS = 250;
/** Hard-exit fallback if the host ignores the graceful SIGTERM. Only armed
 *  AFTER supervision was verified, so the exit is always relaunched. */
export const RESTART_HARD_EXIT_MS = 15_000;

export interface UpdateRpcDeps {
  /** Same lock as the periodic updater, held through install and drain. */
  acquireUpdate?: () => (() => void) | null;
  api: UpdateRpcApi;
  /** The RUNNING daemon version (getPackageVersion()). */
  runningVersion: string;
  /** Suspend intake + wait for in-flight work (adapter drainForUpdate). */
  drain: () => Promise<void>;
  /** Undo the drain after a post-drain failure or a staged install. */
  resume: () => Promise<void>;
  /** Graceful adapter shutdown before the supervised restart. */
  shutdown: () => Promise<void>;
  /** Request the supervised host relaunch (SIGTERM to the Gobot process). */
  restart: () => void;
  /** Fired after 'staged' so the heartbeat can carry pendingRestartVersion
   *  to the backend immediately instead of waiting a full interval. */
  onStaged?: () => void;
  env?: Record<string, string | undefined>;
  registryVersionReader?: () => Promise<string>;
  forkRootResolver?: () => string | null;
  installPlugin?: (checkoutRoot: string, version: string) => CommandResult;
  isVersionCompatible?: (checkoutRoot: string, version: string) => boolean;
  installedPluginVersionReader?: (checkoutRoot: string) => string | null;
  latchReader?: () => boolean;
  supervisedResolver?: () => SupervisedKind;
  runner?: CommandRunner;
  bunPath?: string;
  hardExit?: (code: number) => void;
  log?: (msg: string) => void;
  restartDelayMs?: number;
  hardExitDelayMs?: number;
}

export class UpdateRpcHandler {
  private readonly env: Record<string, string | undefined>;
  private readonly registryVersionReader: () => Promise<string>;
  private readonly forkRootResolver: () => string | null;
  private readonly installPlugin: (
    checkoutRoot: string,
    version: string,
  ) => CommandResult;
  private readonly installedPluginVersionReader: (
    checkoutRoot: string,
  ) => string | null;
  private readonly latchReader: () => boolean;
  private readonly supervisedResolver: () => SupervisedKind;
  private readonly hardExit: (code: number) => void;
  private readonly restartDelayMs: number;
  private readonly hardExitDelayMs: number;
  /** Duplicate-frame guard: the backend re-emits every 1.5 s until the ack
   *  lands; the rpcId is the dedupe key. */
  private readonly inFlight = new Set<string>();
  private readonly acked = new Set<string>();
  /** One update at a time - the backend 409s concurrent triggers, this is
   *  the daemon-side belt. */
  private updateRunning = false;

  constructor(private readonly deps: UpdateRpcDeps) {
    this.env = deps.env ?? process.env;
    this.registryVersionReader =
      deps.registryVersionReader ?? readLatestRegistryVersion;
    this.forkRootResolver =
      deps.forkRootResolver ?? (() => resolveForkRoot({ env: this.env }));
    const runner = deps.runner ?? runCommand;
    this.installPlugin =
      deps.installPlugin ??
      ((checkoutRoot, version) =>
        installExactPluginVersion({
          checkoutRoot,
          version,
          runner,
          ...(deps.bunPath !== undefined ? { bunPath: deps.bunPath } : {}),
          installedPluginVersionReader:
            deps.installedPluginVersionReader ?? readInstalledPluginVersion,
        }));
    this.installedPluginVersionReader =
      deps.installedPluginVersionReader ?? readInstalledPluginVersion;
    this.latchReader = deps.latchReader ?? (() => readRollbackLatched(this.env));
    this.supervisedResolver =
      deps.supervisedResolver ?? (() => resolveSupervised(this.env));
    this.hardExit = deps.hardExit ?? ((code) => process.exit(code));
    this.restartDelayMs = deps.restartDelayMs ?? RESTART_DELAY_MS;
    this.hardExitDelayMs = deps.hardExitDelayMs ?? RESTART_HARD_EXIT_MS;
  }

  private log(msg: string): void {
    this.deps.log?.(msg);
  }

  async handle(frame: UpdateRpcFrame): Promise<void> {
    if (!frame?.rpcId || frame.op !== "update_now") return;
    if (this.inFlight.has(frame.rpcId)) {
      // A re-emitted frame is the backend's ack-retry lane: if our first
      // ack POST failed, this duplicate is the chance to land it before the
      // 10 s ack timeout flips the rpc to 'unreachable'.
      if (!this.acked.has(frame.rpcId)) await this.tryAck(frame.rpcId);
      return;
    }
    this.inFlight.add(frame.rpcId);
    try {
      await this.tryAck(frame.rpcId);
      if (this.updateRunning) {
        // A DIFFERENT rpc while one update runs (backend restart race):
        // loud descriptive error, never silence.
        await this.postError(frame.rpcId, "update_in_flight");
        return;
      }
      this.updateRunning = true;
      const release = this.deps.acquireUpdate ? this.deps.acquireUpdate() : () => {};
      try {
        if (!release) {
          await this.postError(frame.rpcId, "update_in_flight");
          return;
        }
        await this.runUpdate(frame.rpcId);
      } catch (err) {
        this.log(`update_rpc failed (rpc=${frame.rpcId}): ${err instanceof Error ? err.message : String(err)}`);
        await this.resumeQuietly();
        await this.postError(frame.rpcId, "update_failed");
      } finally {
        release?.();
        this.updateRunning = false;
      }
    } finally {
      this.inFlight.delete(frame.rpcId);
      this.acked.delete(frame.rpcId);
    }
  }

  private async runUpdate(rpcId: string): Promise<void> {
    // Relaunch authority + brakes FIRST, before any mutation (contract
    // section 6): kill switch, rollback latch, fork root.
    if (parseAutoUpdateFlag(this.env.BGOS_AUTO_UPDATE) !== "on") {
      await this.postError(rpcId, "updates_disabled");
      return;
    }
    if (this.safeLatchRead()) {
      await this.postError(rpcId, "rollback_latched");
      return;
    }
    const forkRoot = this.safeForkRoot();
    if (!forkRoot) {
      await this.postError(rpcId, "fork_root_not_found");
      return;
    }

    // Resolve the target from the daemon's OWN pinned source. Same-major
    // only; a registry failure or junk version also reads as no update.
    let latest: string;
    try {
      latest = await this.registryVersionReader();
    } catch (err) {
      this.log(
        `update_rpc registry check failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await this.postError(rpcId, "version_check_failed");
      return;
    }
    if (
      !parseExactStableNpmVersion(latest) ||
      decideVersionUpdate(this.deps.runningVersion, latest) !== "update"
    ) {
      await this.postError(rpcId, "no_update_available");
      return;
    }

    if (!(this.deps.isVersionCompatible ?? forkAcceptsPluginVersion)(forkRoot, latest)) {
      await this.postError(rpcId, "fork_update_required", latest);
      return;
    }

    await this.postProgress(rpcId, {
      stage: "draining",
      targetVersion: latest,
    });
    await this.deps.drain();

    await this.postProgress(rpcId, {
      stage: "installing",
      targetVersion: latest,
    });
    const installed = this.installPlugin(forkRoot, latest);
    if (installed.status !== 0) {
      this.log(
        `update_rpc install failed (rpc=${rpcId}): ${
          (installed.error || installed.stderr || installed.stdout || "install failed").trim()
        }`,
      );
      await this.resumeQuietly();
      await this.postError(rpcId, "install_failed", latest);
      return;
    }

    // Loader-contract belt: the fork imports this package in-process, so
    // the version on disk must share the running major or the fork itself
    // needs an update first.
    const onDisk = this.installedPluginVersionReader(forkRoot);
    const onDiskParsed = onDisk ? parseExactStableNpmVersion(onDisk) : null;
    const runningParsed = parseExactStableNpmVersion(this.deps.runningVersion);
    if (!onDiskParsed) {
      await this.resumeQuietly();
      await this.postError(rpcId, "install_failed", latest);
      return;
    }
    if (!runningParsed || onDiskParsed.major !== runningParsed.major) {
      await this.resumeQuietly();
      await this.postError(rpcId, "contract_major_mismatch", latest);
      return;
    }
    if (onDisk !== latest) {
      await this.resumeQuietly();
      await this.postError(rpcId, "install_version_mismatch", latest);
      return;
    }

    if (this.supervisedResolver() !== "none") {
      // The progress POST must RESOLVE before the exit path arms, so the
      // backend knows a restart (not a crash) is coming.
      await this.postProgress(rpcId, {
        stage: "restarting",
        targetVersion: latest,
      });
      this.log(
        `update_rpc installed ${this.deps.runningVersion} -> ${latest}; requesting supervised restart`,
      );
      this.scheduleSupervisedRestart();
      return;
    }

    // No verified supervisor: NEVER exit. The install sits on disk and
    // pendingRestartVersion rides the heartbeat until the host restarts.
    await this.postProgress(rpcId, {
      stage: "staged",
      targetVersion: latest,
    });
    await this.resumeQuietly();
    this.log(
      `update_rpc staged ${latest} on disk (no supervisor); restart the Gobot host to apply`,
    );
    try {
      this.deps.onStaged?.();
    } catch {
      /* best-effort */
    }
  }

  private scheduleSupervisedRestart(): void {
    const timer = setTimeout(() => {
      void (async () => {
        // Arm before awaiting shutdown: a hung drain must not prevent the
        // verified supervisor from receiving an exit at all.
        const fallback = setTimeout(() => this.hardExit(0), this.hardExitDelayMs);
        (fallback as { unref?: () => void }).unref?.();
        try {
          await this.deps.shutdown();
        } catch (err) {
          this.log(
            `update_rpc graceful shutdown failed; restart request continues: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        try {
          this.deps.restart();
        } catch (err) {
          this.log(
            `update_rpc restart request failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // Belt for a host that ignores SIGTERM: supervision was verified,
        // so a hard exit is always relaunched.
      })();
    }, this.restartDelayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  private safeLatchRead(): boolean {
    try {
      return this.latchReader();
    } catch {
      return true;
    }
  }

  private safeForkRoot(): string | null {
    try {
      return this.forkRootResolver();
    } catch {
      return null;
    }
  }

  private async tryAck(rpcId: string): Promise<void> {
    try {
      await this.deps.api.postUpdateRpcAck(rpcId);
      this.acked.add(rpcId);
    } catch (err) {
      this.log(
        `update_rpc ack failed (rpc=${rpcId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async postError(
    rpcId: string,
    message: string,
    targetVersion?: string,
  ): Promise<void> {
    await this.postProgress(rpcId, {
      stage: "error",
      message,
      ...(targetVersion !== undefined ? { targetVersion } : {}),
    });
  }

  private async postProgress(
    rpcId: string,
    body: UpdateRpcProgressBody,
  ): Promise<void> {
    try {
      await this.deps.api.postUpdateRpcProgress(rpcId, body);
    } catch (err) {
      // Nothing else we can do - a lost terminal progress is closed out by
      // the backend's own timeouts ('unreachable'/'unknown').
      this.log(
        `update_rpc progress post failed (rpc=${rpcId}, stage=${body.stage}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async resumeQuietly(): Promise<void> {
    try {
      await this.deps.resume();
    } catch (err) {
      this.log(
        `update_rpc could not resume intake after a failed update attempt: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
