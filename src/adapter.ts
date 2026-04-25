/**
 * Main adapter for the Gobot ↔ BGOS channel.
 *
 * Lifecycle:
 *   1. Fork instantiates `new BGOSAdapter(config)`. Optionally calls
 *      `setDispatch(fn)` immediately afterwards if dispatch is ready.
 *   2. Fork calls `await adapter.start()`. Adapter:
 *        - GET /integrations/me to populate the assistant→agent_route map
 *        - opens the Socket.IO connection
 *        - pushes the agent catalog (see `setCatalog()` for source)
 *        - seeds default slash-commands for empty manifests
 *        - replays missed messages via REST backfill from the persisted
 *          cursor (CRITICAL — see last-id-store)
 *        - starts a poll loop fallback for the server-side WS push gap
 *          (mirrors the Hermes adapter; toggle via GOBOT_POLL_INTERVAL)
 *   3. Inbound events flow through `inbound-handler.ts` which calls the
 *      registered dispatch function.
 *   4. Fork calls `await adapter.stop()` on shutdown.
 *
 * Reference: `hermes-channel-bgos/src/hermes_channel_bgos/bgos_adapter.py`
 * — same shape, ported to TypeScript with Node-idiomatic event handling.
 */
import { BgosApi } from "./bgos-api.js";
import { BgosWs } from "./bgos-ws.js";
import { BgosOutbound } from "./outbound.js";
import { ApprovalHandler } from "./approval-handler.js";
import { CommandsSync } from "./commands-sync.js";
import { syncCatalog, type CatalogAgent } from "./catalog-sync.js";
import {
  DEFAULT_COMMANDS,
  shouldSeedDefaults,
} from "./default-commands.js";
import {
  createInboundHandler,
  type DispatchFn,
} from "./inbound-handler.js";
import { loadLastId } from "./last-id-store.js";
import {
  loadConfigFromEnv,
  loadConfigFromPluginCfg,
} from "./config.js";
import type {
  AssistantBoundPayload,
  AssistantUnboundPayload,
  CommandsUpdatedPayload,
  PluginConfig,
} from "./types.js";

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
  /** Optional agent catalog to push on connect. If omitted, the fork
   *  can call `setCatalog([...])` later or the catalog stays whatever
   *  was registered at pair time. */
  agents?: CatalogAgent[];
  /** Optional system-prompt prefix per agent_route. Adapter appends
   *  `BGOS_AGENT_HINTS` to whatever this returns at dispatch time. */
  getSystemPrompt?: (agentRoute: string) => string;
}

export class BGOSAdapter {
  /** REST client — public so the fork can use it for ad-hoc operations
   *  (e.g. renaming chats, fetching history). */
  readonly api: BgosApi;
  /** Outbound modalities — public so proactive (no-origin) cron paths in
   *  the fork can push messages directly without an inbound trigger. */
  readonly outbound: BgosOutbound;
  /** Approval bridge — public so the fork's task-queue can register +
   *  resolve approvals without re-routing through `_handle_callback`. */
  readonly approvals: ApprovalHandler;
  /** Slash-command manifest sync — public so the fork can call
   *  `commandsSync.schedule(assistantId, commands)` whenever Gobot's
   *  user-defined commands change. */
  readonly commandsSync: CommandsSync;

  private readonly cfg: PluginConfig;
  private readonly ws: BgosWs;
  private readonly assistantToRoute = new Map<number, string>();
  private dispatch: DispatchFn | null = null;
  private catalog: CatalogAgent[];
  private getSystemPrompt: (route: string) => string;
  private pairingId: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(input: BgosConfig | unknown = undefined) {
    this.cfg =
      input !== undefined
        ? loadConfigFromPluginCfg(input)
        : loadConfigFromEnv();
    this.api = new BgosApi(this.cfg);
    this.ws = new BgosWs(this.cfg, this.api);
    this.outbound = new BgosOutbound(this.api);
    this.approvals = new ApprovalHandler(this.outbound);
    this.commandsSync = new CommandsSync(this.api);

    const inputCfg = (input as BgosConfig | undefined) ?? {};
    this.catalog = inputCfg.agents ?? [];
    this.getSystemPrompt = inputCfg.getSystemPrompt ?? (() => "");
  }

  /** The fork calls this at boot to install Gobot's dispatch function.
   *  Safe to call multiple times — last call wins. */
  setDispatch(fn: DispatchFn): void {
    this.dispatch = fn;
  }

  /** Replace the agent catalog (the next `start()` or call to
   *  `pushCatalog()` will use it). */
  setCatalog(agents: CatalogAgent[]): void {
    this.catalog = agents;
  }

