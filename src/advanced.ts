/**
 * @vibearound/plugin-channel-sdk — Advanced / low-level API
 *
 * For plugins that need custom ACP lifecycle control instead of
 * the standard `runChannelPlugin()` flow.
 *
 * Normal plugins should use the main entry point instead:
 * ```ts
 * import { runChannelPlugin, BlockRenderer } from "@vibearound/plugin-channel-sdk";
 * ```
 */

// Low-level ACP connection
export { connectToHost, stripExtPrefix, redirectConsoleToStderr } from "./connection.js";
export type { PluginInfo, ConnectResult, AgentInfo } from "./connection.js";

// Inbound prompt routing
export {
  isChannelPromptAllowed,
  sendChannelPrompt,
} from "./channel-prompt.js";
export type { SendChannelPromptInput } from "./channel-prompt.js";
export {
  channelRouteKey,
  channelTargetFromInboundContext,
  channelTargetKey,
} from "./types.js";

// All types (including internal ones)
export type {
  Agent,
  Client,
  ContentBlock,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  AddressedBy,
  BlockKind,
  ChannelInboundContext,
  ChannelRoute,
  ChannelTarget,
  ConversationScope,
  OutboundFile,
  VerboseConfig,
  BlockRendererOptions,
  PluginCapabilities,
  PluginManifest,
  PluginInitMeta,
} from "./types.js";

// Re-export high-level API too (so advanced users don't need two imports)
export { runChannelPlugin } from "./plugin.js";
export { BlockRenderer } from "./renderer.js";
export { extractErrorMessage } from "./errors.js";
export type {
  ChannelBot,
  ChannelPluginLogger,
  CreateBotContext,
  RunChannelPluginSpec,
  VerboseOptions,
} from "./plugin.js";
