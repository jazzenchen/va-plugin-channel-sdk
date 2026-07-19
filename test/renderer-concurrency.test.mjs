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

class FailingTextRenderer extends BlockRenderer {
  async sendText() {
    throw new Error("system text delivery failed");
  }

  async sendBlock() {
    return null;
  }
}

class ScriptedDeliveryRenderer extends BlockRenderer {
  attempts = [];
  completed = [];

  constructor(outcomesByTarget, options = {}) {
    super({
      streaming: false,
      flushIntervalMs: 0,
      minEditIntervalMs: 0,
      ...options,
    });
    this.outcomesByTarget = outcomesByTarget;
  }

  async sendText() {}

  async sendBlock(channelTarget, kind, content) {
    return this.deliver(channelTarget, kind, content);
  }

  async editBlock(channelTarget, _ref, kind, content) {
    await this.deliver(channelTarget, kind, content);
  }

  async onAfterTurnEnd(channelTarget) {
    this.completed.push(channelTargetKey(channelTarget));
  }

  deliver(channelTarget, kind, content) {
    const key = channelTargetKey(channelTarget);
    this.attempts.push({ key, kind, content });
    const outcome = this.outcomesByTarget.get(key)?.shift();
    if (outcome instanceof Error) throw outcome;
    return `${key}-${this.attempts.length}`;
  }
}

class PendingPermissionRenderer extends BlockRenderer {
  async sendText() {}
  async sendBlock() { return null; }
  async onRequestPermission() {}
}

