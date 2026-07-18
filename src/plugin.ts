/**
 * runChannelPlugin — the SDK entry point for every channel plugin.
 *
 * Handles the full ACP lifecycle: connect to host, validate config, create
 * bot + renderer, start the bot, then await disconnect and stop. The plugin
 * only implements platform-specific transport (sendText, sendBlock, editBlock).
 *
 * ## Usage
 *
 * ```ts
 * import { runChannelPlugin } from "@vibearound/plugin-channel-sdk";
 *
 * runChannelPlugin({
 *   name: "vibearound-slack",
 *   version: "0.1.0",
 *   requiredConfig: ["bot_token", "app_token"],
 *   createBot: ({ config, agent, log, cacheDir }) =>
 *     new SlackBot({ ... }, agent, log, cacheDir),
 *   createRenderer: (bot, log, verbose) =>
 *     new SlackRenderer(bot, log, verbose),
 * });
 * ```
 */

import os from "node:os";
import path from "node:path";
import type { Agent } from "@agentclientprotocol/sdk";

import { connectToHost, stripExtPrefix } from "./connection.js";
import {
  enablePromptCompletion,
  type PromptCompletionController,
} from "./channel-prompt.js";
import { extractErrorMessage } from "./errors.js";
import { BlockRenderer } from "./renderer.js";
import type {
  ChannelSessionInfo,
  ChannelTarget,
  PluginInitMeta,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ChannelPluginLogger = (level: string, msg: string) => void;

/**
 * The platform bot — handles IM connectivity and message transport.
 *
 * Plugins implement this interface on their bot class. The SDK calls these
 * methods during the plugin lifecycle.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ChannelBot<TRenderer extends BlockRenderer<any> = BlockRenderer<any>> {
  /** Wire the renderer to receive streaming events. */
  setStreamHandler(handler: TRenderer): void;
  /** Connect to the IM platform and start receiving messages. */
  start(): Promise<void> | void;
  /** Disconnect and clean up. */
  stop(): Promise<void> | void;
}

export interface CreateBotContext {
  config: Record<string, unknown>;
  agent: Agent;
  log: ChannelPluginLogger;
  cacheDir: string;
  /** Stable identity of the configured channel/Bot instance. */
  channelInstanceId: string;
  /** Stable identity of the logical actor represented by the bot. */
  actorId: string;
}

export interface VerboseOptions {
  showThinking: boolean;
  showToolUse: boolean;
}

