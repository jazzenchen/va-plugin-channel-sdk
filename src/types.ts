/**
 * Shared types for VibeAround channel plugins.
 *
 * Re-exports the ACP SDK types plugins commonly need, plus SDK-specific types
 * for block rendering, plugin manifests, and verbose configuration.
 */

// Re-export ACP SDK types so plugin authors only need one import
export type {
  Agent,
  Client,
  ContentBlock,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

// ---------------------------------------------------------------------------
// Plugin manifest
// ---------------------------------------------------------------------------

export interface PluginCapabilities {
  /** Plugin supports real-time streaming updates. */
  streaming?: boolean;
  /** Platform supports rich interactive cards (e.g. Feishu). */
  interactiveCards?: boolean;
  /** Platform supports editing already-sent messages. */
  editMessage?: boolean;
  /** Platform supports file upload/download. */
  media?: boolean;
  auth?: { methods?: string[] };
}

/** Shape of plugin.json — the plugin manifest file. */
export interface PluginManifest {
  id: string;
  name: string;
  kind: "channel";
  runtime: "node";
  entry: string;
  build?: string;
  configSchema?: Record<string, unknown>;
  capabilities?: PluginCapabilities;
}

// ---------------------------------------------------------------------------
// Command menu
// ---------------------------------------------------------------------------

/** A command entry from the host's command list. */
export interface CommandEntry {
  name: string;
  description: string;
  args?: string;
  aliases?: string[];
}

// ---------------------------------------------------------------------------
// Inbound conversation routing
// ---------------------------------------------------------------------------

/** Whether an inbound message comes from a direct message or group chat. */
export type ConversationScope = "dm" | "group";

/** How an inbound message explicitly addressed the channel actor. */
export type AddressedBy =
  | "dm"
  | "mention"
  | "command"
  | "callback"
  | "unaddressed";

/** Platform-neutral routing metadata attached to an inbound channel prompt. */
export interface ChannelInboundContext {
  /** Configured channel/Bot instance that received the message. */
  channelInstanceId: string;
  /** Logical VibeAround actor addressed within that channel instance. */
  actorId: string;
  chatId: string;
  topicId?: string;
  senderId?: string;
  platformMessageId?: string;
  scope: ConversationScope;
  addressedBy: AddressedBy;
}

/** Stable channel route carried by every host-to-plugin notification. */
export interface ChannelRoute {
  /** Configured channel/Bot instance that owns the route. */
  channelInstanceId: string;
  /** Logical actor addressed within that channel instance. */
  actorId: string;
  /** Platform conversation identifier. */
  chatId: string;
  /** Platform topic/thread identifier, when the platform exposes one. */
  topicId?: string;
}

/** Per-message delivery target. `replyTo` must not be persisted as route identity. */
export interface ChannelTarget extends ChannelRoute {
  /** Platform message identifier that this output should reply to. */
  replyTo?: string;
}

/** Stable route key for cross-message state such as a pending text permission. */
export function channelRouteKey(route: ChannelRoute): string {
  return JSON.stringify([
    route.channelInstanceId,
    route.actorId,
    route.chatId,
    route.topicId ?? null,
  ]);
}

/**
 * Complete in-memory renderer/delivery key for one channel target.
 *
 * `replyTo` is intentionally included so concurrently active turns in the
 * same route cannot share streaming blocks or permission state.
 */
export function channelTargetKey(target: ChannelTarget): string {
  return JSON.stringify([
    target.channelInstanceId,
    target.actorId,
    target.chatId,
    target.topicId ?? null,
    target.replyTo ?? null,
  ]);
}

/** Convert one accepted inbound message into its matching output target. */
export function channelTargetFromInboundContext(
  context: ChannelInboundContext,
): ChannelTarget {
  return {
    channelInstanceId: context.channelInstanceId,
    actorId: context.actorId,
    chatId: context.chatId,
    topicId: context.topicId,
    replyTo: context.platformMessageId,
  };
}

// ---------------------------------------------------------------------------
// Session info
// ---------------------------------------------------------------------------

export interface ChannelSessionInfo {
  workspaceId: string;
  workspacePath: string;
  threadId: string;
  agent: {
    id: string;
    name: string;
    version?: string;
    profileId?: string;
  };
  sessionId: string;
  start: "new" | "resumed";
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

/** The three kinds of content blocks a plugin renders. */
export type BlockKind = "text" | "thinking" | "tool";

export interface VerboseConfig {
  /** Show agent thinking/reasoning blocks. Default: false. */
  showThinking: boolean;
  /** Show tool call / tool result blocks. Default: false. */
  showToolUse: boolean;
}

export interface BlockRendererOptions {
  /**
   * Whether the IM platform supports message editing (streaming mode).
   *
   * - `true` (default): blocks stream in real-time — `sendBlock()` creates
   *   the message, `editBlock()` updates it as more content arrives.
   * - `false`: each block is held until complete, then sent once via
   *   `sendBlock()`. `editBlock()` is never called.
   *
   * Set to `false` for platforms that don't support editing sent messages
   * (e.g. QQ Bot, WhatsApp, WeChat, LINE).
   */
  streaming?: boolean;
  /**
   * Debounce interval before flushing an unsealed block (ms).
   * Controls how often in-progress blocks are sent to the platform.
   * Default: 500.
   */
  flushIntervalMs?: number;
  /**
   * Minimum interval between consecutive edits to the same message (ms).
   * Prevents hitting platform API rate limits.
   * Default: 1000.
   */
  minEditIntervalMs?: number;
  verbose?: Partial<VerboseConfig>;
}

// ---------------------------------------------------------------------------
// Init / config
// ---------------------------------------------------------------------------

/**
 * Plugin config and metadata passed by the host in `_meta` during initialize.
 */
export interface PluginInitMeta {
  /** Plugin-specific config object from settings.json. */
  config: Record<string, unknown>;
  /** Host-provided cache directory path for temporary files. */
  cacheDir?: string;
  /** Channel kind registered by the host (for example, `feishu`). */
  channelKind?: string;
  /** Stable identity of this configured channel/Bot instance. */
  channelInstanceId?: string;
  /** Stable identity of the logical actor represented by this plugin. */
  actorId?: string;
}
