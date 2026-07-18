/**
 * Helpers for sending platform-neutral inbound channel prompts over ACP.
 */

import type {
  Agent,
  ContentBlock,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import {
  channelTargetFromInboundContext,
  channelTargetKey,
  type ChannelInboundContext,
  type ChannelTarget,
} from "./types.js";

export interface SendChannelPromptInput {
  context: ChannelInboundContext;
  prompt: ContentBlock[];
}

export interface CancelChannelPromptInput {
  context: ChannelInboundContext;
}

/** @internal Host prompt-completion signal used by runChannelPlugin. */
export interface PromptCompletionController {
  complete(target: ChannelTarget): void;
  close(): void;
}

interface CompletionWaiter {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

interface PendingCompletion {
  promise: Promise<void>;
  cancel(): void;
}

type CompletionQueues = Map<string, CompletionWaiter[]>;

const completionQueues = new WeakMap<Agent, CompletionQueues>();

function waitForPromptCompletion(
  agent: Agent,
  target: ChannelTarget,
): PendingCompletion | undefined {
  const pending = completionQueues.get(agent);
  if (!pending) return undefined;

  const key = channelTargetKey(target);
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const waiter: CompletionWaiter = {
    promise: new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve: () => resolve(),
    reject: (error) => reject(error),
  };
  const queue = pending.get(key) ?? [];
  queue.push(waiter);
  pending.set(key, queue);

  return {
    promise: waiter.promise,
    cancel: () => {
      const current = pending.get(key);
      if (!current) return;
      const index = current.indexOf(waiter);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) pending.delete(key);
    },
  };
}

/** @internal Enable the host completion boundary for one ACP connection. */
export function enablePromptCompletion(
  agent: Agent,
): PromptCompletionController {
  const pending: CompletionQueues = new Map();
  completionQueues.set(agent, pending);
  return {
    complete: (target) => {
      const key = channelTargetKey(target);
      const queue = pending.get(key);
      if (!queue) return;
      const waiter = queue.shift();
      if (!waiter) return;
      if (queue.length === 0) pending.delete(key);
      waiter.resolve();
    },
    close: () => {
      if (completionQueues.get(agent) === pending) {
        completionQueues.delete(agent);
      }
      const error = new Error("host connection closed before prompt completion");
      for (const queue of pending.values()) {
        for (const waiter of queue) waiter.reject(error);
      }
      pending.clear();
    },
  };
}

/**
 * Apply the default channel addressing policy.
 *
 * Direct messages are always accepted. Group messages must explicitly address
 * the actor through a mention or callback.
 */
export function isChannelPromptAllowed(
  context: ChannelInboundContext,
): boolean {
  if (context.scope === "dm") return true;

  return (
    context.addressedBy === "mention" ||
    context.addressedBy === "callback"
  );
}

/**
 * Send an inbound channel prompt when it satisfies the default addressing
 * policy. Returns `null` when the message should be ignored.
 *
 * `chatId` remains the ACP session ID during the compatibility period. The
 * complete route is carried in the reserved ACP `_meta` object.
 */
export async function sendChannelPrompt(
  agent: Agent,
  input: SendChannelPromptInput,
): Promise<PromptResponse | null> {
  if (!isChannelPromptAllowed(input.context)) return null;

  const completion = waitForPromptCompletion(
    agent,
    channelTargetFromInboundContext(input.context),
  );
  try {
    const prompt = agent.prompt({
      sessionId: input.context.chatId,
      prompt: input.prompt,
      _meta: {
        "va.channel": input.context,
      },
    });
    if (!completion) return await prompt;
    const [response] = await Promise.all([prompt, completion.promise]);
    return response;
  } catch (error) {
    completion?.cancel();
    throw error;
  }
}

/** Recognize the channel-safe text aliases for interrupting an active turn. */
export function isChannelStopCommand(text: string): boolean {
  const normalized = text.trim().split(/\s+/).join(" ").toLowerCase();
  return [
    "/stop",
    "/cancel",
    "/va stop",
    "/vibearound stop",
    "va stop",
    "vibearound stop",
  ].includes(normalized);
}

/** Cancel only the route identified by the supplied channel context. */
export async function cancelChannelPrompt(
  agent: Agent,
  input: CancelChannelPromptInput,
): Promise<boolean> {
  if (!isChannelPromptAllowed(input.context)) return false;

  await agent.cancel({
    sessionId: input.context.chatId,
    _meta: {
      "va.channel": input.context,
    },
  });
  return true;
}
