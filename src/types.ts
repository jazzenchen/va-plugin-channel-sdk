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
}
