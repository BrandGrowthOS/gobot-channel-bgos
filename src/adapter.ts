/**
 * Main adapter for the Gobot <-> BGOS channel.
 *
 * Lifecycle:
 *   1. Fork instantiates `new BGOSAdapter(config)`, then `setDispatch(fn)`.
 *   2. Fork calls `await adapter.start()`. The adapter:
 *        - wires WS handlers + connects the socket
 *        - starts heartbeat (network POST + local file)
 *        - resolves identity (whoami) with forever exp-backoff retry; the
 *          adapter stays UP even if identity is not yet resolvable
 *        - runs the initial backfill only after the first identity success
 *          (cold-start seed on a fresh install; replay-missed otherwise)
 *        - starts the 5s poll loop + the 60s outbox replay loop
 *   3. Inbound events flow through `inbound-handler.ts`.
 *   4. On token revoke/rotate the adapter enters a fatal latch and watches the
 *      secrets directory to self-recover when a new token is applied.
 *   5. Fork calls `await adapter.stop()` on shutdown.
 *
 * Reference: `hermes-channel-bgos/src/hermes_channel_bgos/bgos_adapter.py`.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { BgosApi } from "./bgos-api.js";
import { BgosWs } from "./bgos-ws.js";
import { BgosOutbound } from "./outbound.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandsSync } from "./commands-sync.js";
import { ToolProgressOrchestrator } from "./tool-progress.js";
import { HeartbeatController } from "./heartbeat.js";
import { getPackageVersion } from "./version.js";
import { syncCatalog, type CatalogAgent } from "./catalog-sync.js";
import {
  DEFAULT_COMMANDS,
  resolveCommandSeedMode,
  shouldSeedDefaults,
  type CommandSeedMode,
} from "./default-commands.js";
import {
  buildReplyHandle,
  createInboundHandler,
  type DispatchFn,
  type ReplyHandle,
} from "./inbound-handler.js";
import { loadConfigFromEnv, loadConfigFromPluginCfg } from "./config.js";
import { pendingUnknownStats } from "./pending-unknown-store.js";
import { BGOS_AGENT_HINTS } from "./agent-hints.js";
import { pickAgentHints } from "./capabilities.js";
import {
  AutoUpdateController,
  decideDrainBeforeUpdate,
} from "./self-update.js";
import {
  loadVoiceConfigFromEnv,
  VoiceRpcHandler,
  type VoiceConfig,
} from "./voice-rpc.js";

import {
  PairingRevokedError,
  type AssistantBoundPayload,
  type AssistantUnboundPayload,
  type CommandsUpdatedPayload,
  type InboundClickPayload,
  type PairingRevokedPayload,
  type PluginConfig,
} from "./types.js";

export interface HostRestartSignalTarget {
  pid: number;
  kill(pid: number, signal: NodeJS.Signals): boolean;
}

export function requestGracefulHostRestart(
  target: HostRestartSignalTarget = process,
): void {
  if (!target.kill(target.pid, "SIGTERM")) {
    throw new Error("host process did not accept SIGTERM");
  }
}

/** Info passed to `onFatal` when the pairing becomes unusable (C2). */
export interface FatalInfo {
  /** `'pairing_revoked'` or `'token_rotated'`. */
  code: string;
  message: string;
  /** `'revoked'` or `'rotated'`. */
  reason: string;
}

/** Info passed to `onButtonClick` for a non-approval inline-button tap (C6). */
export interface ButtonClickInfo {
  assistantId: number;
  chatId: number;
  callbackData: string;
  messageId: number;
}

/** Public configuration the fork passes in. Mirrors `PluginConfig` plus
 *  optional Gobot-specific knobs. */