class FailingPermissionRenderer extends PendingPermissionRenderer {
  async onRequestPermission() {
    throw new Error("permission render failed");
  }
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

test("turn completion waits for queued system notification delivery", async () => {
  const renderer = new DelayedTextRenderer();
  const channelTarget = target();

  renderer.onPromptSent(channelTarget);
  renderer.onSystemText(channelTarget, "first");

  await renderer.onTurnEnd(channelTarget);

  assert.deepEqual(renderer.sent, [
    `${channelTargetKey(channelTarget)}:first`,
  ]);
});

test("turn completion exposes queued system notification failures", async () => {
  const renderer = new FailingTextRenderer();
  const channelTarget = target();

  renderer.onPromptSent(channelTarget);
  renderer.onSystemText(channelTarget, "notice");

  await assert.rejects(renderer.onTurnEnd(channelTarget), /system text delivery failed/);
});

test("final block delivery failure rejects the turn and skips after-turn hooks", async () => {
  const channelTarget = target();
  const key = channelTargetKey(channelTarget);
  const renderer = new ScriptedDeliveryRenderer(new Map([
    [key, [new Error("final delivery failed"), "next turn succeeds"]],
  ]));

  renderer.onPromptSent(channelTarget);
  renderer.onSessionUpdate(channelTarget, textChunk("session-1", "first", "message-1"));

  await assert.rejects(renderer.onTurnEnd(channelTarget), /final delivery failed/);
  assert.deepEqual(renderer.completed, []);

  renderer.onPromptSent(channelTarget);
  renderer.onSessionUpdate(channelTarget, textChunk("session-2", "second", "message-2"));
  await renderer.onTurnEnd(channelTarget);
  assert.deepEqual(renderer.completed, [key]);
});

test("a later successful flush recovers an intermediate streaming failure", async () => {
  const channelTarget = target();
  const key = channelTargetKey(channelTarget);
  const renderer = new ScriptedDeliveryRenderer(
    new Map([[key, [new Error("intermediate delivery failed"), "final succeeds"]]]),
    { streaming: true },
  );

  renderer.onPromptSent(channelTarget);
  renderer.onSessionUpdate(channelTarget, textChunk("session-1", "partial", "message-1"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(renderer.attempts.length, 1);

  renderer.onSessionUpdate(channelTarget, textChunk("session-1", " response", "message-1"));
  await renderer.onTurnEnd(channelTarget);

  assert.equal(renderer.attempts.length, 2);
  assert.equal(renderer.attempts[1].content, "partial response");
  assert.deepEqual(renderer.completed, [key]);
});

test("a failed sealed block is not masked by a later successful block", async () => {
  const channelTarget = target();
  const key = channelTargetKey(channelTarget);
  const renderer = new ScriptedDeliveryRenderer(new Map([
    [key, [new Error("first sealed block failed"), "second block succeeds"]],
  ]));

  renderer.onPromptSent(channelTarget);
  renderer.onSessionUpdate(channelTarget, textChunk("session-1", "first", "message-1"));
  renderer.onSessionUpdate(channelTarget, textChunk("session-1", "second", "message-2"));

  await assert.rejects(renderer.onTurnEnd(channelTarget), /first sealed block failed/);
  assert.equal(renderer.attempts.length, 2);
  assert.deepEqual(renderer.completed, []);
});

test("delivery failures remain isolated to their target", async () => {
  const failingTarget = target({ replyTo: "message-failing" });
  const healthyTarget = target({ replyTo: "message-healthy" });
  const failingKey = channelTargetKey(failingTarget);
  const healthyKey = channelTargetKey(healthyTarget);
  const renderer = new ScriptedDeliveryRenderer(new Map([
    [failingKey, [new Error("target delivery failed")]],
    [healthyKey, ["target delivery succeeds"]],
  ]));

  renderer.onPromptSent(failingTarget);
  renderer.onPromptSent(healthyTarget);
  renderer.onSessionUpdate(failingTarget, textChunk("session-failing", "bad", "message-1"));
  renderer.onSessionUpdate(healthyTarget, textChunk("session-healthy", "good", "message-1"));

  const [failed, succeeded] = await Promise.allSettled([
    renderer.onTurnEnd(failingTarget),
    renderer.onTurnEnd(healthyTarget),
  ]);

  assert.equal(failed.status, "rejected");
  assert.match(String(failed.reason), /target delivery failed/);
  assert.equal(succeeded.status, "fulfilled");
  assert.deepEqual(renderer.completed, [healthyKey]);
});

test("equal long content with different message ids remains distinct", async () => {
  const renderer = new RecordingRenderer();
  const channelTarget = target();
  const repeated = "same content must remain visible across messages";

  renderer.onPromptSent(channelTarget);
  renderer.onSessionUpdate(channelTarget, textChunk("session", repeated, "message-1"));
  renderer.onSessionUpdate(channelTarget, textChunk("session", repeated, "message-2"));
  await renderer.onTurnEnd(channelTarget);

  assert.deepEqual(
    renderer.sent.map(({ content }) => content),
    [repeated, repeated],
  );
});

test("repeated deltas remain content with or without a message id", async () => {
  const renderer = new RecordingRenderer();
  const withoutId = target({ replyTo: "without-id" });
  const sameId = target({ replyTo: "same-id" });
  const repeated = "the same long delta is still legitimate content";

  renderer.onPromptSent(withoutId);
  renderer.onSessionUpdate(withoutId, textChunk("session", repeated, undefined));
  renderer.onSessionUpdate(withoutId, textChunk("session", repeated, undefined));
  await renderer.onTurnEnd(withoutId);

  renderer.onPromptSent(sameId);
  renderer.onSessionUpdate(sameId, textChunk("session", repeated, "message-1"));
  renderer.onSessionUpdate(sameId, textChunk("session", repeated, "message-1"));
  await renderer.onTurnEnd(sameId);

  assert.deepEqual(
    renderer.sent.map(({ content }) => content),
    [repeated + repeated, repeated + repeated],
  );
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

test("permission render failure only falls back to reject_once", async () => {
  const renderer = new FailingPermissionRenderer();
  const rejectOnceRequest = {
    sessionId: "session-a",
    toolCall: { toolCallId: "tool-a", title: "dangerous tool" },
    options: [
      { kind: "allow_once", optionId: "allow", name: "Allow" },
      { kind: "reject_once", optionId: "reject-once", name: "Reject" },
    ],
  };
  const rejectAlwaysRequest = {
    ...rejectOnceRequest,
    options: [
      { kind: "reject_always", optionId: "reject-always", name: "Always reject" },
    ],
  };

  assert.equal(
    await renderer.requestPermission(target(), rejectOnceRequest),
    "reject-once",
  );
  await assert.rejects(
    renderer.requestPermission(target(), rejectAlwaysRequest),
    /permission render failed/,
  );
});

test("implicit and turn-end permission cancellation never select an allow option", async () => {
  const renderer = new PendingPermissionRenderer();
  const implicitTarget = target({ replyTo: "implicit-cancel" });
  const turnEndTarget = target({ replyTo: "turn-end-cancel" });
  const request = {
    sessionId: "session-a",
    toolCall: { toolCallId: "tool-a", title: "dangerous tool" },
    options: [
      { kind: "reject_always", optionId: "reject-always", name: "Always reject" },
    ],
  };

  const implicitPermission = renderer.requestPermission(implicitTarget, request);
  const implicitCancelled = assert.rejects(
    implicitPermission,
    /permission request cancelled/,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(renderer.consumePendingText(implicitTarget, "new prompt"), false);
  await implicitCancelled;

  const turnEndPermission = renderer.requestPermission(turnEndTarget, request);
  const turnEndCancelled = assert.rejects(
    turnEndPermission,
    /permission request cancelled because the turn ended/,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  await renderer.onTurnEnd(turnEndTarget);
  await turnEndCancelled;
});

test("target parser requires a complete route and preserves reply metadata", () => {
  const complete = target();
  assert.deepEqual(parseChannelTarget(complete), complete);
  assert.equal(parseChannelTarget({ chatId: complete.chatId }), undefined);
  assert.equal(parseChannelTarget({ ...complete, actorId: "" }), undefined);
  assert.equal(parseChannelTarget({ ...complete, replyTo: "" }), undefined);
});
