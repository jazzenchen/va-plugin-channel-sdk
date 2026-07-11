/**
 * Internal types + constants shared by the renderer submodules.
 *
 * - ACP session-update narrowing types: document exactly the fields this
 *   renderer consumes, so a mismatch against the upstream ACP SDK shows up
 *   as a compile error instead of silently producing `undefined`.
 * - Internal state types: `ManagedBlock`, `ChannelState`, `CachedToolCall`.
 * - Constants: flush interval, edit throttle, tool-summary cap, kind icons.
 */

import type { BlockKind, ChannelTarget } from "../types.js";

// ---------------------------------------------------------------------------
// ACP session-update narrowing
// ---------------------------------------------------------------------------

export interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  messageId?: string | null;
  content?: { text?: string };
}

export interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  messageId?: string | null;
  content?: { text?: string };
}

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallContentText {
  type?: string;
  text?: string;
  content?: { type?: string; text?: string };
}

export interface ToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolStatus;
  content?: ToolCallContentText[] | null;
  rawOutput?: unknown;
}

export interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolStatus | null;
  content?: ToolCallContentText[] | null;
  rawOutput?: unknown;
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
}

export type ConsumedSessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCall
  | ToolCallUpdate
  | CurrentModeUpdate;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

export interface ManagedBlock<TRef> {
  /** Per-message target this block belongs to. Captured at creation time. */
  target: ChannelTarget;
  kind: BlockKind;
  /** ACP message id for text/thought chunks. A change starts a new block. */
  messageId: string | null;
  content: string;
  /** Platform message reference set after the first successful send. */
  ref: TRef | null;
  /** True while a create request is in-flight (prevents concurrent creates). */
  creating: boolean;
  /** True once the block will receive no more content. */
  sealed: boolean;
}

export interface CachedToolCall {
  title: string;
  kind?: ToolKind;
}

export interface ChannelState<TRef> {
  blocks: ManagedBlock<TRef>[];
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** Timestamp of the last successful send or edit (for throttle calculation). */
  lastEditMs: number;
  /** Serializes all send/edit calls — guarantees message order. */
  sendChain: Promise<void>;
  /** Cached tool-call metadata so `tool_call_update` events (which often omit
   *  title/kind) can render proper names and icons. Keyed by toolCallId. */
  toolCalls: Map<string, CachedToolCall>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_FLUSH_INTERVAL_MS = 500;
export const DEFAULT_MIN_EDIT_INTERVAL_MS = 1000;

/** Max length of the one-line tool-completion summary. */
export const TOOL_SUMMARY_MAX_LEN = 80;

export const KIND_ICONS: Record<ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑",
  move: "📦",
  search: "🔍",
  execute: "⚡",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔀",
  other: "🔧",
};