export interface BgosConfig {
  /** Backend base URL (e.g. https://api.brandgrowthos.ai). */
  baseUrl?: string;
  /** Pairing token from `~/.gobot/secrets/bgos.json`. */
  pairingToken?: string;
  /** Reconnect tuning. Defaults: 1s initial, 30s max. */
  reconnect?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  /** Optional agent catalog to push on connect. */
  agents?: CatalogAgent[];
  /** Optional system-prompt prefix per agent_route. */
  getSystemPrompt?: (agentRoute: string) => string;
  /** Override the default-commands seed strategy. */
  commandSeedMode?: CommandSeedMode;
  /** Optional voice (in-app realtime call) config override. */
  voice?: Partial<VoiceConfig>;
  /**
   * Called ONCE when the pairing becomes unusable (revoked or rotated). The
   * fork alerts the operator (e.g. on Telegram) with re-pair instructions.
   * The adapter stays alive and self-recovers when a new token is applied.
   */
  onFatal?: (info: FatalInfo) => void;
  /**
   * Called for a non-approval inline-button tap (contract C6). Approval taps
   * (`ea:*`) are consumed by the ApprovalHandler and are NOT forwarded here.
   */
  onButtonClick?: (info: ButtonClickInfo) => void | Promise<void>;
}

export class BGOSAdapter {
  readonly api: BgosApi;
  readonly outbound: BgosOutbound;
  readonly approvals: ApprovalHandler;
  readonly commandsSync: CommandsSync;
  readonly toolProgress: ToolProgressOrchestrator;

  private readonly cfg: PluginConfig;
  private readonly ws: BgosWs;
  private readonly heartbeat: HeartbeatController;
  private readonly assistantToRoute = new Map<number, string>();
  private readonly assistantNames = new Map<number, string>();
  private readonly voiceConfig: VoiceConfig;
  private voiceRpc: VoiceRpcHandler | null = null;
  private userId = "";
  private dispatch: DispatchFn | null = null;
  private catalog: CatalogAgent[];
  private getSystemPrompt: (route: string) => string;
  private commandSeedModeOverride: CommandSeedMode | null = null;
  private pairingId: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private spoolTimer: NodeJS.Timeout | null = null;
  private started = false;
  private networkStarted = false;
  private updateDraining = false;
  private activeMessageCount = 0;
  private readonly autoUpdate: AutoUpdateController;

  private readonly onFatal?: (info: FatalInfo) => void;
  private readonly onButtonClick?: (info: ButtonClickInfo) => void | Promise<void>;

  // Identity retry state.
  private identityReady = false;
  private capabilitiesLoaded = false;
  /** Agent-capability hints injected per dispatch. Starts as the bundled
   *  BGOS_AGENT_HINTS fallback; replaced with the served capability canon once
   *  it is fetched at connect (best-effort). */
  private cachedAgentHints: string = BGOS_AGENT_HINTS;
  private identityRetryTimer: NodeJS.Timeout | null = null;
  private pollStarted = false;

  // Unknown-assistant scope refresh (rate-limited + single-flight).
  private lastScopeRefreshAt = 0;
  private scopeRefreshInFlight: Promise<void> | null = null;

  // Fatal latch + re-pair recovery state.
  private currentToken: string;
  private fatalLatched = false;
  private fatalNotified = false;
  private last401LogAt = 0;
  private secretsWatcher: FSWatcher | null = null;
  private secretsStatTimer: NodeJS.Timeout | null = null;
  private secretsDebounce: NodeJS.Timeout | null = null;

