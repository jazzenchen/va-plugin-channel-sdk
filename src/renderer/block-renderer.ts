/**
 * BlockRenderer — abstract base class for block-based message rendering.
 *
 * ## How it works
 *
 * ACP streams agent responses as a sequence of typed events:
 *   text chunk, text chunk, tool call, tool update, text chunk, …
 *
 * Each contiguous run of the **same kind** (text / thinking / tool) is grouped
 * into one "block". When the kind changes, or when an out-of-band interaction
 * like a permission request interrupts the turn, the current block is
 * **sealed** (no more edits) and a new block starts.
 *
 * Blocks are rendered to the platform by subclass-implemented `sendBlock` and
 * `editBlock`. The renderer handles:
 *
 *   - **Debounced flushing** — batches rapid deltas before sending (avoids
 *     excessive API calls during fast streaming).
 *   - **Edit throttling** — enforces a minimum interval between edits to
 *     respect platform rate limits.
 *   - **Ordered delivery** — a `sendChain` Promise serializes all send/edit
 *     calls so messages always arrive in the correct order.
 *   - **Sentinel guard** — prevents concurrent creates for the same block.
 *   - **Verbose filtering** — thinking / tool blocks can be suppressed without
 *     creating phantom block boundaries.
 *
 * ## Usage
 *
 * Subclass and implement `sendText` + `sendBlock` (+ optionally `editBlock`):
 *
 * ```ts
 * class MyRenderer extends BlockRenderer<string> {
 *   protected async sendText(chatId, text) {
 *     await myApi.sendMessage(chatId, text);
 *   }
 *   protected async sendBlock(chatId, kind, content) {
 *     const msg = await myApi.sendMessage(chatId, content);
 *     return msg.id;
 *   }
 *   protected async editBlock(chatId, ref, kind, content, sealed) {
 *     await myApi.editMessage(ref, content);
 *   }
 * }
 * ```
 *
 * The SDK's `runChannelPlugin` wires all ACP events to this renderer
 * automatically — plugins don't call onSessionUpdate/onPromptSent/etc
 * directly.
 */

import type {
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  BlockKind,
  BlockRendererOptions,
  ChannelSessionInfo,
  CommandEntry,
  VerboseConfig,
} from "../types.js";
import type {
  ChannelState,
  ConsumedSessionUpdate,
  ManagedBlock,
  ToolKind,
} from "./types.js";
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MIN_EDIT_INTERVAL_MS,
} from "./types.js";
import { extractToolSummary, kindIcon } from "./tools.js";
import {
  fallbackOptionId,
  generateCallbackId,
  tryParsePermissionAnswer,
} from "./permissions.js";

/**
 * Abstract base class for block-based rendering of ACP session streams.
 *
 * @typeParam TRef - Platform-specific message reference type (e.g. `number`
 *   for Telegram message IDs, `string` for Feishu message IDs). Used as the
 *   return type of `sendBlock` and the first argument of `editBlock`.
 */
export abstract class BlockRenderer<TRef = string> {
  /** When true, blocks are sent and edited in real-time. When false, each
   *  block is held until complete, then sent once (send-only mode). */
  protected readonly streaming: boolean;
  protected readonly flushIntervalMs: number;
  protected readonly minEditIntervalMs: number;
  protected readonly verbose: VerboseConfig;

  private states = new Map<string, ChannelState<TRef>>();

  /** The chatId of the most recent prompt. Used as fallback target for
   *  notifications that arrive without an explicit chatId. */
  private lastActiveChatId: string | null = null;

  /**
   * Pending permission requests, keyed by callback id. Resolvers are invoked
   * by `resolvePermission` when the user clicks a button / sends a reply.
   * Stores the full option list so we can parse text answers and find the
   * right `reject_once` fallback on implicit cancel.
   */
  private pendingPermissions = new Map<
    string,
    {
      resolve: (optionId: string) => void;
      reject: (err: Error) => void;
      chatId: string;
      options: ReadonlyArray<{
        kind: string;
        optionId: string;
        name: string;
      }>;
    }
  >();

