/**
 * @vibearound/plugin-channel-sdk
 *
 * SDK for building VibeAround channel plugins.
 *
 * ## Quick start
 *
 * ```ts
 * import {
 *   runChannelPlugin,
 *   BlockRenderer,
 *   type ChannelBot,
 *   type BlockKind,
 * } from "@vibearound/plugin-channel-sdk";
 *
 * class MyRenderer extends BlockRenderer<string> {
 *   protected async sendText(target: ChannelTarget, text: string) { ... }
 *   protected async sendBlock(target: ChannelTarget, kind: BlockKind, content: string) { ... }
 * }
 *
 * runChannelPlugin({
 *   name: "vibearound-mybot",
 *   version: "0.1.0",
 *   requiredConfig: ["bot_token"],
 *   createBot: ({ config, agent, log, cacheDir }) => new MyBot(...),
 *   createRenderer: (bot, log, verbose) => new MyRenderer(bot, log, verbose),
 * });
 * ```
 *
 * ## Advanced / low-level usage
 *
 * For plugins that need custom ACP lifecycle control (e.g. weixin-openclaw-bridge),
 * import from the `advanced` subpath:
 *
 * ```ts
 * import { connectToHost } from "@vibearound/plugin-channel-sdk/advanced";
 * ```
 */

// ---------------------------------------------------------------------------
// High-level API — what plugin developers use
// ---------------------------------------------------------------------------

// Entry point
export { runChannelPlugin } from "./plugin.js";

// Base class for stream rendering
export { BlockRenderer } from "./renderer.js";

// Inbound prompt routing
export {
  cancelChannelPrompt,
  isChannelStopCommand,
  isChannelPromptAllowed,
  sendChannelPrompt,
} from "./channel-prompt.js";
export type {
  CancelChannelPromptInput,
  SendChannelPromptInput,
} from "./channel-prompt.js";

// Interfaces the plugin implements
export type {
  ChannelBot,
  ChannelPluginLogger,
  CreateBotContext,
  RunChannelPluginSpec,
  VerboseOptions,
} from "./plugin.js";

// Types used in BlockRenderer overrides
export type {
  AddressedBy,
  BlockKind,
  ChannelInboundContext,
  ChannelRoute,
  ChannelTarget,
  ChannelSessionInfo,
  CommandEntry,
  ConversationScope,
  VerboseConfig,
  BlockRendererOptions,
} from "./types.js";

export {
  channelRouteKey,
  channelTargetFromInboundContext,
  channelTargetKey,
} from "./types.js";

// ACP types the plugin needs for prompt content and permission overrides
export type {
  Agent,
  ContentBlock,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "./types.js";

// Error utility
export { extractErrorMessage } from "./errors.js";