  constructor(input: BgosConfig | unknown = undefined) {
    this.cfg =
      input !== undefined
        ? loadConfigFromPluginCfg(input)
        : loadConfigFromEnv();
    this.currentToken = this.cfg.pairingToken;
    this.api = new BgosApi(this.cfg);
    this.ws = new BgosWs(this.cfg, this.api);
    this.outbound = new BgosOutbound(this.api);
    this.approvals = new ApprovalHandler(this.outbound);
    this.commandsSync = new CommandsSync(this.api);
    this.toolProgress = new ToolProgressOrchestrator(this.api);
    this.heartbeat = new HeartbeatController({
      version: getPackageVersion(),
      postHeartbeat: (body) => this.api.postHeartbeat(body),
    });
    this.autoUpdate = new AutoUpdateController({
      runningDaemonVersion: getPackageVersion(),
      drain: () => this.drainForUpdate(),
      resume: () => this.resumeAfterUpdateFailure(),
      shutdown: () => this.stop(),
      restart: () => requestGracefulHostRestart(),
      hasActiveWork: () => this.activeMessageCount > 0,
      ...(process.execPath.endsWith("bun") ? { bunPath: process.execPath } : {}),
    });

    const inputCfg = (input as BgosConfig | undefined) ?? {};
    this.catalog = inputCfg.agents ?? [];
    this.getSystemPrompt = inputCfg.getSystemPrompt ?? (() => "");
    this.commandSeedModeOverride = inputCfg.commandSeedMode ?? null;
    this.onFatal = inputCfg.onFatal;
    this.onButtonClick = inputCfg.onButtonClick;
    this.voiceConfig = {
      ...loadVoiceConfigFromEnv(),
      ...(inputCfg.voice ?? {}),
    };

    // Wire outbound telemetry: typing over WS + heartbeat reporters.
    this.outbound.setTypingEmitter((p) => this.ws.emitTyping(p));
    this.outbound.setOutboundReporter(() => this.heartbeat.recordOutbound());
    this.outbound.setLastErrorReporter((code, message) =>
      this.heartbeat.setLastError({
        code,
        message,
        at: new Date().toISOString(),
      }),
    );
  }

  private getCommandSeedMode(): CommandSeedMode {
    return this.commandSeedModeOverride ?? resolveCommandSeedMode();
  }

  setDispatch(fn: DispatchFn): void {
    this.dispatch = fn;
  }

  setCatalog(agents: CatalogAgent[]): void {
    this.catalog = agents;
  }

  getRouteForAssistant(assistantId: number): string | null {
    return this.assistantToRoute.get(assistantId) ?? null;
  }

  get routeMap(): ReadonlyMap<number, string> {
    return new Map(this.assistantToRoute);
  }

  /**
   * Build a BGOS reply handle for an arbitrary (assistantId, chatId) outside
   * an inbound dispatch (contract C6). The fork uses this to resume a HITL
   * task after an inbound_click, replying through the same surface the inbound
   * dispatch exposes. No a2a routing (plain reply into the chat).
   */
  makeReplyHandle(assistantId: number, chatId: number): ReplyHandle {
    return buildReplyHandle(
      { outbound: this.outbound, toolProgress: this.toolProgress },
      { assistantId, chatId },
    );
  }

