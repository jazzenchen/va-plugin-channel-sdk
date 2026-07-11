import test from "node:test";
import assert from "node:assert/strict";

import { BlockRenderer } from "../dist/index.js";

class RecordingRenderer extends BlockRenderer {
  sent = [];

  constructor() {
    super({ streaming: false });
  }

  async sendText(chatId, text) {
    this.sent.push({ chatId, kind: "system", content: text });
  }

  async sendBlock(chatId, kind, content) {
    this.sent.push({ chatId, kind, content });
    return `${chatId}-${this.sent.length}`;
  }
}

class DelayedTextRenderer extends BlockRenderer {
  sent = [];

  async sendText(chatId, text) {
    if (text === "first") {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    this.sent.push(`${chatId}:${text}`);
  }

  async sendBlock() {
    return null;
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

test("interleaved async replies keep independent route render state", async () => {
  const renderer = new RecordingRenderer();
  renderer.onPromptSent("chat-a");
  renderer.onPromptSent("chat-b");

  renderer.onSessionUpdate("chat-a", textChunk("session-a", "A1", "message-a"));
  renderer.onSessionUpdate("chat-b", textChunk("session-b", "B1", "message-b"));
  renderer.onSessionUpdate("chat-a", textChunk("session-a", "-A2", "message-a"));
  renderer.onSessionUpdate("chat-b", textChunk("session-b", "-B2", "message-b"));

  await Promise.all([
    renderer.onTurnEnd("chat-a"),
    renderer.onTurnEnd("chat-b"),
  ]);

  assert.deepEqual(
    renderer.sent.sort((left, right) => left.chatId.localeCompare(right.chatId)),
    [
      { chatId: "chat-a", kind: "text", content: "A1-A2" },
      { chatId: "chat-b", kind: "text", content: "B1-B2" },
    ],
  );
});

test("system notifications preserve platform delivery order per chat", async () => {
  const renderer = new DelayedTextRenderer();

  renderer.onSystemText("chat-a", "first");
  renderer.onSystemText("chat-a", "second");
  renderer.onSystemText("chat-b", "other");

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(renderer.sent, [
    "chat-b:other",
    "chat-a:first",
    "chat-a:second",
  ]);
});
