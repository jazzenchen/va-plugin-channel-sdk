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
 *   protected async sendText(target, text) {
 *     await myApi.sendMessage(target.chatId, text);
 *   }
 *   protected async sendBlock(target, kind, content) {
 *     const msg = await myApi.sendMessage(target.chatId, content);
 *     return msg.id;
 *   }
 *   protected async editBlock(target, ref, kind, content, sealed) {
 *     await myApi.editMessage(ref, content);
 *   }
 * }
 * ```
 *
 * The SDK's `runChannelPlugin` wires all ACP events to this renderer
 * automatically — plugins don't call onSessionUpdate/onPromptSent/etc
 * directly.
 */

import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RequestPermissionRequest,
  ResourceLink,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  BlockKind,
  BlockRendererOptions,
  ChannelSessionInfo,
  ChannelTarget,
  CommandEntry,
  OutboundFile,
  VerboseConfig,
} from "../types.js";
import { channelRouteKey, channelTargetKey } from "../types.js";
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

  /** Platform API calls must remain ordered per target even when the ACP
   *  transport dispatches several notifications without awaiting the prior
   *  handler. Different targets retain independent delivery lanes. */
  private deliveryChains = new Map<string, Promise<unknown>>();
  /** Failures from fire-and-forget deliveries such as system text. Block
   *  deliveries keep their own recoverable error state. */
  private deliveryErrors = new Map<string, unknown>();
  /** Workspace root supplied by the Host for each stable route. */
  private workspacePaths = new Map<string, string>();

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
      target: ChannelTarget;
      routeKey: string;
      options: ReadonlyArray<{
        kind: string;
        optionId: string;
        name: string;
      }>;
    }
  >();

  /** Index stable route key → callbackId for O(1) lookup.
   *  `replyTo` is deliberately excluded because a text permission answer is a
   *  new platform message. Each route can only have one pending permission
   *  at a time (ACP semantics:
   *  a turn is blocked while a requestPermission is in flight). */
  private pendingByRoute = new Map<string, string>();

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
  protected abstract sendText(target: ChannelTarget, text: string): Promise<void>;

  /**
   * Send a new streaming block message to the platform.
   *
   * Return the platform message reference that will be passed to future
   * `editBlock` calls. Return `null` if editing is not supported.
   */
  protected abstract sendBlock(
    target: ChannelTarget,
    kind: BlockKind,
    content: string,
  ): Promise<TRef | null>;

  /** Upload a workspace file to the platform. Unsupported plugins may omit it. */
  protected sendFile?(
    target: ChannelTarget,
    file: OutboundFile,
  ): Promise<void>;

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
    target: ChannelTarget,
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
  protected onAfterTurnEnd(_target: ChannelTarget): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Called after a turn error. Default sends an error message via sendText.
   * Override for platform-specific error rendering (e.g. error card).
   */
  protected async onAfterTurnError(target: ChannelTarget, error: string): Promise<void> {
    await this.enqueueDelivery(target, () => this.sendText(target, `❌ Error: ${error}`));
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
  onSessionUpdate(target: ChannelTarget, notification: SessionNotification): void {
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
        if (update.content?.type === "text") {
          const delta = update.content.text ?? "";
          if (delta) this.appendToBlock(target, "text", delta, update.messageId);
        } else if (update.content?.type === "resource_link") {
          this.appendResourceLink(target, update.content);
        }
        break;
      }
      case "agent_thought_chunk": {
        if (!this.verbose.showThinking) return;
        const delta = update.content?.text ?? "";
        if (delta) this.appendToBlock(target, "thinking", delta, update.messageId);
        break;
      }
      case "tool_call": {
        if (!this.verbose.showToolUse) return;
        const state = this.ensureState(target);
        const title = update.title ?? "tool";
        const kind = update.kind ?? undefined;
        state.toolCalls.set(update.toolCallId, { title, kind });
        this.appendToBlock(target, "tool", `${kindIcon(kind)} ${title}\n`);
        break;
      }
      case "tool_call_update": {
        if (!this.verbose.showToolUse) return;
        const state = this.ensureState(target);
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
          this.appendToBlock(target, "tool", line);
        }
        break;
      }
      case "current_mode_update": {
        Promise.resolve(this.onCurrentModeUpdate(target, update.currentModeId)).catch((error) => {
          this.recordDeliveryError(target, error);
        });
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
  protected onCurrentModeUpdate(target: ChannelTarget, modeId: string): void | Promise<void> {
    const badges: Record<string, string> = {
      default: "🔓 Default mode",
      plan: "📋 Plan mode — agent will analyze without making changes",
      acceptEdits: "⏵⏵ Accept-edits mode — file edits auto-approved",
      bypassPermissions: "⚠️ Bypass mode — all permissions auto-approved",
      dontAsk: "🔒 Don't-ask mode — unknown tools auto-denied",
    };
    const text = badges[modeId] ?? `Mode: ${modeId}`;
    this.enqueueUnobservedDelivery(target, () => this.sendText(target, text));
  }

  /**
   * Call before sending a prompt. Clears
   * leftover state from a previous turn.
   */
  onPromptSent(target: ChannelTarget): void {
    const targetKey = channelTargetKey(target);
    this.clearPendingPermission(target);
    this.deliveryErrors.delete(targetKey);
    const old = this.states.get(targetKey);
    if (old?.flushTimer) clearTimeout(old.flushTimer);
    this.states.set(targetKey, {
      blocks: [],
      flushTimer: null,
      lastEditMs: 0,
      sendChain: Promise.resolve(),
      toolCalls: new Map(),
    });
  }

  /**
   * Get the ChannelState for a target, creating it lazily if needed.
   * Host-initiated notifications (e.g. tool_call without prior prompt) can
   * land before onPromptSent is called — this keeps them working.
   */
  private ensureState(target: ChannelTarget): ChannelState<TRef> {
    const targetKey = channelTargetKey(target);
    let state = this.states.get(targetKey);
    if (!state) {
      state = {
        blocks: [],
        flushTimer: null,
        lastEditMs: 0,
        sendChain: Promise.resolve(),
        toolCalls: new Map(),
      };
      this.states.set(targetKey, state);
    }
    return state;
  }

  // ---------------------------------------------------------------------------
  // Host notification handlers — built-in defaults, no per-plugin duplication
  // ---------------------------------------------------------------------------

  /** Handle `va/system_text` from host. */
  onSystemText(target: ChannelTarget, text: string): void {
    this.enqueueUnobservedDelivery(target, () => this.sendText(target, text));
  }

  /** Handle `va/session_info` from host. */
  onSessionInfo(target: ChannelTarget, info: ChannelSessionInfo): void {
    this.rememberSessionInfo(target, info);
    const agentVersion = info.agent.version ? ` v${info.agent.version}` : "";
    const profile = info.agent.profileId ?? "default";
    const sessionLine =
      info.start === "new"
        ? `New session started: ${info.sessionId}`
        : `Continuing from session: ${info.sessionId}`;
    this.enqueueUnobservedDelivery(target, () =>
      this.sendText(
        target,
        [
          "ℹ️ VibeAround session",
          `Workspace: ${info.workspacePath}`,
          `Agent: ${info.agent.name}${agentVersion}`,
          `Profile: ${profile}`,
          sessionLine,
        ].join("\n"),
      ),
    );
  }

  /** Record route metadata when a plugin supplies its own session card. */
  protected rememberSessionInfo(
    target: ChannelTarget,
    info: ChannelSessionInfo,
  ): void {
    this.workspacePaths.set(channelRouteKey(target), info.workspacePath);
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onAgentReady(target: ChannelTarget, agent: string, version: string): void {
    void target;
    void agent;
    void version;
  }

  /** @deprecated `va/session_info` carries the visible startup card. */
  onSessionReady(target: ChannelTarget, sessionId: string): void {
    void target;
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
    target: ChannelTarget,
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

    this.enqueueUnobservedDelivery(target, () => this.sendText(target, lines.join("\n")));
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
   * Render errors fall back to reject_once. If the request offers no
   * reject_once option, this rejects so the plugin boundary returns ACP
   * cancelled instead of silently making a persistent choice for the user.
   */
  async requestPermission(
    target: ChannelTarget,
    request: RequestPermissionRequest,
  ): Promise<string> {
    const routeKey = channelRouteKey(target);
    await this.sealActiveBlock(target);

    const callbackId = generateCallbackId();
    // Only one pending per target. A new request on the same target implicitly
    // cancels the old (shouldn't happen in practice because ACP serializes
    // per-session, but keep the invariant explicit).
    const prior = this.pendingByRoute.get(routeKey);
    if (prior) {
      this.clearPendingPermission(target);
    }

    const options: ReadonlyArray<{ kind: string; optionId: string; name: string }> =
      (request.options ?? []).map((o) => ({
        kind: String(o.kind ?? ""),
        optionId: String(o.optionId ?? ""),
        name: String(o.name ?? ""),
      }));

    return new Promise<string>((resolve, reject) => {
      this.pendingPermissions.set(callbackId, {
        resolve,
        reject,
        target,
        routeKey,
        options,
      });
      this.pendingByRoute.set(routeKey, callbackId);
      Promise.resolve(this.onRequestPermission(target, request, callbackId)).catch((err) => {
        // Render failed — reject or cancel so the agent is never stuck.
        if (!this.pendingPermissions.has(callbackId)) return;
        this.pendingPermissions.delete(callbackId);
        if (this.pendingByRoute.get(routeKey) === callbackId) {
          this.pendingByRoute.delete(routeKey);
        }
        const fallback = fallbackOptionId(request.options);
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
   * Feed a new user text message into the pending permission flow for this target.
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
   * if (streamHandler.consumePendingText(target, text)) return;
   * // else: forward as new prompt
   * ```
   */
  consumePendingText(target: ChannelTarget, text: string): boolean {
    const routeKey = channelRouteKey(target);
    const callbackId = this.pendingByRoute.get(routeKey);
    if (!callbackId) return false;
    const entry = this.pendingPermissions.get(callbackId);
    if (!entry) {
      this.pendingByRoute.delete(routeKey);
      return false;
    }

    const parsed = tryParsePermissionAnswer(text, entry.options);
    if (parsed) {
      this.resolvePermissionInternal(callbackId, parsed);
      return true;
    }

    // No match — reject once or cancel. Persistent rejection is a user choice.
    this.resolvePermissionInternal(callbackId, fallbackOptionId(entry.options));
    return false;
  }

  /**
   * Render a permission request to the user. Eventually the user should
   * respond — either via button click → `resolvePermission(callbackId, optionId)`,
   * or via text reply → the bot calls `consumePendingText(target, text)` before
   * forwarding, which parses the text and resolves for us.
   *
   * Default implementation: send a numbered text prompt. That's it — we do
   * NOT loop, because `consumePendingText` drives the flow from the bot side.
   * Tier-1 platforms with interactive components should override to render
   * buttons / inline keyboards instead.
   */
  protected async onRequestPermission(
    target: ChannelTarget,
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
    await this.enqueueDelivery(target, () => this.sendText(target, prompt));
  }

  /** Internal: resolve a pending permission, maintaining both lookup tables. */
  private resolvePermissionInternal(
    callbackId: string,
    optionId: string | null,
  ): boolean {
    const entry = this.pendingPermissions.get(callbackId);
    if (!entry) return false;
    this.pendingPermissions.delete(callbackId);
    if (this.pendingByRoute.get(entry.routeKey) === callbackId) {
      this.pendingByRoute.delete(entry.routeKey);
    }
    if (optionId !== null) entry.resolve(optionId);
    else entry.reject(new Error("permission request cancelled"));
    return true;
  }

  private clearPendingPermission(target: ChannelTarget): void {
    const routeKey = channelRouteKey(target);
    const callbackId = this.pendingByRoute.get(routeKey);
    if (!callbackId) return;
    const entry = this.pendingPermissions.get(callbackId);
    this.pendingByRoute.delete(routeKey);
    if (!entry) return;
    this.pendingPermissions.delete(callbackId);

    const fallback = fallbackOptionId(entry.options);
    if (fallback) entry.resolve(fallback);
    else entry.reject(new Error("permission request cancelled because the turn ended"));
  }

  /**
   * Call this after `agent.prompt()` resolves (turn complete).
   *
   * Seals and flushes the last block, then waits for all pending sends/edits
   * to complete before calling `onAfterTurnEnd`. Rejects after state cleanup
   * when any delivery remains failed.
   */
  async onTurnEnd(target: ChannelTarget): Promise<void> {
    const targetKey = channelTargetKey(target);
    this.clearPendingPermission(target);
    const state = this.states.get(targetKey);
    if (!state) {
      await this.drainDeliveries(targetKey);
      if (this.deliveryErrors.has(targetKey)) {
        const error = this.deliveryErrors.get(targetKey);
        this.deliveryErrors.delete(targetKey);
        throw error;
      }
      return;
    }

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
    await this.drainDeliveries(targetKey);
    const failedBlock = state.blocks.find((block) => block.deliveryError !== null);
    const hasDeliveryError = this.deliveryErrors.has(targetKey);
    const deliveryError = this.deliveryErrors.get(targetKey);
    this.states.delete(targetKey);
    this.deliveryErrors.delete(targetKey);
    if (failedBlock) throw failedBlock.deliveryError;
    if (hasDeliveryError) throw deliveryError;
    await this.onAfterTurnEnd(target);
  }

  /**
   * Call this when `agent.prompt()` throws (turn error).
   *
   * Discards pending state and calls `onAfterTurnError`.
   */
  async onTurnError(target: ChannelTarget, error: string): Promise<void> {
    const targetKey = channelTargetKey(target);
    this.clearPendingPermission(target);
    const state = this.states.get(targetKey);
    if (state?.flushTimer) clearTimeout(state.flushTimer);
    this.states.delete(targetKey);
    this.deliveryErrors.delete(targetKey);
    await this.onAfterTurnError(target, error);
  }

  // ---------------------------------------------------------------------------
  // Internal — block management
  // ---------------------------------------------------------------------------

  private appendToBlock(
    target: ChannelTarget,
    kind: BlockKind,
    delta: string,
    messageId?: string | null,
  ): void {
    const state = this.ensureState(target);
    const normalizedMessageId = normalizeMessageId(messageId);

    const last = state.blocks.at(-1);

    if (
      last &&
      !last.sealed &&
      last.kind === kind &&
      sameMessageBlock(last.messageId, normalizedMessageId)
    ) {
      // Same kind — accumulate
      if (!last.messageId && normalizedMessageId) {
        last.messageId = normalizedMessageId;
      }
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
      state.blocks.push({
        target,
        kind,
        messageId: normalizedMessageId,
        content: delta,
        ref: null,
        creating: false,
        sealed: false,
        deliveryError: null,
      });
    }

    this.scheduleFlush(target, state);
  }

  private appendResourceLink(target: ChannelTarget, resource: ResourceLink): void {
    const state = this.ensureState(target);
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    const last = state.blocks.at(-1);
    if (last && !last.sealed) {
      last.sealed = true;
      this.enqueueFlush(state, last);
    }
    state.sendChain = state.sendChain
      .then(() => this.enqueueDelivery(target, () => this.deliverResourceLink(target, resource)))
      .catch((error) => {
        this.recordDeliveryError(target, error);
      });
  }

  private async deliverResourceLink(
    target: ChannelTarget,
    resource: ResourceLink,
  ): Promise<void> {
    const name = safeResourceName(resource.name, resource.uri);
    let filePath: string;
    try {
      filePath = fileURLToPath(resource.uri);
    } catch {
      if (/^https?:\/\//i.test(resource.uri)) {
        await this.sendText(target, `📎 ${name}\n${resource.uri}`);
        return;
      }
      await this.sendText(target, `⚠️ ${name} was not sent because its resource URI is unsupported.`);
      return;
    }

    const workspacePath = this.workspacePaths.get(channelRouteKey(target));
    if (!workspacePath) {
      throw new Error(`cannot send ${name}: active workspace is unavailable`);
    }
    const [workspaceRoot, resolvedFile] = await Promise.all([
      realpath(workspacePath),
      realpath(filePath),
    ]);
    if (!pathIsWithin(workspaceRoot, resolvedFile)) {
      await this.sendText(
        target,
        `⚠️ ${name} was not sent because it is outside the active workspace.`,
      );
      return;
    }
    const metadata = await stat(resolvedFile);
    if (!metadata.isFile()) {
      throw new Error(`cannot send ${name}: resource is not a file`);
    }
    if (!this.sendFile) {
      await this.sendText(target, `📎 ${name} (file upload is not supported by this channel)`);
      return;
    }
    await this.sendFile(target, {
      path: resolvedFile,
      name,
      mimeType: resource.mimeType ?? undefined,
    });
  }

  private async sealActiveBlock(target: ChannelTarget): Promise<void> {
    const state = this.states.get(channelTargetKey(target));
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

  private scheduleFlush(target: ChannelTarget, state: ChannelState<TRef>): void {
    if (state.flushTimer) return; // already scheduled

    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      this.flush(target, state);
    }, this.flushIntervalMs);
  }

  private flush(target: ChannelTarget, state: ChannelState<TRef>): void {
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
          this.flush(target, state);
        }, delay);
      }
      return;
    }

    this.enqueueFlush(state, block);
  }

  private enqueueFlush(state: ChannelState<TRef>, block: ManagedBlock<TRef>): void {
    state.sendChain = state.sendChain
      .then(() => this.flushBlock(state, block))
      .catch((error) => {
        block.creating = false;
        block.deliveryError = error;
      });
  }

  private async flushBlock(state: ChannelState<TRef>, block: ManagedBlock<TRef>): Promise<void> {
    const content = this.formatContent(block.kind, block.content, block.sealed);
    if (!content) return;

    let delivered = false;
    try {
      if (block.ref === null && !block.creating) {
        // First send — use sentinel to prevent concurrent creates
        block.creating = true;
        block.ref = await this.enqueueDelivery(block.target, () =>
          this.sendBlock(block.target, block.kind, content),
        );
        block.creating = false;
        state.lastEditMs = Date.now();
        delivered = true;
      } else if (block.ref !== null && !block.creating && this.streaming && this.editBlock) {
        // Subsequent update — edit in-place (streaming mode only)
        await this.enqueueDelivery(block.target, () =>
          this.editBlock!(block.target, block.ref!, block.kind, content, block.sealed),
        );
        state.lastEditMs = Date.now();
        delivered = true;
      }
      // else: create is in-flight (creating === true) — skip
    } catch (error) {
      block.creating = false;
      block.deliveryError = error;
    }
    if (delivered) block.deliveryError = null;
  }

  private enqueueUnobservedDelivery<T>(
    target: ChannelTarget,
    operation: () => Promise<T>,
  ): void {
    void this.enqueueDelivery(target, operation).catch((error) => {
      this.recordDeliveryError(target, error);
    });
  }

  private recordDeliveryError(target: ChannelTarget, error: unknown): void {
    const targetKey = channelTargetKey(target);
    if (!this.deliveryErrors.has(targetKey)) {
      this.deliveryErrors.set(targetKey, error);
    }
  }

  private async drainDeliveries(targetKey: string): Promise<void> {
    try {
      await this.deliveryChains.get(targetKey);
    } catch (error) {
      if (!this.deliveryErrors.has(targetKey)) {
        this.deliveryErrors.set(targetKey, error);
      }
    }
  }

  private enqueueDelivery<T>(
    target: ChannelTarget,
    operation: () => Promise<T>,
  ): Promise<T> {
    const targetKey = channelTargetKey(target);
    const previous = this.deliveryChains.get(targetKey) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.deliveryChains.set(targetKey, next);
    void next.finally(() => {
      if (this.deliveryChains.get(targetKey) === next) {
        this.deliveryChains.delete(targetKey);
      }
    }).catch(() => {});
    return next;
  }
}

function normalizeMessageId(messageId: string | null | undefined): string | null {
  return typeof messageId === "string" && messageId.length > 0 ? messageId : null;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeResourceName(name: string, uri: string): string {
  const supplied = path.posix.basename(name.replaceAll("\\", "/")).trim();
  if (supplied && supplied !== "." && supplied !== "..") return supplied;
  try {
    return path.basename(fileURLToPath(uri)) || "attachment";
  } catch {
    return "attachment";
  }
}

function sameMessageBlock(left: string | null, right: string | null): boolean {
  return !left || !right || left === right;
}