  /**
   * Set (or clear) an assistant's status line (contract C4). Public surface the
   * fork's loader feature-detects (`typeof adapter.setStatus === "function"`)
   * and drives to show the "working…" line while an agent turn is in flight.
   * Delegates straight to `BgosApi.setStatus`
   * (PATCH `/integrations/assistants/:id/status`). Pass an empty string or null
   * `statusText` to clear. Fail-open is the CALLER's job: the fork wraps this
   * in try/catch + throttle so a status write never suppresses a reply; this
   * method only delegates.
   */
  async setStatus(
    assistantId: number,
    body: { statusText: string | null; statusEmoji?: string | null },
  ): Promise<void> {
    await this.api.setStatus(assistantId, body);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const updateStart = await this.autoUpdate.start();
    if (updateStart === "exit-requested") return;

    // 1. Wire WS handlers BEFORE connecting.
    const inboundHandler = createInboundHandler({
      outbound: this.outbound,
      getRouteForAssistant: (id) => this.getRouteForAssistant(id),
      getDispatch: () => this.dispatch,
      getSystemPrompt: (route) => this.getSystemPrompt(route),
      getAgentHints: () => this.cachedAgentHints,
      toolProgress: this.toolProgress,
      onInbound: () => this.heartbeat.recordInbound(),
      onUnknownAssistant: () => this.refreshScopeRateLimited(),
    });
    this.ws.on("inbound_message", (msg) => {
      if (this.updateDraining) return;
      this.trackMessageProcessing(() => inboundHandler(msg));
    });
    this.ws.on("inbound_click", (click) => {
      if (this.updateDraining) return;
      this.trackMessageProcessing(() => this.routeInboundClick(click));
    });
    this.ws.on("callback_result", (p) => {
      // n8n success/error lane. `callback_result` carries NO callbackData, so
      // this never matches an approval, approvals resolve via inbound_click.
      this.approvals.handleCallbackResult(p);
    });
    this.ws.on("assistant_bound", (p: AssistantBoundPayload) => {
      this.assistantToRoute.set(p.assistantId, p.agentRoute);
      void this.seedDefaultCommands(p.assistantId, "bind");
    });
    this.ws.on("assistant_unbound", (p: AssistantUnboundPayload) => {
      this.assistantToRoute.delete(p.assistantId);
    });
    this.ws.on("commands_updated", (_p: CommandsUpdatedPayload) => {
      // No-op, user changed commands via the BGOS UI.
    });
    this.ws.on("pairing_revoked", (p: PairingRevokedPayload) => {
      const reason = p.reason === "rotated" ? "rotated" : "revoked";
      const message =
        reason === "rotated" ? "Pairing token rotated" : "Pairing revoked";
      this.enterFatalLatch(reason, message);
    });
    this.ws.on("error", (err) => this.handleWsError(err));
    this.ws.on("connect", () => {
      this.heartbeat.setWsConnected(true, this.ws.connectedSince);
    });
    this.ws.on("disconnect", () => {
      this.heartbeat.setWsConnected(false, null);
    });
    this.ws.on("reconnect", () => {
      if (this.updateDraining) return;
      this.trackMessageProcessing(() => this.onReconnect());
    });
    this.ws.on("backfill_ok", () => {
      // Clear a stale backfill error once a clean backfill lands.
      const code = this.heartbeat.getLastErrorCode();
      if (code === "backfill_failed" || code === "backfill_storm_skipped") {
        this.heartbeat.setLastError(null);
      }
      // Reconcile the pending-unknown visibility signal on every clean backfill
      // (the poll drives this every ~5s).
      this.reconcilePendingUnknownError();
    });
    this.ws.on("backfill_error", (err) => {
      this.heartbeat.setLastError({
        code: "backfill_failed",
        message: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
    });
    this.ws.on("backfill_storm", (count) => {
      this.heartbeat.setLastError({
        code: "backfill_storm_skipped",
        message: `skipped ${count} messages`,
        at: new Date().toISOString(),
      });
    });

    // Native voice control plane (mint / consult / dispatch).
    this.voiceRpc = new VoiceRpcHandler({
      api: this.api,
      config: this.voiceConfig,
      getDispatch: () => this.dispatch,
      getRouteForAssistant: (id) => this.getRouteForAssistant(id),
      getAssistantName: (id) => this.assistantNames.get(id) ?? null,
      getUserId: () => this.userId,
      getSystemPrompt: (route) => this.getSystemPrompt(route),
      // eslint-disable-next-line no-console
      log: (msg) => console.log("[gobot-channel-bgos] " + msg),
    });
    this.ws.on("voice_rpc", (frame) => {
      if (this.updateDraining) return;
      this.trackMessageProcessing(
        () => this.voiceRpc?.handle(frame) ?? Promise.resolve(),
      );
    });

    // 2. Connect WS + start heartbeat.
    await this.ws.connect();
    this.heartbeat.start();
    this.networkStarted = true;

    // Fetch the served capability canon once at connect and cache it for the
    // per-dispatch injection (best-effort; falls back to the bundled copy).
    void this.loadServedCapabilities();

    // 3. Resolve identity. On success run the initial backfill + start the
    // poll loop; on failure keep the adapter up and retry forever.
    const ok = await this.refreshIdentity();
    if (ok) {
      this.identityReady = true;
      await this.ws.triggerBackfill({ initial: true });
      this.startPollLoop();
    } else if (!this.fatalLatched) {
      this.scheduleIdentityRetry(1000);
    }

    // 4. Outbox replay loop (every 60s while non-empty).
    this.spoolTimer = setInterval(() => {
      if (this.updateDraining) return;
      void this.replaySpoolTracked();
    }, 60_000);
    this.spoolTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.autoUpdate.stop();
    this.networkStarted = false;
    this.updateDraining = false;
    this.stopPollLoop();
    if (this.spoolTimer !== null) {
      clearInterval(this.spoolTimer);
      this.spoolTimer = null;
    }
    if (this.identityRetryTimer !== null) {
      clearTimeout(this.identityRetryTimer);
      this.identityRetryTimer = null;
    }
    this.stopSecretsWatch();
    this.heartbeat.stop();
    this.approvals.shutdown();
    this.ws.disconnect();
    this.toolProgress.dispose();
    try {
      await this.commandsSync.flushAll();
    } catch {
      /* swallow on shutdown, best effort */
    }
  }

  private trackMessageProcessing(task: () => Promise<unknown>): void {
    void this.withActiveMessageProcessing(task);
  }

  private async withActiveMessageProcessing<T>(
    task: () => Promise<T>,
  ): Promise<T> {
    this.activeMessageCount += 1;
    try {
      return await task();
    } finally {
      this.activeMessageCount = Math.max(0, this.activeMessageCount - 1);
    }
  }

  private replaySpoolTracked(): Promise<void> {
    return this.withActiveMessageProcessing(() => this.outbound.replaySpool());
  }

  private async drainForUpdate(): Promise<void> {
    let decision = decideDrainBeforeUpdate({
      updateReady: true,
      draining: this.updateDraining,
      activeMessages: this.activeMessageCount,
    });
    if (decision === "begin") {
      this.updateDraining = true;
      if (this.networkStarted) {
        this.stopPollLoop();
        this.ws.disconnect();
        this.heartbeat.setWsConnected(false, null);
      }
    }
    decision = decideDrainBeforeUpdate({
      updateReady: true,
      draining: this.updateDraining,
      activeMessages: this.activeMessageCount,
    });
    while (decision === "wait") {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      decision = decideDrainBeforeUpdate({
        updateReady: true,
        draining: this.updateDraining,
        activeMessages: this.activeMessageCount,
      });
    }
  }

  private async resumeAfterUpdateFailure(): Promise<void> {
    if (!this.updateDraining) return;
    this.updateDraining = false;
    if (!this.started || !this.networkStarted) return;
    await this.ws.connect();
    const ok = await this.refreshIdentity();
    if (ok) {
      this.identityReady = true;
      await this.ws.triggerBackfill();
      this.startPollLoop();
    } else if (!this.fatalLatched) {
      this.scheduleIdentityRetry(1000);
    }
  }

  // -------------------------------------------------------------------
  // Capability bootstrap (fetch-on-connect)
  // -------------------------------------------------------------------

  /**
   * Fetch the served capability canon once and cache it for the per-dispatch
   * system-prompt injection, replacing the bundled fallback. Never throws: any
   * failure (network, 401, 404 on an old backend, malformed body) leaves the
   * bundled BGOS_AGENT_HINTS in place so the daemon is never blocked on this.
   * Runs once per process (start() is guarded), i.e. once at connect.
   */
  private async loadServedCapabilities(): Promise<void> {
    if (this.capabilitiesLoaded) return;
    this.capabilitiesLoaded = true;
    try {
      const served = await this.api.getCapabilities("gobot");
      const picked = pickAgentHints(served);
      if (picked.source === "backend") {
        this.cachedAgentHints = picked.hints;
        // eslint-disable-next-line no-console
        console.log(
          `[gobot-channel-bgos] capability canon applied version=${served.version} chars=${served.text.length} source=backend`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          "[gobot-channel-bgos] served capability canon malformed; keeping bundled fallback",
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] capability canon fetch failed; keeping bundled fallback: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // -------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------

  /**
   * Resolve identity: whoami -> pairingId/userId/route map/names, push the
   * catalog, seed default commands for empty manifests. Idempotent. Returns
   * true on success. A PairingRevokedError enters the fatal latch instead of
   * retrying. Any other failure returns false (the caller retries).
   */
  private async refreshIdentity(): Promise<boolean> {
    try {
      const me = await this.api.whoami();
      this.pairingId = me.pairing_id;
      this.userId = me.user_id ?? "";
      this.heartbeat.setPairingId(this.pairingId);
      const seedMode = this.getCommandSeedMode();
      const emptyManifestAssistantIds: number[] = [];
      for (const a of me.assistants ?? []) {
        if (a.agent_route) {
          this.assistantToRoute.set(a.assistant_id, a.agent_route);
        }
        if (a.name) {
          this.assistantNames.set(a.assistant_id, a.name);
        }
        if (shouldSeedDefaults(a.command_count, seedMode)) {
          emptyManifestAssistantIds.push(a.assistant_id);
        }
      }
      if (this.pairingId !== null && this.catalog.length > 0) {
        await syncCatalog(this.api, this.pairingId, this.catalog);
      }
      for (const id of emptyManifestAssistantIds) {
        await this.seedDefaultCommands(id, "startup");
      }
      return true;
    } catch (err) {
      if (err instanceof PairingRevokedError) {
        this.enterFatalLatch("revoked", err.message);
        return false;
      }
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] refreshIdentity failed (will retry):",
        err instanceof Error ? err.message : String(err),
      );
      return false;
    }
  }

  /** Background identity retry: exp backoff 1s..60s + jitter, forever. */
  private scheduleIdentityRetry(delayMs: number): void {
    if (this.fatalLatched || !this.started) return;
    const jitter = Math.floor(Math.random() * 250);
    this.identityRetryTimer = setTimeout(() => {
      void (async () => {
        if (this.fatalLatched || !this.started) return;
        const ok = await this.refreshIdentity();
        if (ok) {
          this.identityReady = true;
          // First success triggers the initial backfill; poll starts after.
          await this.ws.triggerBackfill({ initial: true });
          this.startPollLoop();
          return;
        }
        if (this.fatalLatched) return;
        this.scheduleIdentityRetry(Math.min(delayMs * 2, 60_000));
      })();
    }, delayMs + jitter);
    this.identityRetryTimer.unref?.();
  }

  /** Rate-limited (>=10s) single-flight scope refresh for unknown-assistant
   *  inbounds. */
  private refreshScopeRateLimited(): Promise<void> {
    if (this.scopeRefreshInFlight) return this.scopeRefreshInFlight;
    const now = Date.now();
    if (now - this.lastScopeRefreshAt < 10_000) return Promise.resolve();
    this.lastScopeRefreshAt = now;
    this.scopeRefreshInFlight = this.refreshIdentity()
      .then(() => {})
      .finally(() => {
        this.scopeRefreshInFlight = null;
      });
    return this.scopeRefreshInFlight;
  }

  /**
   * Surface a VISIBLE heartbeat lastError when the pending-unknown set is stuck
   * (inbound messages waiting on an assistant that never binds), so the bounded
   * clamp never fails silently. Clears once the set drains. Never masks a more
   * urgent error already reported.
   */
  private reconcilePendingUnknownError(): void {
    const STUCK_MS = 5 * 60_000;
    const stats = pendingUnknownStats();
    const code = this.heartbeat.getLastErrorCode();
    if (stats.count === 0) {
      if (code === "pending_unknown_stuck") this.heartbeat.setLastError(null);
      return;
    }
    if (stats.oldestAt !== null && Date.now() - stats.oldestAt >= STUCK_MS) {
      if (code === null || code === "pending_unknown_stuck") {
        this.heartbeat.setLastError({
          code: "pending_unknown_stuck",
          message: `${stats.count} inbound message(s) await an unbound assistant`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------

  private startPollLoop(): void {
    if (this.pollStarted || this.fatalLatched) return;
    const intervalRaw = process.env.GOBOT_POLL_INTERVAL;
    const interval =
      intervalRaw !== undefined && intervalRaw !== ""
        ? Number(intervalRaw)
        : 5;
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.pollStarted = true;
    this.pollTimer = setInterval(() => {
      void this.ws.triggerBackfill();
    }, interval * 1000);
    this.pollTimer.unref?.();
  }

  private stopPollLoop(): void {
    this.pollStarted = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async onReconnect(): Promise<void> {
    if (this.fatalLatched || this.updateDraining) return;
    await this.refreshIdentity();
    await this.ws.triggerBackfill();
    if (this.updateDraining) return;
    await this.replaySpoolTracked();
  }

  // -------------------------------------------------------------------
  // inbound_click routing (HITL, contract C6)
  // -------------------------------------------------------------------

  private async routeInboundClick(click: InboundClickPayload): Promise<void> {
    // Approval precedence: an approval-consumed click is NOT also forwarded.
    const consumed = this.approvals.handleCallbackResult({
      messageId: click.messageId,
      optionId: click.optionId,
      success: true,
      assistantId: click.assistantId,
      callbackData: click.callbackData,
    });
    if (consumed) return;
    try {
      await this.onButtonClick?.({
        assistantId: click.assistantId,
        chatId: click.chatId,
        callbackData: click.callbackData,
        messageId: click.messageId,
      });
    } catch {
      /* best-effort */
    }
  }

  // -------------------------------------------------------------------
  // Fatal latch + re-pair recovery (contract C2)
  // -------------------------------------------------------------------

  private handleWsError(err: Error): void {
    if (err instanceof PairingRevokedError) {
      const now = Date.now();
      if (now - this.last401LogAt >= 60_000) {
        this.last401LogAt = now;
        // eslint-disable-next-line no-console
        console.error(
          "[gobot-channel-bgos] pairing rejected (401):",
          err.message,
        );
      }
      // A bare 401 cannot distinguish revoke from rotate; treat as revoked
      // (the WS pairing_revoked event carries the precise reason when present).
      this.enterFatalLatch("revoked", err.message);
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(
      "[gobot-channel-bgos] WS error:",
      err instanceof Error ? err.message : String(err),
    );
  }

  private enterFatalLatch(
    reason: "revoked" | "rotated",
    message: string,
  ): void {
    if (this.fatalLatched) {
      // Already latched, refresh instructions only if it escalates to a
      // rotated reason we didn't know before. Otherwise no-op.
      return;
    }
    this.fatalLatched = true;
    const code = reason === "rotated" ? "token_rotated" : "pairing_revoked";
    // Stop poll + network heartbeat; keep the LOCAL heartbeat file writing.
    this.stopPollLoop();
    if (this.identityRetryTimer !== null) {
      clearTimeout(this.identityRetryTimer);
      this.identityRetryTimer = null;
    }
    this.heartbeat.setNetEnabled(false);
    this.heartbeat.setLastError({
      code,
      message,
      at: new Date().toISOString(),
    });
    this.ws.disconnect();
    this.heartbeat.setWsConnected(false, null);
    // Start watching the secrets directory for a new token (recovery).
    this.startSecretsWatch();
    if (!this.fatalNotified) {
      this.fatalNotified = true;
      try {
        this.onFatal?.({ code, message, reason });
      } catch {
        /* best-effort */
      }
    }
  }

  private resolveSecretsDir(): string {
    const fromEnv = process.env.GOBOT_HOME?.trim();
    let root: string;
    if (fromEnv) {
      root = fromEnv.startsWith("~")
        ? join(homedir(), fromEnv.slice(1))
        : fromEnv;
    } else {
      root = join(homedir(), ".gobot");
    }
    return join(root, "secrets");
  }

  private readSecretsFile(): { baseUrl?: string; pairingToken?: string } | null {
    try {
      const path = join(this.resolveSecretsDir(), "bgos.json");
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as {
        baseUrl?: string;
        pairingToken?: string;
      };
      return parsed;
    } catch {
      return null;
    }
  }

  private startSecretsWatch(): void {
    if (this.secretsWatcher !== null || this.secretsStatTimer !== null) return;
    const dir = this.resolveSecretsDir();
    // fs.watch on the DIRECTORY (survives atomic rename of bgos.json). Some
    // platforms drop the watcher after a rename, so re-arm on each event.
    if (existsSync(dir)) {
      try {
        this.secretsWatcher = watch(dir, () => {
          if (this.secretsDebounce !== null) return;
          this.secretsDebounce = setTimeout(() => {
            this.secretsDebounce = null;
            this.rearmSecretsWatch();
            void this.checkSecretsForChange();
          }, 300);
          this.secretsDebounce.unref?.();
        });
      } catch {
        /* fall back to stat-poll below */
      }
    }
    // 60s stat-poll fallback (also covers the platforms where fs.watch is
    // unreliable). Re-reads bgos.json and diffs the token.
    this.secretsStatTimer = setInterval(() => {
      void this.checkSecretsForChange();
    }, 60_000);
    this.secretsStatTimer.unref?.();
  }

  private rearmSecretsWatch(): void {
    if (this.secretsWatcher === null) return;
    try {
      this.secretsWatcher.close();
    } catch {
      /* ignore */
    }
    this.secretsWatcher = null;
    const dir = this.resolveSecretsDir();
    if (!existsSync(dir)) return;
    try {
      this.secretsWatcher = watch(dir, () => {
        if (this.secretsDebounce !== null) return;
        this.secretsDebounce = setTimeout(() => {
          this.secretsDebounce = null;
          this.rearmSecretsWatch();
          void this.checkSecretsForChange();
        }, 300);
        this.secretsDebounce.unref?.();
      });
    } catch {
      /* stat-poll still covers us */
    }
  }

  private stopSecretsWatch(): void {
    if (this.secretsWatcher !== null) {
      try {
        this.secretsWatcher.close();
      } catch {
        /* ignore */
      }
      this.secretsWatcher = null;
    }
    if (this.secretsStatTimer !== null) {
      clearInterval(this.secretsStatTimer);
      this.secretsStatTimer = null;
    }
    if (this.secretsDebounce !== null) {
      clearTimeout(this.secretsDebounce);
      this.secretsDebounce = null;
    }
  }

  private async checkSecretsForChange(): Promise<void> {
    if (!this.fatalLatched) return;
    const secrets = this.readSecretsFile();
    // Parse failures are a no-op (keep current creds).
    if (!secrets || !secrets.pairingToken) return;
    if (secrets.pairingToken.length < 20) return;
    if (secrets.pairingToken === this.currentToken) return;
    await this.recover(secrets.pairingToken, secrets.baseUrl);
  }

  private async recover(newToken: string, newBaseUrl?: string): Promise<void> {
    // eslint-disable-next-line no-console
    console.error("[gobot-channel-bgos] re-pair detected, applying new token");
    this.currentToken = newToken;
    this.api.updateToken(newToken, newBaseUrl);
    this.ws.updateToken(newToken, newBaseUrl);
    this.fatalLatched = false;
    this.fatalNotified = false;
    this.heartbeat.setNetEnabled(true);
    this.heartbeat.setLastError(null);
    this.stopSecretsWatch();
    this.ws.disconnect();
    try {
      await this.ws.connect();
      // Full refreshIdentity is mandatory (pairingId/userId may have changed).
      const ok = await this.refreshIdentity();
      if (ok) {
        this.identityReady = true;
        await this.ws.triggerBackfill();
      }
      this.startPollLoop();
      if (!this.updateDraining) await this.replaySpoolTracked();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] recovery reconnect failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // -------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------

  async reseedAllCommands(
    assistantIds?: ReadonlyArray<number>,
  ): Promise<Array<{ assistantId: number; ok: boolean; error?: string }>> {
    const ids: number[] = assistantIds ? [...assistantIds] : [];
    if (ids.length === 0) {
      try {
        const me = await this.api.whoami();
        for (const a of me.assistants ?? []) {
          ids.push(a.assistant_id);
        }
      } catch (err) {
        return [
          {
            assistantId: -1,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
        ];
      }
    }
    const results: Array<{
      assistantId: number;
      ok: boolean;
      error?: string;
    }> = [];
    for (const id of ids) {
      try {
        await this.api.putCommands(id, [...DEFAULT_COMMANDS]);
        results.push({ assistantId: id, ok: true });
      } catch (err) {
        results.push({
          assistantId: id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  private async seedDefaultCommands(
    assistantId: number,
    origin: "bind" | "startup",
  ): Promise<void> {
    try {
      await this.api.putCommands(assistantId, [...DEFAULT_COMMANDS]);
      // eslint-disable-next-line no-console
      console.log("[gobot-channel-bgos] seeded default commands", {
        assistantId,
        origin,
        count: DEFAULT_COMMANDS.length,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] default command seed failed (non-fatal):",
        {
          assistantId,
          origin,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }
}
