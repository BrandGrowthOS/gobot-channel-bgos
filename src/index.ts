/**
 * gobot-channel-bgos public exports.
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
 * Public surface kept narrow because the fork only needs adapter lifecycle +
 * outbound primitives + the agent-hints + default-commands constants.
 */
export {
  BGOSAdapter,
  requestGracefulHostRestart,
  type BgosConfig,
  type ButtonClickInfo,
  type FatalInfo,
  type HostRestartSignalTarget,
} from "./adapter.js";
export { getPackageVersion } from "./version.js";
export {
  AutoUpdateController,
  autoUpdateStatePath,
  checkGitUpdate,
  compareVersions,
  decideDrainBeforeUpdate,
  decideVersionUpdate,
  formatGitUpdateDecision,
  parseAutoUpdateFlag,
  readInstalledPluginVersion,
  readLatestRegistryVersion,
  readAutoUpdateState,
  transitionRollbackState,
  updateJitterMs,
  writeAutoUpdateState,
  ACTIVE_WORK_RETRY_MS,
  COMMAND_TIMEOUT_MS,
  HEALTHY_BOOT_MS,
  MAX_UPDATE_JITTER_MS,
  UPDATE_INTERVAL_MS,
  PLUGIN_PACKAGE_NAME,
  PLUGIN_REGISTRY_URL,
  REGISTRY_TIMEOUT_MS,
  WRAPPED_BOOT_COMMIT_ENV,
  type AutoUpdateControllerDeps,
  type AutoUpdateFlag,
  type AutoUpdateStartResult,
  type AutoUpdateState,
  type CommandResult,
  type CommandRunner,
  type DrainDecision,
  type GitCheckDecision,
  type GitUpdateCheck,
  type GitUpdateOptions,
  type RegistryVersionReader,
  MalformedAutoUpdateStateError,
  type PendingUpdateState,
  type RollbackAction,
  type RollbackEvent,
  type VersionDecision,
} from "./self-update.js";
export { resolveGobotStateHome } from "./state-home.js";
export {
  HeartbeatController,
  heartbeatStatePath,
  type HeartbeatDto,
  type HeartbeatFileState,
  type HeartbeatLastError,
} from "./heartbeat.js";
export { ProcessedIdsCache } from "./processed-ids.js";
export { BgosOutbound, BGOSOutbound } from "./outbound.js";
export { BGOS_AGENT_HINTS, buildSystemPromptWithHints } from "./agent-hints.js";
export {
  BUNDLED_AGENT_HINTS,
  appendAgentHints,
  hasCanonMarkers,
  pickAgentHints,
} from "./capabilities.js";
export type {
  ServedCapabilities,
  PickedAgentHints,
} from "./capabilities.js";
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
export {
  resolveAllowedMediaPath,
  MediaPathError,
} from "./media-guard.js";
export {
  sanitizeFromAgent,
  inlineAgentNameAllowed,
} from "./agent-identity.js";
export { syncCatalog, type CatalogAgent } from "./catalog-sync.js";
export {
  buildReplyHandle,
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
export {
  dispatchMissionOps,
  MISSION_MARKER_CLOSE,
  MISSION_MARKER_OPEN,
  parseMissionMarkers,
  type AbandonMissionOp,
  type CompleteMissionOp,
  type CreateMissionOp,
  type MissionApi,
  type MissionDispatchState,
  type MissionMarkerOp,
  type MissionMarkerParseResult,
  type MissionOp,
  type ParsedMissionMarkers,
  type ProgressMissionOp,
  type TickMissionOp,
} from "./mission-markers.js";
export { BgosWs } from "./bgos-ws.js";
export {
  pairBgos,
  pairBgosWithToken,
  type PairCliOptions,
  type PairResult,
  type PairWithTokenOptions,
} from "./pair-cli.js";
export {
  buildConsultToolDefinition,
  buildConsultTurnText,
  buildDispatchTurnText,
  buildMintInstructions,
  CONSULT_TOOL_NAME,
  loadVoiceConfigFromEnv,
  makeCaptureReplyHandle,
  normalizeVoiceRpc,
  VoiceRpcHandler,
  type VoiceConfig,
  type VoiceRpcApi,
  type VoiceRpcDeps,
  type VoiceRpcFrame,
  type VoiceRpcOp,
  type VoiceRpcResultBody,
  type VoiceRpcTiming,
} from "./voice-rpc.js";
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
  InboundClickPayload,
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