  /** Index chatId → callbackId so we can locate pending by channel in O(1).
   *  Each chat can only have one pending permission at a time (ACP semantics:
   *  a turn is blocked while a requestPermission is in flight). */
  private pendingByChat = new Map<string, string>();

  constructor(options: BlockRendererOptions = {}) {
    this.streaming = options.streaming ?? true;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.minEditIntervalMs = options.minEditIntervalMs ?? DEFAULT_MIN_EDIT_INTERVAL_MS;
    this.verbose = {
      showThinking: options.verbose?.showThinking ?? false,
      showToolUse: options.verbose?.showToolUse ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Abstract — plugin MUST implement these
  // ---------------------------------------------------------------------------

  /**
   * Send a plain text message to the IM. Used for system text, agent ready
   * notifications, session ready, and error messages.
   */
  protected abstract sendText(chatId: string, text: string): Promise<void>;

  /**
   * Send a new streaming block message to the platform.
   *
   * Return the platform message reference that will be passed to future
   * `editBlock` calls. Return `null` if editing is not supported.
   */
  protected abstract sendBlock(
    chatId: string,
    kind: BlockKind,
    content: string,
  ): Promise<TRef | null>;

  // ---------------------------------------------------------------------------
  // Optional overrides — plugin MAY implement these
  // ---------------------------------------------------------------------------

  /**
   * Edit an existing block message in-place.
   *
   * Optional — if not implemented, blocks are never edited (send-only mode,
   * suitable for platforms like WeChat that don't support message editing).
   *
   * @param sealed - `true` when this is the final edit (block done streaming).
   *   Use to switch from a "streaming" card format to a finalized one.
   */
  protected editBlock?(
    chatId: string,
    ref: TRef,
    kind: BlockKind,
    content: string,
    sealed: boolean,
  ): Promise<void>;

  /**
   * Format block content before sending or editing.
   *
   * Default applies standard emoji prefixes:
   *   - `thinking` → `💭 <content>`
   *   - `tool`     → trimmed content
   *   - `text`     → content as-is
   *
   * Override to apply platform-specific formatting (e.g. markdown escaping).
   */
  protected formatContent(kind: BlockKind, content: string, _sealed: boolean): string {
    switch (kind) {
      case "thinking": return `💭 ${content}`;
      case "tool":     return content.trim();
      case "text":     return content;
    }
  }

  /**
   * Called after the last block has been flushed and the turn is complete.
   * Override to perform cleanup (e.g. remove a "typing" indicator).
   */
  protected onAfterTurnEnd(_chatId: string): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Called after a turn error. Default sends an error message via sendText.
   * Override for platform-specific error rendering (e.g. error card).
   */
  protected async onAfterTurnError(chatId: string, error: string): Promise<void> {
    await this.sendText(chatId, `❌ Error: ${error}`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Process an ACP `sessionUpdate` notification from the host.
   *
   * Routes the event to the correct block based on its variant, appending
   * deltas to the current block or starting a new one when the kind changes.
   *
   * Called automatically by `runChannelPlugin` — plugins don't call this directly.
   */
  onSessionUpdate(notification: SessionNotification): void;
  onSessionUpdate(chatId: string, notification: SessionNotification): void;
  onSessionUpdate(
    chatIdOrNotification: string | SessionNotification,
    maybeNotification?: SessionNotification,
  ): void {
    const chatId =
      typeof chatIdOrNotification === "string"
        ? chatIdOrNotification
        : chatIdOrNotification.sessionId;
    const notification =
      typeof chatIdOrNotification === "string"
        ? maybeNotification
        : chatIdOrNotification;
    if (!notification) return;

    const rawUpdate = notification.update as unknown as { sessionUpdate: string };
    const variant = rawUpdate.sessionUpdate;
    if (
      variant !== "agent_message_chunk" &&
      variant !== "agent_thought_chunk" &&
      variant !== "tool_call" &&
      variant !== "tool_call_update" &&
      variant !== "current_mode_update"
    ) {
      return;
    }
    const update = rawUpdate as ConsumedSessionUpdate;

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const delta = update.content?.text ?? "";
        if (delta) this.appendToBlock(chatId, "text", delta);
        break;
      }
      case "agent_thought_chunk": {
        if (!this.verbose.showThinking) return;
        const delta = update.content?.text ?? "";
        if (delta) this.appendToBlock(chatId, "thinking", delta);
        break;
      }
      case "tool_call": {
        if (!this.verbose.showToolUse) return;
        const state = this.ensureState(chatId);
        const title = update.title ?? "tool";
        const kind = update.kind ?? undefined;
        state.toolCalls.set(update.toolCallId, { title, kind });
        this.appendToBlock(chatId, "tool", `${kindIcon(kind)} ${title}\n`);
        break;
      }
      case "tool_call_update": {
        if (!this.verbose.showToolUse) return;
        const state = this.ensureState(chatId);
        const cached = state.toolCalls.get(update.toolCallId);
        const title = (update.title ?? cached?.title ?? "tool");
        const kind = (update.kind ?? cached?.kind) as ToolKind | undefined;
        if (update.title || update.kind) {
          state.toolCalls.set(update.toolCallId, { title, kind });
        }
        if (update.status === "completed" || update.status === "failed") {
          const icon = update.status === "failed" ? "❌" : "✅";
          const summary = extractToolSummary(update.content, update.rawOutput);
          const line = summary
            ? `${icon} ${title}\n   ↳ ${summary}\n`
            : `${icon} ${title}\n`;
          this.appendToBlock(chatId, "tool", line);
        }
        break;
      }
      case "current_mode_update": {
        Promise.resolve(this.onCurrentModeUpdate(chatId, update.currentModeId)).catch(() => {});
        break;
      }
    }
  }

  /**
   * Called when the agent reports a session mode change (e.g. user selected
   * "accept edits" from an ExitPlanMode permission card, or the host called
   * `/plan` to switch to plan mode).
   *
   * Default implementation sends a text badge. Override to render a
   * platform-specific card / pinned message / status indicator.
   */
  protected onCurrentModeUpdate(chatId: string, modeId: string): void | Promise<void> {
    const badges: Record<string, string> = {
      default: "🔓 Default mode",
      plan: "📋 Plan mode — agent will analyze without making changes",
      acceptEdits: "⏵⏵ Accept-edits mode — file edits auto-approved",
      bypassPermissions: "⚠️ Bypass mode — all permissions auto-approved",
      dontAsk: "🔒 Don't-ask mode — unknown tools auto-denied",
    };
    const text = badges[modeId] ?? `Mode: ${modeId}`;
    this.sendText(chatId, text).catch(() => {});
  }

  /**
   * Call before sending a prompt. Tracks the active chatId and clears
   * leftover state from a previous turn.
   */
  onPromptSent(chatId: string): void {
    this.lastActiveChatId = chatId;
    const old = this.states.get(chatId);
    if (old?.flushTimer) clearTimeout(old.flushTimer);
    this.states.set(chatId, {
      blocks: [],
      flushTimer: null,
      lastEditMs: 0,
      sendChain: Promise.resolve(),
      toolCalls: new Map(),
    });
  }

  /**
   * Get the ChannelState for a chat, creating it lazily if needed.
   * Host-initiated notifications (e.g. tool_call without prior prompt) can
   * land before onPromptSent is called — this keeps them working.
   */
  private ensureState(chatId: string): ChannelState<TRef> {
    let state = this.states.get(chatId);
    if (!state) {
      state = {
        blocks: [],
        flushTimer: null,
        lastEditMs: 0,
        sendChain: Promise.resolve(),
        toolCalls: new Map(),
      };
      this.states.set(chatId, state);
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // Host notification handlers — built-in defaults, no per-plugin duplication
  // ---------------------------------------------------------------------------

  /** Handle `va/system_text` from host. */
  onSystemText(chatId: string, text: string): void {
    this.sendText(chatId, text).catch(() => {});
  }

  /** Handle `va/session_info` from host. */
  onSessionInfo(chatId: string, info: ChannelSessionInfo): void {
    const agentVersion = info.agent.version ? ` v${info.agent.version}` : "";
    const profile = info.agent.profileId ?? "default";
    const sessionLine =
      info.start === "new"
        ? `New session started: ${info.sessionId}`
        : `Continuing from session: ${info.sessionId}`;
    this.sendText(
      chatId,
      [
        "ℹ️ VibeAround session",
        `Workspace: ${info.workspacePath}`,
        `Agent: ${info.agent.name}${agentVersion}`,
        `Profile: ${profile}`,
        sessionLine,
      ].join("\n"),
    ).catch(() => {});
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onAgentReady(chatId: string, agent: string, version: string): void {
    void chatId;
    void agent;
    void version;
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onSessionReady(chatId: string, sessionId: string): void {
    void chatId;
    void sessionId;
  }

  /**
   * Handle `va/command_menu` from host — display available commands.
   *
   * Default renders a plain-text list. Override for platform-specific
   * rendering (e.g. Feishu interactive card, Slack Block Kit, Telegram
   * inline keyboard).
   */
  onCommandMenu(
    chatId: string,
    systemCommands: CommandEntry[],
    agentCommands: CommandEntry[],
  ): void {
    const lines: string[] = [];

    lines.push("System commands:");
    for (const cmd of systemCommands) {
      const usage = cmd.args ? `/${cmd.name} ${cmd.args}` : `/${cmd.name}`;
      lines.push(`  ${usage} — ${cmd.description}`);
    }

    if (agentCommands.length > 0) {
      lines.push("");
      lines.push("Agent commands (use /agent <command>):");
      for (const cmd of agentCommands) {
        const desc = cmd.description.length > 80
          ? `${cmd.description.slice(0, 77)}...`
          : cmd.description;
        lines.push(`  /${cmd.name} — ${desc}`);
      }
    } else {
      lines.push("");
      lines.push("Agent commands will appear after sending your first message.");
    }

    this.sendText(chatId, lines.join("\n")).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Permission flow
  // ---------------------------------------------------------------------------

  /**
   * Entry point used by the SDK to ask the user for permission.
   *
   * Generates a unique callbackId, registers a pending resolver, then delegates
   * to `onRequestPermission` for the actual UI. The subclass is expected to
   * eventually call `resolvePermission(callbackId, optionId)` — either
   * directly (interactive buttons) or through `consumePendingText` parsing
   * the user's text reply.
   *
   * Never rejects on render errors — falls back to the "reject_once" option
   * if present, otherwise the first option, so the agent is never left hanging.
   */
  async requestPermission(request: RequestPermissionRequest): Promise<string>;
  async requestPermission(chatId: string, request: RequestPermissionRequest): Promise<string>;
  async requestPermission(
    chatIdOrRequest: string | RequestPermissionRequest,
    maybeRequest?: RequestPermissionRequest,
  ): Promise<string> {
    const chatId =
      typeof chatIdOrRequest === "string"
        ? chatIdOrRequest
        : chatIdOrRequest.sessionId;
    const request =
      typeof chatIdOrRequest === "string" ? maybeRequest : chatIdOrRequest;
    if (!request) {
      throw new Error("requestPermission requires a request");
    }

    await this.sealActiveBlock(chatId);

    const callbackId = generateCallbackId();
    // Only one pending per chat. A new request on the same chat implicitly
    // cancels the old (shouldn't happen in practice because ACP serializes
    // per-session, but keep the invariant explicit).
    const prior = this.pendingByChat.get(chatId);
    if (prior) {
      this.resolvePermissionInternal(prior, null);
    }

    const options: ReadonlyArray<{ kind: string; optionId: string; name: string }> =
      (request.options ?? []).map((o) => ({
        kind: String(o.kind ?? ""),
        optionId: String(o.optionId ?? ""),
        name: String(o.name ?? ""),
      }));

    return new Promise<string>((resolve, reject) => {
      this.pendingPermissions.set(callbackId, { resolve, reject, chatId, options });
      this.pendingByChat.set(chatId, callbackId);
      Promise.resolve(this.onRequestPermission(chatId, request, callbackId)).catch((err) => {
        // Render failed — fall back so the agent is never stuck.
        if (!this.pendingPermissions.has(callbackId)) return;
        this.pendingPermissions.delete(callbackId);
        if (this.pendingByChat.get(chatId) === callbackId) {
          this.pendingByChat.delete(chatId);
        }
        const fallback = fallbackOptionId(request);
        if (fallback) {
          resolve(fallback);
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  /**
   * Resolve a pending permission request. Call this from the bot when the
   * user clicks a button / invokes a callback with the matching `callbackId`.
   *
   * @returns `true` if a pending request was resolved, `false` otherwise.
   */
  resolvePermission(callbackId: string, optionId: string): boolean {
    return this.resolvePermissionInternal(callbackId, optionId);
  }

  /**
   * Feed a new user text message into the pending permission flow for this chat.
   *
   * Semantics:
   *   - Parseable answer (number / keyword / optionId)  → resolve + return `true`
   *     (message consumed, bot should NOT forward).
   *   - Not parseable, but there IS a pending permission → implicit cancel
   *     (resolve as `reject_once`) + return `false` (message NOT consumed; bot
   *     should forward as a new prompt — the reject gracefully ends the stalled
   *     turn and lets the user's new message start a fresh one).
   *   - No pending → return `false` (nothing to do).
   *
   * Bots should call this before forwarding a user text message to
   * `agent.prompt()`:
   *
   * ```ts
   * if (streamHandler.consumePendingText(chatId, text)) return;
   * // else: forward as new prompt
   * ```
   */
  consumePendingText(chatId: string, text: string): boolean {
    const callbackId = this.pendingByChat.get(chatId);
    if (!callbackId) return false;
    const entry = this.pendingPermissions.get(callbackId);
    if (!entry) {
      this.pendingByChat.delete(chatId);
      return false;
    }

    const parsed = tryParsePermissionAnswer(text, entry.options);
    if (parsed) {
      this.resolvePermissionInternal(callbackId, parsed);
      return true;
    }

    // No match — implicit cancel as reject_once (safer than allow).
    const rejectId =
      entry.options.find((o) => o.kind === "reject_once")?.optionId ??
      entry.options.find((o) => o.kind === "reject_always")?.optionId ??
      entry.options[0]?.optionId ??
      null;
    this.resolvePermissionInternal(callbackId, rejectId);
    return false;
  }

  /**
   * Render a permission request to the user. Eventually the user should
   * respond — either via button click → `resolvePermission(callbackId, optionId)`,
   * or via text reply → the bot calls `consumePendingText(chatId, text)` before
   * forwarding, which parses the text and resolves for us.
   *
   * Default implementation: send a numbered text prompt. That's it — we do
   * NOT loop, because `consumePendingText` drives the flow from the bot side.
   * Tier-1 platforms with interactive components should override to render
   * buttons / inline keyboards instead.
   */
  protected async onRequestPermission(
    chatId: string,
    request: RequestPermissionRequest,
    _callbackId: string,
  ): Promise<void> {
    const options = request.options ?? [];
    const toolTitle =
      (request.toolCall as { title?: string } | undefined)?.title ?? "the agent";
    const header = `🔐 Permission required — ${toolTitle}`;
    const numbered = options.map((opt, i) => `  ${i + 1}. ${opt.name}`);
    const hint = `Reply with a number (1-${options.length}). Any other message cancels and continues.`;
    const prompt = [header, "", ...numbered, "", hint].join("\n");
    await this.sendText(chatId, prompt);
  }

  /** Internal: resolve a pending permission, maintaining both lookup tables.
   *  Pass `null` for optionId to treat the resolution as "cancelled" — in
   *  that case the resolver is not called, the agent-side Promise stays
   *  pending (caller should only use null when replacing with a new pending
   *  on the same chat, which shouldn't happen in practice). */
  private resolvePermissionInternal(
    callbackId: string,
    optionId: string | null,
  ): boolean {
    const entry = this.pendingPermissions.get(callbackId);
    if (!entry) return false;
    this.pendingPermissions.delete(callbackId);
    if (this.pendingByChat.get(entry.chatId) === callbackId) {
      this.pendingByChat.delete(entry.chatId);
    }
    if (optionId !== null) {
      entry.resolve(optionId);
    }
    return true;
  }

  /**
   * Call this after `agent.prompt()` resolves (turn complete).
   *
   * Seals and flushes the last block, then waits for all pending sends/edits
   * to complete before calling `onAfterTurnEnd`.
   */
  async onTurnEnd(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) return;

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    const last = state.blocks.at(-1);
    if (last && !last.sealed) {
      last.sealed = true;
      this.enqueueFlush(state, last);
    }

    await state.sendChain;
    this.states.delete(chatId);
    await this.onAfterTurnEnd(chatId);
  }

  /**
   * Call this when `agent.prompt()` throws (turn error).
   *
   * Discards pending state and calls `onAfterTurnError`.
   */
  async onTurnError(chatId: string, error: string): Promise<void> {
    const state = this.states.get(chatId);
    if (state?.flushTimer) clearTimeout(state.flushTimer);
    this.states.delete(chatId);
    await this.onAfterTurnError(chatId, error);
  }

  // ---------------------------------------------------------------------------
  // Internal — block management
  // ---------------------------------------------------------------------------

  private appendToBlock(chatId: string, kind: BlockKind, delta: string): void {
    const state = this.ensureState(chatId);

    const last = state.blocks.at(-1);

    if (last && !last.sealed && last.kind === kind) {
      // Same kind — accumulate
      last.content += delta;
    } else {
      // Kind changed — seal current block and start a new one
      if (last && !last.sealed) {
        last.sealed = true;
        // Clear the debounce timer: we're doing an immediate flush of the sealed block
        if (state.flushTimer) {
          clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        this.enqueueFlush(state, last);
      }
      state.blocks.push({ chatId, kind, content: delta, ref: null, creating: false, sealed: false });
    }

    this.scheduleFlush(chatId, state);
  }

  private async sealActiveBlock(chatId: string): Promise<void> {
    const state = this.states.get(chatId);
    if (!state) return;

    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    const last = state.blocks.at(-1);
    if (last && !last.sealed) {
      last.sealed = true;
      this.enqueueFlush(state, last);
    }

    await state.sendChain;
  }

  private scheduleFlush(chatId: string, state: ChannelState<TRef>): void {
    if (state.flushTimer) return; // already scheduled

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(chatId, state);
    }, this.flushIntervalMs);
  }

  private flush(chatId: string, state: ChannelState<TRef>): void {
    const block = state.blocks.at(-1);
    if (!block || block.sealed || !block.content) return;

    // Send-only mode (streaming=false): defer intermediate sends.
    // Only sealed blocks (from onTurnEnd or block boundary transitions)
    // will actually POST. This prevents the user seeing a partial chunk
    // followed by the full message as two separate messages.
    if (!this.streaming) {
      return;
    }

    const now = Date.now();
    if (now - state.lastEditMs < this.minEditIntervalMs) {
      // Throttled — reschedule for the remaining window
      const delay = this.minEditIntervalMs - (now - state.lastEditMs);
      if (!state.flushTimer) {
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null;
          this.flush(chatId, state);
        }, delay);
      }
      return;
    }

    this.enqueueFlush(state, block);
  }

  private enqueueFlush(state: ChannelState<TRef>, block: ManagedBlock<TRef>): void {
    state.sendChain = state.sendChain
      .then(() => this.flushBlock(state, block))
      .catch(() => {}); // errors are handled inside flushBlock
  }

  private async flushBlock(state: ChannelState<TRef>, block: ManagedBlock<TRef>): Promise<void> {
    const content = this.formatContent(block.kind, block.content, block.sealed);
    if (!content) return;

    try {
      if (block.ref === null && !block.creating) {
        // First send — use sentinel to prevent concurrent creates
        block.creating = true;
        block.ref = await this.sendBlock(block.chatId, block.kind, content);
        block.creating = false;
        state.lastEditMs = Date.now();
      } else if (block.ref !== null && !block.creating && this.streaming && this.editBlock) {
        // Subsequent update — edit in-place (streaming mode only)
        await this.editBlock(block.chatId, block.ref, block.kind, content, block.sealed);
        state.lastEditMs = Date.now();
      }
      // else: create is in-flight (creating === true) — skip
    } catch {
      block.creating = false;
    }
  }
}