  /** Look up the bound agent_route for an assistant id. Returns null
   *  for unbound or unknown assistants. Also exposed publicly so the
   *  fork's reply-side code can correlate. */
  getRouteForAssistant(assistantId: number): string | null {
    return this.assistantToRoute.get(assistantId) ?? null;
  }

  /** Snapshot of the assistant→agent_route map. Defensive copy. */
  get routeMap(): ReadonlyMap<number, string> {
    return new Map(this.assistantToRoute);
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // 1. whoami — populate route map + capture pairing id
    const emptyManifestAssistantIds: number[] = [];
    try {
      const me = await this.api.whoami();
      this.pairingId = me.pairing_id;
      for (const a of me.assistants ?? []) {
        if (a.agent_route) {
          this.assistantToRoute.set(a.assistant_id, a.agent_route);
        }
        if (shouldSeedDefaults(a.command_count)) {
          emptyManifestAssistantIds.push(a.assistant_id);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] whoami failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }

    // 2. Wire WS event handlers BEFORE connecting so we don't miss
    // anything the server emits in the window between connect + handler
    // registration.
    const inboundHandler = createInboundHandler({
      outbound: this.outbound,
      getRouteForAssistant: (id) => this.getRouteForAssistant(id),
      getDispatch: () => this.dispatch,
      getSystemPrompt: (route) => this.getSystemPrompt(route),
    });
    this.ws.on("inbound_message", (msg) => {
      void inboundHandler(msg);
    });
    this.ws.on("callback_result", (p) => {
      // Approval clicks (`__approval__:*`) are absorbed by the approvals
      // bridge; non-approval clicks fall through (the agent will see the
      // resulting `inbound_message` if the backend synthesizes one).
      this.approvals.handleCallbackResult(p);
    });
    this.ws.on("assistant_bound", (p: AssistantBoundPayload) => {
      this.assistantToRoute.set(p.assistantId, p.agentRoute);
      // Newly-bound assistants always start with zero commands, so we
      // can safely seed the defaults.
      void this.seedDefaultCommands(p.assistantId, "bind");
    });
    this.ws.on(
      "assistant_unbound",
      (p: AssistantUnboundPayload) => {
        this.assistantToRoute.delete(p.assistantId);
      },
    );
    this.ws.on("commands_updated", (_p: CommandsUpdatedPayload) => {
      // No-op — the user changed commands via the BGOS UI; nothing for
      // the adapter to do. Hook is reserved so the fork can subscribe
      // later if it needs to re-render a local picker.
    });
    this.ws.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[gobot-channel-bgos] WS error:",
        err instanceof Error ? err.message : String(err),
      );
    });

    // 3. Seed last-seen cursor + connect WS
    this.ws.setLastSeen(loadLastId());
    await this.ws.connect();

    // 4. Push the agent catalog if we have one + a pairing id
    if (this.pairingId !== null && this.catalog.length > 0) {
      await syncCatalog(this.api, this.pairingId, this.catalog);
    }

    // 5. Seed defaults for any assistant whose manifest is empty
    for (const id of emptyManifestAssistantIds) {
      await this.seedDefaultCommands(id, "startup");
    }

    // 6. Run the initial backfill — this is the load-bearing step that
    // replays messages that arrived while the daemon was down. Cursor
    // came from disk via setLastSeen above.
    await this.ws.triggerBackfill();

    // 7. Start poll-loop fallback. Server currently doesn't deliver
    // `inbound_message` to integration sockets (Hermes-shipped workaround;
    // see `hermes_integration_shipped.md`). Until that's fixed, we poll
    // REST every GOBOT_POLL_INTERVAL seconds.
    const intervalRaw = process.env.GOBOT_POLL_INTERVAL;
    const interval =
      intervalRaw !== undefined && intervalRaw !== ""
        ? Number(intervalRaw)
        : 5;
    if (Number.isFinite(interval) && interval > 0) {
      this.pollTimer = setInterval(() => {
        void this.ws.triggerBackfill();
      }, interval * 1000);
      // Don't keep Node alive just for this timer.
      this.pollTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.approvals.shutdown();
    this.ws.disconnect();
    try {
      await this.commandsSync.flushAll();
    } catch {
      /* swallow on shutdown — best effort */
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private async seedDefaultCommands(
    assistantId: number,
    origin: "bind" | "startup",
  ): Promise<void> {
    try {
      await this.api.putCommands(assistantId, [...DEFAULT_COMMANDS]);
      // eslint-disable-next-line no-console
      console.log(
        "[gobot-channel-bgos] seeded default commands",
        { assistantId, origin, count: DEFAULT_COMMANDS.length },
      );
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
