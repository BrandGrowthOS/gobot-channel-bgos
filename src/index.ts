/**
 * gobot-channel-bgos — public exports.
 *
 * The fork (`BrandGrowthOS/gobot-bgos-fork`) loads this package via
 * `optionalDependencies`. If the package is installed, the fork:
 *   1. `import { BGOSAdapter } from "gobot-channel-bgos"`
 *   2. Builds an instance: `new BGOSAdapter({ pairingToken, baseUrl,
 *      agents: [...], getSystemPrompt: (route) => "..." })`
 *   3. Registers Gobot's dispatch function: `adapter.setDispatch(fn)`
 *   4. Starts: `await adapter.start()`
 *   5. On shutdown: `await adapter.stop()`
 *
 * Public surface kept narrow — the fork only needs adapter lifecycle +
 * outbound primitives + the agent-hints + default-commands constants.
 */
export { BGOSAdapter, type BgosConfig } from "./adapter.js";
export { BgosOutbound, BGOSOutbound } from "./outbound.js";
export { BGOS_AGENT_HINTS, buildSystemPromptWithHints } from "./agent-hints.js";
export {
  DEFAULT_COMMANDS,
  resolveCommandSeedMode,
  shouldSeedDefaults,
  type CommandSeedMode,
} from "./default-commands.js";
export {
  BgosProactiveClient,
  type ProactiveClientInit,
  type ProactiveSendParams,
  type ProactiveSendResult,
} from "./proactive.js";
export { runReseedCli } from "./reseed-cli.js";
export {
  resolveHomeChannel,
  type HomeChannel,
} from "./home-channel.js";
export {
  ingestBgosAttachment,
  publishMediaPath,
  S3_THRESHOLD,
  type BgosInboundAttachment,
  type BgosOutboundFileRef,
  type AttachmentKind,
} from "./attachment-bridge.js";
export { syncCatalog, type CatalogAgent } from "./catalog-sync.js";
export {
  createInboundHandler,
  type DispatchArgs,
  type DispatchFn,
  type InboundHandlerDeps,
  type ReplyHandle,
} from "./inbound-handler.js";
export { loadLastId, saveLastId } from "./last-id-store.js";
export { ApprovalHandler, type ApprovalDecision } from "./approval-handler.js";
export { CommandsSync } from "./commands-sync.js";
export { BgosApi } from "./bgos-api.js";
export { BgosWs } from "./bgos-ws.js";
export { pairBgos, type PairCliOptions, type PairResult } from "./pair-cli.js";
export {
  loadConfigFromEnv,
  loadConfigFromPluginCfg,
} from "./config.js";
export { loadConfig, type LoadedConfig } from "./load-config.js";
export {
  createAdapter,
  type CreatedAdapter,
  type ForkLoaderOpts,
  type ForkDispatchArgs,
} from "./create-adapter.js";
export type {
  AgentCatalogEntry,
  ApprovalMeta,
  AssistantBoundPayload,
  AssistantUnboundPayload,
  CallbackResultPayload,
  ChatMessage,
  CommandManifestEntry,
  CommandsUpdatedPayload,
  FromAgentInput,
  InboundFile,
  InboundMessagePayload,
  IntegrationDirection,
  IntegrationPairing,
  MessageOption,
  OutboundMessagePayload,
  PairExchangeResponse,
  PairingRevokedPayload,
  PluginConfig,
  PairReadyPayload,
  BgosMessageEnvelope,
} from "./types.js";
export { PairingRevokedError } from "./types.js";
