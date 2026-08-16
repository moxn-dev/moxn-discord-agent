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
import {
  registryWorkflowIdForChannel,
  workflowIdForChannel,
  workflowIdForThreadSession,
} from "./config.js";
import {
  compareDiscordSnowflakes,
  discordThreadName,
  parseSessionCommand,
  type SessionCommand,
} from "./discord-utils.js";
import { storeMessageAttachments } from "./attachments.js";
import type {
  ChannelRegistryInput,
  ChannelRegistryState,
  ChannelWorkflowInput,
  ChannelWorkflowState,
  DiscordChannelMessage,
  ForkContextSnapshot,
  SessionRegistryEntry,
} from "./types.js";
import {
  channelRegistryStateQuery,
  channelRegistryWorkflow,
  channelSessionWorkflow,
  channelStateQuery,
  discordMessageSignal,
  registryCheckpointSignal,
  registrySessionSignal,
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
  parentChannelId?: string | null;
}

export function isAllowedDiscordMessage(
  message: DiscordMessageIdentity,
  config: Pick<AgentConfig, "discord">,
  currentBotId?: string,
): boolean {
  const inConfiguredConversation =
    message.channelId === config.discord.channelId ||
    message.parentChannelId === config.discord.channelId;
  if (
    message.guildId !== config.discord.guildId ||
    !inConfiguredConversation
  ) {
    return false;
  }
  if (message.author.bot) {
    return (
      message.author.id !== currentBotId &&
      config.discord.allowedBotIds.includes(message.author.id)
    );
  }
  return (
    config.discord.allowAllUsers ||
    message.author.id === config.discord.allowedUserId
  );
}

function messageParentChannelId(message: Message): string | null {
  return message.channel.isThread() ? message.channel.parentId : null;
}

export function forkSnapshotFromState(
  state: ChannelWorkflowState,
  capturedAt: string,
): ForkContextSnapshot {
  return {
    sourceSessionId: state.sessionId,
    sourceRevision: state.contextRevision,
    capturedAt,
    rollingSummary: state.rollingSummary,
    recentMessages: state.recentMessages.slice(-20),
  };
}

export class DiscordGateway {
  private readonly sessionsByDiscordChannel = new Map<
    string,
    SessionRegistryEntry
  >();
  private initialization: Promise<void> | null = null;

  constructor(
    private readonly discord: Client,
    private readonly temporal: TemporalClient,
    private readonly config: AgentConfig,
  ) {}

  private mainSession(createdAt = new Date().toISOString()): SessionRegistryEntry {
    return {
      sessionId: "main",
      sessionType: "main",
      discordChannelId: this.config.discord.channelId,
      temporalWorkflowId: workflowIdForChannel(this.config.discord.channelId),
      status: "open",
      createdAt,
      lastActiveAt: createdAt,
      sourceSessionId: null,
      sourceRevision: null,
      forkedAt: null,
    };
  }

  private workflowInput(
    session: SessionRegistryEntry,
    initialLastSeenMessageId: string | null,
    forkContext: ForkContextSnapshot | null = null,
  ): ChannelWorkflowInput {
    return {
      guildId: this.config.discord.guildId,
      channelId: session.discordChannelId,
      parentChannelId: this.config.discord.channelId,
      sessionId: session.sessionId,
      sessionType: session.sessionType,
      initialLastSeenMessageId,
      codexThreadId: null,
      rollingSummary: "",
      recentMessages: [],
      processedTurns: 0,
      contextRevision: 0,
      forkContext,
      debounceMs: this.config.debounceMs,
    };
  }

  private registryInput(
    initialLastSeenMessageId: string | null,
  ): ChannelRegistryInput {
    return {
      guildId: this.config.discord.guildId,
      channelId: this.config.discord.channelId,
      lastSeenMessageId: initialLastSeenMessageId,
      sessions: [],
      eventsSinceContinueAsNew: 0,
    };
  }

  private isAllowedMessage(message: Message): boolean {
    return isAllowedDiscordMessage(
      {
        author: message.author,
        guildId: message.guildId,
        channelId: message.channelId,
        parentChannelId: messageParentChannelId(message),
      },
      this.config,
      this.discord.user?.id,
    );
  }

