/**
 * Helpers for sending platform-neutral inbound channel prompts over ACP.
 */

import type {
  Agent,
  ContentBlock,
  PromptResponse,
} from "@agentclientprotocol/sdk";
import type { ChannelInboundContext } from "./types.js";

export interface SendChannelPromptInput {
  context: ChannelInboundContext;
  prompt: ContentBlock[];
}

export interface CancelChannelPromptInput {
  context: ChannelInboundContext;
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

  return agent.prompt({
    sessionId: input.context.chatId,
    prompt: input.prompt,
    _meta: {
      "va.channel": input.context,
    },
  });
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
