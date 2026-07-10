# @vibearound/plugin-channel-sdk

SDK for building [VibeAround](https://github.com/jazzenchen/VibeAround) channel plugins.

Channel plugins bridge IM platforms (Feishu, Telegram, Slack, Discord, etc.) to the VibeAround agent runtime via [ACP](https://agentclientprotocol.com). This SDK handles the ACP lifecycle so you only implement platform-specific message transport.

## Install

```bash
npm install @vibearound/plugin-channel-sdk
```

## Quick start

```ts
import { runChannelPlugin, BlockRenderer, type BlockKind, type VerboseConfig } from "@vibearound/plugin-channel-sdk";

// 1. Implement a renderer for your platform
class MyRenderer extends BlockRenderer<string> {
  constructor(private bot: MyBot, log: Function, verbose?: Partial<VerboseConfig>) {
    super({ streaming: true, flushIntervalMs: 500, minEditIntervalMs: 1000, verbose });
  }

  protected async sendText(chatId: string, text: string) {
    await this.bot.send(chatId, text);
  }

  protected async sendBlock(chatId: string, kind: BlockKind, content: string) {
    const msg = await this.bot.send(chatId, content);
    return msg.id;
  }

  protected async editBlock(chatId: string, ref: string, kind: BlockKind, content: string, sealed: boolean) {
    await this.bot.edit(chatId, ref, content);
  }
}

// 2. Run the plugin
runChannelPlugin({
  name: "vibearound-myplatform",
  version: "0.1.0",
  requiredConfig: ["bot_token"],
  createBot: ({
    config,
    agent,
    log,
    cacheDir,
    channelInstanceId,
    actorId,
  }) => new MyBot(
    config.bot_token as string,
    agent,
    log,
    cacheDir,
    channelInstanceId,
    actorId,
  ),
  createRenderer: (bot, log, verbose) =>
    new MyRenderer(bot, log, verbose),
});
```

That's it. The SDK handles ACP connection, config validation, event routing, and shutdown.

`createBot` always receives stable `channelInstanceId` and `actorId` values.
Older hosts remain compatible: the SDK falls back from `channelInstanceId` to
`channelKind`, then to the plugin name; `actorId` falls back to the resolved
channel instance ID.

## Inbound channel prompts

Use `sendChannelPrompt` to attach platform-neutral routing metadata and apply
the default addressing policy before sending a prompt to the host:

```ts
import { sendChannelPrompt } from "@vibearound/plugin-channel-sdk";

await sendChannelPrompt(agent, {
  context: {
    channelInstanceId: "feishu-primary",
    actorId: "codex-reviewer",
    chatId,
    scope: isDirectMessage ? "dm" : "group",
    addressedBy: isDirectMessage ? "dm" : "mention",
  },
  prompt: [{ type: "text", text }],
});
```

Direct messages are accepted without an explicit mention. Group messages are
accepted only when addressed by mention, command, or callback; otherwise the
helper returns `null` without calling ACP. Plugins remain responsible for
translating their platform's DM, mention, command, and callback semantics into
`ChannelInboundContext`.

## BlockRenderer

Abstract base class that renders agent responses to your IM platform.

### Required methods

| Method | Description |
|---|---|
| `sendText(chatId, text)` | Send a plain text message (system notifications, errors) |
| `sendBlock(chatId, kind, content)` | Send a new streaming block, return a platform ref for editing |

### Optional methods

| Method | Default | Description |
|---|---|---|
| `editBlock(chatId, ref, kind, content, sealed)` | — | Edit a message in-place (omit for send-only platforms) |
| `formatContent(kind, content, sealed)` | Emoji prefixes | Format block content before send/edit |
| `onAfterTurnEnd(chatId)` | No-op | Cleanup after turn completes |
| `onAfterTurnError(chatId, error)` | `sendText(chatId, "❌ ...")` | Custom error rendering |
| `onCommandMenu(chatId, systemCmds, agentCmds)` | Plain text list | Custom command menu rendering |

### Constructor options

| Option | Default | Description |
|---|---|---|
| `streaming` | `true` | `true`: send + edit in real-time. `false`: hold each block until complete, then send once |
| `flushIntervalMs` | `500` | Debounce interval before flushing |
| `minEditIntervalMs` | `1000` | Minimum gap between edits (rate limit protection) |
| `verbose.showThinking` | `false` | Show agent thinking blocks |
| `verbose.showToolUse` | `false` | Show tool call blocks |

## ChannelBot interface

Your bot class should implement:

```ts
interface ChannelBot {
  setStreamHandler(handler: BlockRenderer): void;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
```

## Advanced usage

For plugins that need custom ACP lifecycle control:

```ts
import { connectToHost, stripExtPrefix } from "@vibearound/plugin-channel-sdk/advanced";
```

## License

MIT