  private async serializeMessage(
    message: Message,
    overrides: {
      channelId?: string;
      parentChannelId?: string | null;
      content?: string;
      replyToMessageId?: string | null;
    } = {},
  ): Promise<DiscordChannelMessage> {
    return {
      id: message.id,
      guildId: message.guildId!,
      channelId: overrides.channelId ?? message.channelId,
      parentChannelId:
        overrides.parentChannelId === undefined
          ? messageParentChannelId(message)
          : overrides.parentChannelId,
      authorId: message.author.id,
      authorName:
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username,
      authorIsBot: message.author.bot,
      content: overrides.content ?? message.content,
      createdAt: message.createdAt.toISOString(),
      mentionedBot: this.discord.user
        ? message.mentions.users.has(this.discord.user.id)
        : false,
      replyToMessageId:
        overrides.replyToMessageId === undefined
          ? (message.reference?.messageId ?? null)
          : overrides.replyToMessageId,
      attachments: await storeMessageAttachments(message, this.config),
    };
  }

  private async signalSession(
    session: SessionRegistryEntry,
    message: DiscordChannelMessage,
    forkContext: ForkContextSnapshot | null = null,
  ): Promise<void> {
    await this.temporal.workflow.signalWithStart(channelSessionWorkflow, {
      workflowId: session.temporalWorkflowId,
      taskQueue: this.config.temporal.taskQueue,
      args: [this.workflowInput(session, message.id, forkContext)],
      signal: discordMessageSignal,
      signalArgs: [message],
    });
  }

