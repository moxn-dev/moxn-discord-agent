import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  log,
  patched,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  AgentTurnResult,
  ChannelRegistryInput,
  ChannelRegistryState,
  ChannelWorkflowInput,
  ChannelWorkflowState,
  DeliverDiscordActionInput,
  DiscordChannelMessage,
  ProcessChannelTurnInput,
  SessionRegistryEntry,
} from "../types.js";
import {
  AGENT_TURN_HEARTBEAT_TIMEOUT,
  AGENT_TURN_START_TO_CLOSE_TIMEOUT,
} from "../temporal-lifecycle.js";

interface ChannelActivities {
  processChannelTurn(input: ProcessChannelTurnInput): Promise<AgentTurnResult>;
  deliverDiscordAction(input: DeliverDiscordActionInput): Promise<void>;
}

const { processChannelTurn } = proxyActivities<ChannelActivities>({
  startToCloseTimeout: AGENT_TURN_START_TO_CLOSE_TIMEOUT,
  heartbeatTimeout: AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: { maximumAttempts: 1 },
});
const { deliverDiscordAction } = proxyActivities<ChannelActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export const discordMessageSignal =
  defineSignal<[DiscordChannelMessage]>("discordMessage");
export const channelStateQuery =
  defineQuery<ChannelWorkflowState>("channelState");
export const registrySessionSignal =
  defineSignal<[SessionRegistryEntry]>("registrySession");
export const registryCheckpointSignal =
  defineSignal<[string]>("registryCheckpoint");
export const channelRegistryStateQuery =
  defineQuery<ChannelRegistryState>("channelRegistryState");

function isLaterSnowflake(candidate: string, current: string | null): boolean {
  return current === null || BigInt(candidate) > BigInt(current);
}

export async function channelSessionWorkflow(
  input: ChannelWorkflowInput,
): Promise<void> {
  // Existing main-session histories scheduled the original Activity payload.
  // Keep replaying that exact command shape until the workflow continues as
  // new; newly created main/task/fork workflows record and use this patch.
  const multiSessionPayloads = patched("multi-session-payloads-v1");
  // Discord output is a recoverable side effect. Preserve the old failure
  // semantics while replaying closed histories that predate this patch.
  const isolateDiscordDeliveryFailures = patched(
    "isolate-discord-delivery-failures-v1",
  );
  const parentChannelId = input.parentChannelId ?? input.channelId;
  const sessionId = input.sessionId ?? "main";
  const sessionType = input.sessionType ?? "main";
  let lastSeenMessageId = input.initialLastSeenMessageId;
  let codexThreadId = input.codexThreadId;
  let rollingSummary = input.rollingSummary;
  let recentMessages = input.recentMessages.slice(-50);
  let processedTurns = input.processedTurns;
  let contextRevision = input.contextRevision ?? input.processedTurns;
  let forkContext = input.forkContext ?? null;
  const queue: DiscordChannelMessage[] = [];
  const knownMessageIds = new Set(recentMessages.map((message) => message.id));

  setHandler(discordMessageSignal, (message) => {
    if (knownMessageIds.has(message.id)) return;
    knownMessageIds.add(message.id);
    queue.push(message);
    if (isLaterSnowflake(message.id, lastSeenMessageId)) {
      lastSeenMessageId = message.id;
    }
  });

  setHandler(channelStateQuery, () => ({
    guildId: input.guildId,
    channelId: input.channelId,
    parentChannelId,
    sessionId,
    sessionType,
    lastSeenMessageId,
    codexThreadId,
    rollingSummary,
    recentMessages,
    queuedMessages: queue.length,
    processedTurns,
    contextRevision,
    sourceSessionId: forkContext?.sourceSessionId ?? null,
    sourceRevision: forkContext?.sourceRevision ?? null,
    forkedAt: forkContext?.capturedAt ?? null,
  }));

  for (;;) {
    await condition(() => queue.length > 0);
    await sleep(`${input.debounceMs} milliseconds`);
    const messages = queue.splice(0, queue.length);
    const triggeringMessageId = messages.at(-1)?.id;
    if (!triggeringMessageId) continue;

    let action: AgentTurnResult;
    try {
      const legacyTurnInput: ProcessChannelTurnInput = {
        guildId: input.guildId,
        channelId: input.channelId,
        messages,
        recentMessages,
        rollingSummary,
        codexThreadId,
      };
      action = await processChannelTurn(
        multiSessionPayloads
          ? {
              ...legacyTurnInput,
              parentChannelId,
              sessionId,
              sessionType,
              forkContext: codexThreadId ? null : forkContext,
            }
          : legacyTurnInput,
      );
      codexThreadId = action.codexThreadId;
      rollingSummary = action.updatedSummary;
    } catch (error) {
      log.error("Agent turn failed", { error });
      action = {
        disposition: "reply",
        message:
          "I hit an agent runtime error while handling that. The message is safely recorded in Temporal; check the worker log, then try again.",
        replyToMessageId: triggeringMessageId,
        reaction: null,
        updatedSummary: rollingSummary,
        codexThreadId: codexThreadId ?? "not-started",
      };
    }
    try {
      await deliverDiscordAction({
        channelId: input.channelId,
        triggeringMessageId,
        action,
      });
    } catch (error) {
      if (!isolateDiscordDeliveryFailures) throw error;
      log.error("Discord delivery failed; keeping session open", {
        error,
        sessionId,
        sessionType,
        triggeringMessageId,
      });
    }

    recentMessages = [...recentMessages, ...messages].slice(-50);
    processedTurns += 1;
    contextRevision += 1;

    if (processedTurns >= 100 && queue.length === 0) {
      await continueAsNew<typeof channelSessionWorkflow>({
        guildId: input.guildId,
        channelId: input.channelId,
        parentChannelId,
        sessionId,
        sessionType,
        initialLastSeenMessageId: lastSeenMessageId,
        codexThreadId,
        rollingSummary,
        recentMessages,
        processedTurns: 0,
        contextRevision,
        forkContext,
        debounceMs: input.debounceMs,
      });
    }
  }
}

