import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import {
  Client as TemporalClient,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import type { AgentConfig } from "./config.js";
import { workflowIdForChannel } from "./config.js";
import { compareDiscordSnowflakes } from "./discord-utils.js";
import { storeMessageAttachments } from "./attachments.js";
import type {
  ChannelWorkflowInput,
  ChannelWorkflowState,
  DiscordChannelMessage,
} from "./types.js";
import {
  channelSessionWorkflow,
  channelStateQuery,
  discordMessageSignal,
} from "./workflows/channel-session.js";

function requireGuildTextChannel(channel: unknown): GuildTextBasedChannel {
  if (
    !channel ||
    typeof channel !== "object" ||
    !("isTextBased" in channel) ||
    typeof channel.isTextBased !== "function" ||
    !channel.isTextBased() ||
    !("isDMBased" in channel) ||
    typeof channel.isDMBased !== "function" ||
    channel.isDMBased()
  ) {
    throw new Error("Configured Discord channel is not a guild text channel");
  }
  return channel as GuildTextBasedChannel;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
}

interface DiscordMessageIdentity {
  author: { bot: boolean; id: string };
  guildId: string | null;
  channelId: string;
}

export function isAllowedDiscordMessage(
  message: DiscordMessageIdentity,
  config: Pick<AgentConfig, "discord">,
): boolean {
  return (
    !message.author.bot &&
    message.guildId === config.discord.guildId &&
    message.channelId === config.discord.channelId &&
    message.author.id === config.discord.allowedUserId
  );
}

export class DiscordGateway {
  constructor(
    private readonly discord: Client,
    private readonly temporal: TemporalClient,
    private readonly config: AgentConfig,
  ) {}

  private workflowInput(
    initialLastSeenMessageId: string | null,
  ): ChannelWorkflowInput {
    return {
      guildId: this.config.discord.guildId,
      channelId: this.config.discord.channelId,
      initialLastSeenMessageId,
      codexThreadId: null,
      rollingSummary: "",
      recentMessages: [],
      processedTurns: 0,
      debounceMs: this.config.debounceMs,
    };
  }

  private isAllowedMessage(message: Message): boolean {
    return isAllowedDiscordMessage(message, this.config);
  }

  private async serializeMessage(
    message: Message,
  ): Promise<DiscordChannelMessage> {
    return {
      id: message.id,
      guildId: message.guildId!,
      channelId: message.channelId,
      authorId: message.author.id,
      authorName:
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
      mentionedBot: this.discord.user
        ? message.mentions.users.has(this.discord.user.id)
        : false,
      replyToMessageId: message.reference?.messageId ?? null,
      attachments: await storeMessageAttachments(message, this.config),
    };
  }

  private async signal(message: Message): Promise<void> {
    if (!this.isAllowedMessage(message)) return;
    const serialized = await this.serializeMessage(message);
    await this.temporal.workflow.signalWithStart(channelSessionWorkflow, {
      workflowId: workflowIdForChannel(this.config.discord.channelId),
      taskQueue: this.config.temporal.taskQueue,
      args: [this.workflowInput(message.id)],
      signal: discordMessageSignal,
      signalArgs: [serialized],
    });
  }

  private async ensureWorkflow(
    initialLastSeenMessageId: string | null,
  ): Promise<void> {
    try {
      await this.temporal.workflow.start(channelSessionWorkflow, {
        workflowId: workflowIdForChannel(this.config.discord.channelId),
        taskQueue: this.config.temporal.taskQueue,
        args: [this.workflowInput(initialLastSeenMessageId)],
      });
      console.info(
        `Started Temporal channel workflow at Discord checkpoint ${initialLastSeenMessageId ?? "empty"}`,
      );
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }

  private async backfill(channel: GuildTextBasedChannel): Promise<void> {
    const workflowId = workflowIdForChannel(this.config.discord.channelId);
    const handle =
      this.temporal.workflow.getHandle<typeof channelSessionWorkflow>(workflowId);
    const state = await handle.query(channelStateQuery);
    if (!state.lastSeenMessageId) {
      const fetched = await channel.messages.fetch({
        limit: this.config.discord.backfillLimit,
      });
      const ordered = [...fetched.values()].sort((left, right) =>
        compareDiscordSnowflakes(left.id, right.id),
      );
      for (const message of ordered) await this.signal(message);
      return;
    }

    let after = state.lastSeenMessageId;
    for (;;) {
      const fetched = await channel.messages.fetch({
        after,
        limit: this.config.discord.backfillLimit,
      });
      if (fetched.size === 0) break;

      const ordered = [...fetched.values()].sort((left, right) =>
        compareDiscordSnowflakes(left.id, right.id),
      );
      for (const message of ordered) {
        await this.signal(message);
      }
      after = ordered.at(-1)!.id;
      if (fetched.size < this.config.discord.backfillLimit) break;
    }
  }

  private async onReady(): Promise<void> {
    const channel = requireGuildTextChannel(
      await this.discord.channels.fetch(this.config.discord.channelId),
    );
    const latest = await channel.messages.fetch({ limit: 1 });
    const latestMessageId = latest.first()?.id ?? null;
    await this.ensureWorkflow(latestMessageId);
    await this.backfill(channel);
    console.info(
      `Discord agent ready as ${this.discord.user?.tag ?? "unknown bot"}; accepting only user ${this.config.discord.allowedUserId} in channel ${this.config.discord.channelId}`,
    );
  }

  async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.discord.once(Events.ClientReady, () => {
        void this.onReady().then(resolve, reject);
      });
    });
    this.discord.on(Events.MessageCreate, (message) => {
      void this.signal(message).catch((error: unknown) => {
        console.error("Failed to ingest Discord message", error);
      });
    });
    await this.discord.login(this.config.discord.botToken);
    await ready;
  }
}
