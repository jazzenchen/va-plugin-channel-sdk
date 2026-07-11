import test from "node:test";
import assert from "node:assert/strict";

import {
  cancelChannelPrompt,
  channelTargetFromInboundContext,
  isChannelStopCommand,
  isChannelPromptAllowed,
  sendChannelPrompt,
} from "../dist/index.js";
import { parsePluginInitMeta } from "../dist/connection.js";
import {
  resolveChannelIdentity,
  waitForDisconnectOrStartFailure,
} from "../dist/plugin.js";

const baseContext = {
  channelInstanceId: "feishu-primary",
  actorId: "codex-reviewer",
  chatId: "chat-123",
  scope: "group",
  addressedBy: "mention",
};

test("direct messages are allowed without explicit addressing", () => {
  assert.equal(
    isChannelPromptAllowed({
      ...baseContext,
      scope: "dm",
      addressedBy: "unaddressed",
    }),
    true,
  );
});

test("group messages require a mention or callback", () => {
  assert.equal(
    isChannelPromptAllowed({ ...baseContext, addressedBy: "mention" }),
    true,
  );
  assert.equal(
    isChannelPromptAllowed({ ...baseContext, addressedBy: "command" }),
    false,
  );
  assert.equal(
    isChannelPromptAllowed({ ...baseContext, addressedBy: "callback" }),
    true,
  );
  assert.equal(
    isChannelPromptAllowed({ ...baseContext, addressedBy: "unaddressed" }),
    false,
  );
  assert.equal(
    isChannelPromptAllowed({ ...baseContext, addressedBy: "dm" }),
    false,
  );
});

test("sendChannelPrompt carries the route in ACP metadata", async () => {
  const calls = [];
  const response = { stopReason: "end_turn" };
  const agent = {
    async prompt(request) {
      calls.push(request);
      return response;
    },
  };
  const prompt = [{ type: "text", text: "hello" }];

  const result = await sendChannelPrompt(agent, {
    context: baseContext,
    prompt,
  });

  assert.equal(result, response);
  assert.deepEqual(calls, [
    {
      sessionId: "chat-123",
      prompt,
      _meta: { "va.channel": baseContext },
    },
  ]);
});

test("inbound platform message identity becomes the output reply target", () => {
  assert.deepEqual(
    channelTargetFromInboundContext({
      ...baseContext,
      topicId: "thread-1",
      platformMessageId: "message-1",
    }),
    {
      channelInstanceId: "feishu-primary",
      actorId: "codex-reviewer",
      chatId: "chat-123",
      topicId: "thread-1",
      replyTo: "message-1",
    },
  );
});

test("sendChannelPrompt ignores unaddressed group messages", async () => {
  let called = false;
  const agent = {
    async prompt() {
      called = true;
      return { stopReason: "end_turn" };
    },
  };

  const result = await sendChannelPrompt(agent, {
    context: { ...baseContext, addressedBy: "unaddressed" },
    prompt: [{ type: "text", text: "background chatter" }],
  });

  assert.equal(result, null);
  assert.equal(called, false);
});

test("channel stop aliases cancel only the metadata route", async () => {
  const calls = [];
  const agent = {
    cancel: async (params) => calls.push(params),
  };
  const context = {
    channelInstanceId: "slack-primary",
    actorId: "codex-reviewer",
    chatId: "group-1",
    topicId: "thread-1",
    senderId: "user-1",
    scope: "group",
    addressedBy: "mention",
  };

  assert.equal(isChannelStopCommand("va stop"), true);
  assert.equal(isChannelStopCommand("/cancel"), true);
  assert.equal(isChannelStopCommand("please stop"), false);
  assert.equal(await cancelChannelPrompt(agent, { context }), true);
  assert.deepEqual(calls, [{
    sessionId: "group-1",
    _meta: { "va.channel": context },
  }]);
});

test("initialize metadata exposes channel routing identities", () => {
  assert.deepEqual(
    parsePluginInitMeta({
      config: { token: "secret" },
      cacheDir: "/tmp/channel-cache",
      channelKind: "feishu",
      channelInstanceId: "feishu-primary",
      actorId: "codex-reviewer",
    }),
    {
      config: { token: "secret" },
      cacheDir: "/tmp/channel-cache",
      channelKind: "feishu",
      channelInstanceId: "feishu-primary",
      actorId: "codex-reviewer",
    },
  );
});

test("channel identity uses stable compatibility fallbacks", () => {
  assert.deepEqual(
    resolveChannelIdentity(
      {
        channelKind: "feishu",
        channelInstanceId: "feishu-primary",
        actorId: "codex-reviewer",
      },
      "vibearound-feishu",
    ),
    {
      channelInstanceId: "feishu-primary",
      actorId: "codex-reviewer",
    },
  );
  assert.deepEqual(
    resolveChannelIdentity({ channelKind: "feishu" }, "vibearound-feishu"),
    { channelInstanceId: "feishu", actorId: "feishu" },
  );
  assert.deepEqual(
    resolveChannelIdentity({}, "vibearound-feishu"),
    {
      channelInstanceId: "vibearound-feishu",
      actorId: "vibearound-feishu",
    },
  );
});

test("plugin start failures stay fatal even when the host remains connected", async () => {
  const disconnected = new Promise(() => {});

  await assert.rejects(
    waitForDisconnectOrStartFailure(
      disconnected,
      Promise.reject(new Error("platform login failed")),
    ),
    /platform login failed/,
  );
});

test("a resolved platform start keeps waiting for host disconnect", async () => {
  let disconnect;
  const disconnected = new Promise((resolve) => {
    disconnect = resolve;
  });
  let settled = false;
  const lifecycle = waitForDisconnectOrStartFailure(
    disconnected,
    Promise.resolve(),
  ).then(() => {
    settled = true;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  disconnect();
  await lifecycle;
  assert.equal(settled, true);
});