const REGISTRY_CONTINUE_AS_NEW_EVENTS = 500;

/**
 * Durable control-plane state for one configured Discord channel. Conversation
 * state remains in independent session workflows so main, task, and fork turns
 * can execute concurrently and continue-as-new on their own schedules.
 */
export async function channelRegistryWorkflow(
  input: ChannelRegistryInput,
): Promise<void> {
  let lastSeenMessageId = input.lastSeenMessageId;
  let eventsSinceContinueAsNew = input.eventsSinceContinueAsNew;
  const sessions = new Map(
    input.sessions.map((session) => [session.discordChannelId, session]),
  );

  setHandler(registrySessionSignal, (session) => {
    const existing = sessions.get(session.discordChannelId);
    sessions.set(session.discordChannelId, {
      ...existing,
      ...session,
      createdAt: existing?.createdAt ?? session.createdAt,
    });
    eventsSinceContinueAsNew += 1;
  });

  setHandler(registryCheckpointSignal, (messageId) => {
    if (isLaterSnowflake(messageId, lastSeenMessageId)) {
      lastSeenMessageId = messageId;
    }
    eventsSinceContinueAsNew += 1;
  });

  setHandler(channelRegistryStateQuery, () => ({
    guildId: input.guildId,
    channelId: input.channelId,
    lastSeenMessageId,
    sessions: [...sessions.values()],
  }));

  await condition(
    () => eventsSinceContinueAsNew >= REGISTRY_CONTINUE_AS_NEW_EVENTS,
  );
  await continueAsNew<typeof channelRegistryWorkflow>({
    guildId: input.guildId,
    channelId: input.channelId,
    lastSeenMessageId,
    sessions: [...sessions.values()],
    eventsSinceContinueAsNew: 0,
  });
}
