import test from "node:test";
import assert from "node:assert/strict";

import { BlockRenderer, channelTargetKey } from "../dist/index.js";
import { parseChannelTarget } from "../dist/plugin.js";

function target(overrides = {}) {
  return {
    channelInstanceId: "slack-work",
    actorId: "bot-primary",
    chatId: "chat-shared",
    topicId: "thread-main",
    replyTo: "message-main",
    ...overrides,
  };
}

class RecordingRenderer extends BlockRenderer {
  sent = [];

  constructor() {
    super({ streaming: false });
  }

  async sendText(channelTarget, text) {
    this.sent.push({ target: channelTarget, kind: "system", content: text });
  }

  async sendBlock(channelTarget, kind, content) {
    this.sent.push({ target: channelTarget, kind, content });
    return `${channelTargetKey(channelTarget)}-${this.sent.length}`;
  }
}

class DelayedTextRenderer extends BlockRenderer {
  sent = [];

  async sendText(channelTarget, text) {
    if (text === "first") {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    this.sent.push(`${channelTargetKey(channelTarget)}:${text}`);
  }

  async sendBlock() {
    return null;
  }
}

class PendingPermissionRenderer extends BlockRenderer {
  async sendText() {}
  async sendBlock() { return null; }
  async onRequestPermission() {}
}

function textChunk(sessionId, text, messageId) {
  return {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
      messageId,
    },
  };
}

test("same chat with different actor, topic, or replyTo keeps isolated render state", async () => {
  const renderer = new RecordingRenderer();
  const actorA = target({ actorId: "bot-a", replyTo: "message-a" });
  const actorB = target({ actorId: "bot-b", replyTo: "message-a" });
  const topicB = target({ topicId: "thread-b", replyTo: "message-a" });
  const replyB = target({ replyTo: "message-b" });
  const targets = [actorA, actorB, topicB, replyB];

  for (const channelTarget of targets) renderer.onPromptSent(channelTarget);
  targets.forEach((channelTarget, index) => {
    renderer.onSessionUpdate(
      channelTarget,
      textChunk(`session-${index}`, `${index}-first`, `message-${index}`),
    );
  });
  targets.forEach((channelTarget, index) => {
    renderer.onSessionUpdate(
      channelTarget,
      textChunk(`session-${index}`, "-second", `message-${index}`),
    );
  });

  await Promise.all(targets.map((channelTarget) => renderer.onTurnEnd(channelTarget)));

  assert.deepEqual(
    renderer.sent
      .map((entry) => ({
        key: channelTargetKey(entry.target),
        kind: entry.kind,
        content: entry.content,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    targets
      .map((channelTarget, index) => ({
        key: channelTargetKey(channelTarget),
        kind: "text",
        content: `${index}-first-second`,
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  );
});

test("system notifications are ordered per target and independent across targets", async () => {
  const renderer = new DelayedTextRenderer();
  const firstTarget = target({ replyTo: "message-a" });
  const secondTarget = target({ replyTo: "message-b" });

  renderer.onSystemText(firstTarget, "first");
  renderer.onSystemText(firstTarget, "second");
  renderer.onSystemText(secondTarget, "other");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(renderer.sent, [
    `${channelTargetKey(secondTarget)}:other`,
    `${channelTargetKey(firstTarget)}:first`,
    `${channelTargetKey(firstTarget)}:second`,
  ]);
});

test("pending permissions are isolated by route and accept a new reply message", async () => {
  const renderer = new PendingPermissionRenderer();
  const firstTarget = target({ actorId: "bot-a", replyTo: "message-a" });
  const secondTarget = target({ actorId: "bot-b", replyTo: "message-b" });
  const request = {
    sessionId: "session-a",
    toolCall: { toolCallId: "tool-a", title: "dangerous tool" },
    options: [
      { kind: "allow_once", optionId: "allow", name: "Allow" },
      { kind: "reject_once", optionId: "reject", name: "Reject" },
    ],
  };
  const firstPermission = renderer.requestPermission(firstTarget, request);
  const secondPermission = renderer.requestPermission(secondTarget, request);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    renderer.consumePendingText(
      { ...firstTarget, replyTo: "permission-answer-a" },
      "1",
    ),
    true,
  );
  assert.equal(renderer.consumePendingText(firstTarget, "2"), false);
  assert.equal(renderer.consumePendingText(secondTarget, "2"), true);

  assert.equal(await firstPermission, "allow");
  assert.equal(await secondPermission, "reject");
});

test("turn completion clears only its target permission", async () => {
  const renderer = new PendingPermissionRenderer();
  const firstTarget = target({ actorId: "bot-a", replyTo: "message-a" });
  const secondTarget = target({ actorId: "bot-b", replyTo: "message-b" });
  const request = {
    sessionId: "session-a",
    toolCall: { toolCallId: "tool-a", title: "dangerous tool" },
    options: [
      { kind: "allow_once", optionId: "allow", name: "Allow" },
      { kind: "reject_once", optionId: "reject", name: "Reject" },
    ],
  };
  const firstPermission = renderer.requestPermission(firstTarget, request);
  const secondPermission = renderer.requestPermission(secondTarget, request);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await renderer.onTurnEnd(firstTarget);

  assert.equal(await firstPermission, "reject");
  assert.equal(renderer.consumePendingText(firstTarget, "1"), false);
  assert.equal(renderer.consumePendingText(secondTarget, "1"), true);
  assert.equal(await secondPermission, "allow");
});

test("target parser requires a complete route and preserves reply metadata", () => {
  const complete = target();
  assert.deepEqual(parseChannelTarget(complete), complete);
  assert.equal(parseChannelTarget({ chatId: complete.chatId }), undefined);
  assert.equal(parseChannelTarget({ ...complete, actorId: "" }), undefined);
  assert.equal(parseChannelTarget({ ...complete, replyTo: "" }), undefined);
});
