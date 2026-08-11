import { heartbeat } from "@temporalio/activity";
import { Events, type Client, type GuildTextBasedChannel } from "discord.js";
import type { CodexRunner } from "./codex-runner.js";
import { splitDiscordMessage } from "./discord-utils.js";
import { AGENT_TURN_HEARTBEAT_INTERVAL_MS } from "./temporal-lifecycle.js";
import type {
  DeliverDiscordActionInput,
  ProcessChannelTurnInput,
} from "./types.js";

const DISCORD_READY_TIMEOUT_MS = 30_000;

async function waitForDiscordReady(discord: Client): Promise<void> {
  if (discord.isReady()) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      discord.off(Events.ClientReady, onReady);
      discord.off(Events.Error, onError);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Discord did not become ready within 30 seconds"));
    }, DISCORD_READY_TIMEOUT_MS);
    timeout.unref();

    discord.once(Events.ClientReady, onReady);
    discord.once(Events.Error, onError);
    // Close the gap between the first readiness check and listener setup.
    if (discord.isReady()) onReady();
  });
}

async function requireTextChannel(
  discord: Client,
  channelId: string,
): Promise<GuildTextBasedChannel> {
  await waitForDiscordReady(discord);
  const channel = await discord.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new Error(`Discord channel ${channelId} is not a guild text channel`);
  }
  return channel as GuildTextBasedChannel;
}

export function createActivities(discord: Client, codex: CodexRunner) {
  return {
    async processChannelTurn(input: ProcessChannelTurnInput) {
      // Heartbeat independently of model or tool progress. A long Codex turn is
      // healthy as long as this Worker remains alive; if the process disappears,
      // Temporal can detect it promptly instead of waiting for the full turn
      // timeout.
      heartbeat();
      const heartbeatTimer = setInterval(
        heartbeat,
        AGENT_TURN_HEARTBEAT_INTERVAL_MS,
      );
      heartbeatTimer.unref();

      let typingTimer: NodeJS.Timeout | undefined;
      try {
        const channel = await requireTextChannel(discord, input.channelId);
        await channel.sendTyping();
        typingTimer = setInterval(() => {
          void channel.sendTyping().catch(() => undefined);
        }, 8_000);
        typingTimer.unref();
        return await codex.run(input);
      } finally {
        clearInterval(heartbeatTimer);
        if (typingTimer) clearInterval(typingTimer);
      }
    },

    async deliverDiscordAction(input: DeliverDiscordActionInput): Promise<void> {
      const { action } = input;
      if (action.disposition === "silent") return;

      const channel = await requireTextChannel(discord, input.channelId);
      const targetMessageId =
        action.replyToMessageId || input.triggeringMessageId;
      const target = await channel.messages.fetch(targetMessageId);

      if (action.disposition === "react") {
        if (action.reaction) await target.react(action.reaction);
        return;
      }

      const chunks = splitDiscordMessage(action.message || "");
      for (const [index, content] of chunks.entries()) {
        const nonce = `${input.triggeringMessageId}-${index}`;
        if (index === 0) {
          await target.reply({
            content,
            allowedMentions: { parse: [], repliedUser: false },
            nonce,
            enforceNonce: true,
          });
        } else {
          await channel.send({
            content,
            allowedMentions: { parse: [] },
            nonce,
            enforceNonce: true,
          });
        }
      }
    },
  };
}

export type AgentActivities = ReturnType<typeof createActivities>;