export interface RunChannelPluginSpec<
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
> {
  /** Plugin name reported during ACP initialize (e.g. "vibearound-slack"). */
  name: string;

  /** Plugin version reported during ACP initialize. */
  version: string;

  /**
   * Config keys that MUST be present. Plugin fails fast if any are missing.
   */
  requiredConfig?: string[];

  /** Factory: build the platform bot. */
  createBot: (ctx: CreateBotContext) => TBot | Promise<TBot>;

  /**
   * Factory: build the renderer (extends BlockRenderer).
   * Only implements platform-specific sendText/sendBlock/editBlock.
   */
  createRenderer: (
    bot: TBot,
    log: ChannelPluginLogger,
    verbose: VerboseOptions,
  ) => TRenderer;

  /**
   * Optional hook invoked after bot constructed but before start().
   */
  afterCreate?: (bot: TBot, log: ChannelPluginLogger) => Promise<void> | void;

  /**
   * Optional platform connectivity probe. Called right before each 30-second
   * heartbeat tick. Return `true` if the plugin can reach its IM platform
   * API (for example: Slack `auth.test`, Telegram `getMe`, Feishu access
   * token validity). Return `false` or reject → the SDK skips that
   * heartbeat → the host's 90-second watchdog flags the channel as stuck
   * and restarts it.
   *
   * Leave unset to send unconditional heartbeats. Unconditional heartbeats
   * only catch total plugin-process freeze (rare); `healthCheck` is what
   * catches "plugin alive but IM disconnected" (the common case).
   */
  healthCheck?: (bot: TBot) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run a channel plugin.
 *
 * Handles the full ACP lifecycle: connect to host, validate config,
 * construct bot + renderer, start the bot, then wait for the host
 * to disconnect before stopping and exiting.
 */
export async function runChannelPlugin<
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
>(spec: RunChannelPluginSpec<TBot, TRenderer>): Promise<void> {
  const prefix = `[${spec.name.replace(/^vibearound-/, "")}-plugin]`;
  const log: ChannelPluginLogger = (level, msg) => {
    process.stderr.write(`${prefix}[${level}] ${msg}\n`);
  };

  try {
    await runInner(spec, log);
  } catch (err) {
    log("error", `fatal: ${extractErrorMessage(err)}`);
    process.exit(1);
  }
}

async function runInner<
  TBot extends ChannelBot<TRenderer>,
  TRenderer extends BlockRenderer<any>,
>(
  spec: RunChannelPluginSpec<TBot, TRenderer>,
  log: ChannelPluginLogger,
): Promise<void> {
  log("info", "initializing ACP connection...");

  let renderer: TRenderer | null = null;
  let promptCompletion: PromptCompletionController | undefined;

  const { agent, meta, agentInfo, conn } = await connectToHost(
    { name: spec.name, version: spec.version },
    () => ({
      async sessionUpdate(params: SessionNotification): Promise<void> {
        log(
          "warn",
          `legacy sessionUpdate without channel target ignored session=${params.sessionId}`,
        );
      },

      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        log(
          "warn",
          `legacy requestPermission without chat target ignored session=${params.sessionId}`,
        );
        return { outcome: { outcome: "cancelled" } };
      },

      async extMethod(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Record<string, unknown>> {
        switch (stripExtPrefix(method)) {
          case "va/request_permission": {
            const target = parseChannelTarget(params.target);
            const request = params.request;
            if (!target || !renderer || !isRequestPermissionRequest(request)) {
              log("warn", "invalid va/request_permission request");
              return cancelledPermissionResponse();
            }
            const toolTitle =
              (request.toolCall as { title?: string } | undefined)?.title ?? "?";
            const optCount = request.options?.length ?? 0;
            log(
              "info",
              `requestPermission called target=${channelTargetLabel(target)} session=${request.sessionId} tool="${toolTitle}" options=${optCount}`,
            );
            if (!request.options || request.options.length === 0) {
              return cancelledPermissionResponse();
            }
            try {
              const optionId = await renderer.requestPermission(target, request);
              log("info", `requestPermission resolved optionId=${optionId}`);
              return { outcome: { outcome: "selected", optionId } };
            } catch (err) {
              log("error", `requestPermission failed: ${extractErrorMessage(err)}`);
              return cancelledPermissionResponse();
            }
          }
          default:
            log("warn", `unhandled ext_method: ${method}`);
            return {};
        }
      },

      async extNotification(
        method: string,
        params: Record<string, unknown>,
      ): Promise<void> {
        const target = parseChannelTarget(params.target);
        switch (stripExtPrefix(method)) {
          case "va/system_text": {
            const text = typeof params.text === "string" ? params.text : "";
            if (target && renderer) {
              renderer.onSystemText(target, text);
            } else {
              log("warn", "invalid va/system_text notification");
            }
            break;
          }
          case "va/agent_ready": {
            const agentName = typeof params.agent === "string" ? params.agent : "unknown";
            const version = typeof params.version === "string" ? params.version : "";
            log("info", `agent_ready: ${agentName} v${version}`);
            break;
          }
          case "va/session_ready": {
            const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
            log("info", `session_ready: ${sessionId}`);
            break;
          }
          case "va/session_info": {
            const info = parseChannelSessionInfo(params.info);
            if (target && renderer && info) {
              renderer.onSessionInfo(target, info);
            } else {
              log("warn", "invalid va/session_info notification");
            }
            break;
          }
          case "va/thread_reply": {
            const reply = isRecord(params.reply) ? params.reply : undefined;
            const payload = reply && isRecord(reply.payload) ? reply.payload : undefined;
            const notification = payload?.notification;
            if (
              target &&
              renderer &&
              payload?.kind === "acp_session_notification" &&
              isSessionNotification(notification)
            ) {
              renderer.onSessionUpdate(target, notification);
            } else {
              log("warn", "invalid va/thread_reply notification");
            }
            break;
          }
          case "va/command_menu": {
            const systemCommands = Array.isArray(params.systemCommands) ? params.systemCommands : [];
            const agentCommands = Array.isArray(params.agentCommands) ? params.agentCommands : [];
            if (target && renderer) {
              renderer.onCommandMenu(target, systemCommands, agentCommands);
            } else {
              log("warn", "invalid va/command_menu notification");
            }
            break;
          }
          case "va/prompt_done": {
            if (target) {
              promptCompletion?.complete(target);
            } else {
              log("warn", "invalid va/prompt_done notification");
            }
            break;
          }
          default:
            log("warn", `unhandled ext_notification: ${method}`);
        }
      },
    }),
  );

  if (meta.promptDone) {
    promptCompletion = enablePromptCompletion(agent);
    void conn.closed.then(
      () => promptCompletion?.close(),
      () => promptCompletion?.close(),
    );
  }

  const config = meta.config;

  for (const key of spec.requiredConfig ?? []) {
    if (config[key] === undefined || config[key] === null || config[key] === "") {
      throw new Error(`${key} is required in config`);
    }
  }

  const cacheDir =
    meta.cacheDir ?? path.join(os.homedir(), ".vibearound", ".cache");
  const { channelInstanceId, actorId } = resolveChannelIdentity(meta, spec.name);

  log(
    "info",
    `initialized, host=${agentInfo.name ?? "unknown"} cacheDir=${cacheDir}`,
  );

  const bot = await spec.createBot({
    config,
    agent,
    log,
    cacheDir,
    channelInstanceId,
    actorId,
  });

  if (spec.afterCreate) {
    await spec.afterCreate(bot, log);
  }

  const verboseRaw = config.verbose as
    | { show_thinking?: boolean; show_tool_use?: boolean }
    | undefined;
  const verbose: VerboseOptions = {
    showThinking: verboseRaw?.show_thinking ?? false,
    showToolUse: verboseRaw?.show_tool_use ?? false,
  };

  renderer = spec.createRenderer(bot, log, verbose);
  bot.setStreamHandler(renderer);

  // Start heartbeat BEFORE awaiting bot.start(). Some platform SDKs expose
  // a blocking `start()` that only returns on shutdown (e.g. Feishu's WS
  // gateway). Starting heartbeat first means the watchdog cadence is in
  // place regardless of whether start() returns or runs forever.
  const heartbeatHandle = startHeartbeat(agent, bot, spec.healthCheck, log);

  // Kick bot.start() without requiring it to resolve: some platform SDKs
  // keep that promise pending for the connection lifetime. A rejected start
  // must still be fatal; logging and leaving the ACP process alive makes the
  // host report Running forever for a bot that never connected.
  const startResult = Promise.resolve().then(() => bot.start());
  log("info", "plugin start requested");

  await waitForDisconnectOrStartFailure(conn.closed, startResult);
  log("info", "connection closed, shutting down");
  clearInterval(heartbeatHandle);
  await bot.stop();
  process.exit(0);
}

/** @internal Exported for lifecycle contract tests. */
export async function waitForDisconnectOrStartFailure(
  disconnected: Promise<unknown>,
  startResult: Promise<void>,
): Promise<void> {
  await Promise.race([
    disconnected.then(() => undefined),
    startResult.then(
      () => new Promise<never>(() => {}),
      (error) => Promise.reject(error),
    ),
  ]);
}

/** @internal Exported for contract tests; not part of the package entry point. */
export function resolveChannelIdentity(
  meta: Pick<
    PluginInitMeta,
    "channelKind" | "channelInstanceId" | "actorId"
  >,
  pluginName: string,
): { channelInstanceId: string; actorId: string } {
  const channelInstanceId =
    meta.channelInstanceId ?? meta.channelKind ?? pluginName;
  return {
    channelInstanceId,
    actorId: meta.actorId ?? channelInstanceId,
  };
}

function parseChannelSessionInfo(value: unknown): ChannelSessionInfo | undefined {
  if (!isRecord(value)) return undefined;
  const agent = isRecord(value.agent) ? value.agent : undefined;
  if (!agent) return undefined;
  if (
    typeof value.workspaceId !== "string" ||
    typeof value.workspacePath !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.sessionId !== "string" ||
    (value.start !== "new" && value.start !== "resumed") ||
    typeof agent.id !== "string" ||
    typeof agent.name !== "string"
  ) {
    return undefined;
  }
  return {
    workspaceId: value.workspaceId,
    workspacePath: value.workspacePath,
    threadId: value.threadId,
    sessionId: value.sessionId,
    start: value.start,
    agent: {
      id: agent.id,
      name: agent.name,
      version: typeof agent.version === "string" ? agent.version : undefined,
      profileId: typeof agent.profileId === "string" ? agent.profileId : undefined,
    },
  };
}

/** Heartbeat cadence. Paired with the host's 90s watchdog — a single missed
 *  heartbeat is tolerated, two in a row trigger restart. */
const HEARTBEAT_INTERVAL_MS = 30_000;

function startHeartbeat<TBot>(
  agent: Agent,
  bot: TBot,
  healthCheck: ((bot: TBot) => Promise<boolean>) | undefined,
  log: ChannelPluginLogger,
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      if (healthCheck) {
        let ok = false;
        try {
          ok = await healthCheck(bot);
        } catch (err) {
          log("warn", `healthCheck threw: ${extractErrorMessage(err)}`);
          ok = false;
        }
        if (!ok) {
          log("warn", "healthCheck=false, skipping heartbeat (host will restart if sustained)");
          return;
        }
      }
      await agent.extNotification?.("_va/heartbeat", { ts: Date.now() });
    } catch (err) {
      log("warn", `heartbeat send failed: ${extractErrorMessage(err)}`);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function isSessionNotification(value: unknown): value is SessionNotification {
  if (!value || typeof value !== "object") return false;
  const record = value as { sessionId?: unknown; update?: unknown };
  return (
    typeof record.sessionId === "string" &&
    !!record.update &&
    typeof record.update === "object"
  );
}

function isRequestPermissionRequest(value: unknown): value is RequestPermissionRequest {
  if (!value || typeof value !== "object") return false;
  const record = value as {
    sessionId?: unknown;
    toolCall?: unknown;
    options?: unknown;
  };
  return (
    typeof record.sessionId === "string" &&
    !!record.toolCall &&
    typeof record.toolCall === "object" &&
    Array.isArray(record.options)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** @internal Exported for wire-contract tests; not part of the package entry point. */
export function parseChannelTarget(value: unknown): ChannelTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.channelInstanceId) ||
    !isNonEmptyString(value.actorId) ||
    !isNonEmptyString(value.chatId)
  ) {
    return undefined;
  }
  if (
    (value.topicId !== undefined && !isNonEmptyString(value.topicId)) ||
    (value.replyTo !== undefined && !isNonEmptyString(value.replyTo))
  ) {
    return undefined;
  }
  return {
    channelInstanceId: value.channelInstanceId,
    actorId: value.actorId,
    chatId: value.chatId,
    topicId: value.topicId,
    replyTo: value.replyTo,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function channelTargetLabel(target: ChannelTarget): string {
  return `${target.channelInstanceId}/${target.actorId}/${target.chatId}`;
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}