  private async ensureMainWorkflow(
    initialLastSeenMessageId: string | null,
  ): Promise<void> {
    const session = this.mainSession();
    try {
      await this.temporal.workflow.start(channelSessionWorkflow, {
        workflowId: session.temporalWorkflowId,
        taskQueue: this.config.temporal.taskQueue,
        args: [this.workflowInput(session, initialLastSeenMessageId)],
      });
      console.info(
        `Started Temporal main session at Discord checkpoint ${initialLastSeenMessageId ?? "empty"}`,
      );
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }

  private async ensureRegistry(
    initialLastSeenMessageId: string | null,
  ): Promise<void> {
    try {
      await this.temporal.workflow.start(channelRegistryWorkflow, {
        workflowId: registryWorkflowIdForChannel(this.config.discord.channelId),
        taskQueue: this.config.temporal.taskQueue,
        args: [this.registryInput(initialLastSeenMessageId)],
      });
      console.info(
        `Started Temporal channel registry at Discord checkpoint ${initialLastSeenMessageId ?? "empty"}`,
      );
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  }

  private registryHandle() {
    return this.temporal.workflow.getHandle<typeof channelRegistryWorkflow>(
      registryWorkflowIdForChannel(this.config.discord.channelId),
    );
  }

  private async refreshRegistry(): Promise<ChannelRegistryState> {
    const state = await this.registryHandle().query(channelRegistryStateQuery);
    this.sessionsByDiscordChannel.clear();
    for (const session of state.sessions) {
      this.sessionsByDiscordChannel.set(session.discordChannelId, session);
    }
    return state;
  }

  private async upsertRegistrySession(
    session: SessionRegistryEntry,
  ): Promise<void> {
    const existing = this.sessionsByDiscordChannel.get(
      session.discordChannelId,
    );
    const merged = {
      ...existing,
      ...session,
      createdAt: existing?.createdAt ?? session.createdAt,
    };
    this.sessionsByDiscordChannel.set(session.discordChannelId, merged);
    await this.registryHandle().signal(registrySessionSignal, merged);
  }

  private async checkpointMainChannel(messageId: string): Promise<void> {
    await this.registryHandle().signal(registryCheckpointSignal, messageId);
  }

  private async mainState(): Promise<ChannelWorkflowState> {
    return this.sessionState(workflowIdForChannel(this.config.discord.channelId));
  }

  private async sessionState(
    temporalWorkflowId: string,
  ): Promise<ChannelWorkflowState> {
    return this.temporal.workflow
      .getHandle<typeof channelSessionWorkflow>(temporalWorkflowId)
      .query(channelStateQuery);
  }

  private async existingOrNewThread(
    message: Message,
    command: SessionCommand,
  ): Promise<GuildTextBasedChannel> {
    let channel: unknown = null;
    if (message.hasThread) {
      channel = await this.discord.channels.fetch(message.id);
    } else {
      channel = await message.startThread({ name: discordThreadName(command) });
    }
    const thread = requireGuildTextChannel(channel);
    if (!thread.isThread() || thread.parentId !== this.config.discord.channelId) {
      throw new Error("Discord created an unexpected session thread");
    }
    if (thread.archived) await thread.setArchived(false);
    return thread;
  }

  private async createThreadSession(
    message: Message,
    command: SessionCommand,
  ): Promise<void> {
    let forkContext: ForkContextSnapshot | null = null;
    if (command.type === "fork") {
      forkContext = forkSnapshotFromState(
        await this.mainState(),
        new Date().toISOString(),
      );
    }

    const existing = this.sessionsByDiscordChannel.get(message.id);
    const thread = existing
      ? requireGuildTextChannel(await this.discord.channels.fetch(message.id))
      : await this.existingOrNewThread(message, command);
    if (!thread.isThread() || thread.parentId !== this.config.discord.channelId) {
      throw new Error("Registered Discord session is not a child thread");
    }

    const now = message.createdAt.toISOString();
    const proposedSession: SessionRegistryEntry =
      existing ?? {
        sessionId: thread.id,
        sessionType: command.type,
        discordChannelId: thread.id,
        temporalWorkflowId: workflowIdForThreadSession(
          this.config.discord.channelId,
          thread.id,
        ),
        status: "open",
        createdAt: now,
        lastActiveAt: now,
        sourceSessionId: forkContext?.sourceSessionId ?? null,
        sourceRevision: forkContext?.sourceRevision ?? null,
        forkedAt: forkContext?.capturedAt ?? null,
      };
    const serialized = await this.serializeMessage(message, {
      channelId: thread.id,
      parentChannelId: this.config.discord.channelId,
      content: command.request,
      replyToMessageId: null,
    });

    // Start/signal the durable session before advancing the registry checkpoint.
    // Reprocessing after a crash is safe because the workflow deduplicates the
    // Discord root message ID and a message-created public thread has that ID.
    await this.signalSession(proposedSession, serialized, forkContext);
    const durableState = await this.sessionState(
      proposedSession.temporalWorkflowId,
    );
    await this.upsertRegistrySession({
      ...proposedSession,
      sessionType: durableState.sessionType,
      sourceSessionId: durableState.sourceSessionId,
      sourceRevision: durableState.sourceRevision,
      forkedAt: durableState.forkedAt,
      lastActiveAt: now,
    });
  }

  private async routeParentMessage(message: Message): Promise<void> {
    const botId = this.discord.user?.id;
    const command = botId
      ? parseSessionCommand(message.content, botId)
      : null;
    if (command) {
      await this.createThreadSession(message, command);
    } else {
      const session =
        this.sessionsByDiscordChannel.get(this.config.discord.channelId) ??
        this.mainSession(message.createdAt.toISOString());
      await this.signalSession(session, await this.serializeMessage(message));
      await this.upsertRegistrySession({
        ...session,
        lastActiveAt: message.createdAt.toISOString(),
      });
    }
    await this.checkpointMainChannel(message.id);
  }

  private async routeThreadMessage(message: Message): Promise<void> {
    let session = this.sessionsByDiscordChannel.get(message.channelId);
    if (!session) {
      await this.refreshRegistry();
      session = this.sessionsByDiscordChannel.get(message.channelId);
    }
    // Ignore threads the agent did not create, even when they share the
    // configured parent channel and user allow-list.
    if (!session || session.sessionType === "main" || session.status !== "open") {
      return;
    }
    await this.signalSession(session, await this.serializeMessage(message));
    await this.upsertRegistrySession({
      ...session,
      lastActiveAt: message.createdAt.toISOString(),
    });
  }

  private async signal(message: Message): Promise<void> {
    if (!this.isAllowedMessage(message)) return;
    if (message.channelId === this.config.discord.channelId) {
      await this.routeParentMessage(message);
      return;
    }
    await this.routeThreadMessage(message);
  }

  private async backfillAfter(
    channel: GuildTextBasedChannel,
    afterMessageId: string | null,
  ): Promise<void> {
    if (!afterMessageId) {
      const fetched = await channel.messages.fetch({
        limit: this.config.discord.backfillLimit,
      });
      const ordered = [...fetched.values()].sort((left, right) =>
        compareDiscordSnowflakes(left.id, right.id),
      );
      for (const message of ordered) await this.signal(message);
      return;
    }

    let after = afterMessageId;
    for (;;) {
      const fetched = await channel.messages.fetch({
        after,
        limit: this.config.discord.backfillLimit,
      });
      if (fetched.size === 0) break;

      const ordered = [...fetched.values()].sort((left, right) =>
        compareDiscordSnowflakes(left.id, right.id),
      );
      for (const message of ordered) await this.signal(message);
      after = ordered.at(-1)!.id;
      if (fetched.size < this.config.discord.backfillLimit) break;
    }
  }

  private async backfillRegisteredThread(
    session: SessionRegistryEntry,
  ): Promise<void> {
    const channel = requireGuildTextChannel(
      await this.discord.channels.fetch(session.discordChannelId),
    );
    if (!channel.isThread() || channel.parentId !== this.config.discord.channelId) {
      throw new Error(
        `Registered Discord session ${session.sessionId} is not a child thread`,
      );
    }
    const state = await this.temporal.workflow
      .getHandle<typeof channelSessionWorkflow>(session.temporalWorkflowId)
      .query(channelStateQuery);
    await this.backfillAfter(channel, state.lastSeenMessageId);
  }

  private async onReady(): Promise<void> {
    const channel = requireGuildTextChannel(
      await this.discord.channels.fetch(this.config.discord.channelId),
    );
    if (channel.isThread()) {
      throw new Error("DISCORD_CHANNEL_ID must identify the parent text channel");
    }
    const latest = await channel.messages.fetch({ limit: 1 });
    const latestMessageId = latest.first()?.id ?? null;

    await this.ensureMainWorkflow(latestMessageId);
    const legacyMainState = await this.mainState();
    await this.ensureRegistry(
      legacyMainState.lastSeenMessageId ?? latestMessageId,
    );
    const registry = await this.refreshRegistry();
    await this.upsertRegistrySession(this.mainSession());

    await this.backfillAfter(channel, registry.lastSeenMessageId);
    for (const session of this.sessionsByDiscordChannel.values()) {
      if (session.sessionType === "main" || session.status !== "open") continue;
      try {
        await this.backfillRegisteredThread(session);
      } catch (error) {
        console.warn(
          `Could not backfill Discord session ${session.sessionId}`,
          error,
        );
      }
    }

    const audience = this.config.discord.allowAllUsers
      ? "all non-bot users"
      : `only user ${this.config.discord.allowedUserId}`;
    const botAudience =
      this.config.discord.allowedBotIds.length > 0
        ? ` plus ${this.config.discord.allowedBotIds.length} allow-listed bot(s)`
        : "";
    console.info(
      `Discord agent ready as ${this.discord.user?.tag ?? "unknown bot"}; accepting ${audience}${botAudience} in channel ${this.config.discord.channelId}; ${this.sessionsByDiscordChannel.size} registered session(s)`,
    );
  }

  async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      this.discord.once(Events.ClientReady, () => {
        this.initialization = this.onReady();
        void this.initialization.then(resolve, reject);
      });
    });
    this.discord.on(Events.MessageCreate, (message) => {
      void (async () => {
        if (this.initialization) await this.initialization;
        await this.signal(message);
      })().catch((error: unknown) => {
        console.error("Failed to ingest Discord message", error);
      });
    });
    await this.discord.login(this.config.discord.botToken);
    await ready;
  }
}
