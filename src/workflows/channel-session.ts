import {
  condition,
  continueAsNew,
  defineQuery,
  defineSignal,
  log,
  proxyActivities,
  setHandler,
  sleep,
} from "@temporalio/workflow";
import type {
  AgentTurnResult,
  ChannelWorkflowInput,
  ChannelWorkflowState,
  DeliverDiscordActionInput,
  DiscordChannelMessage,
  ProcessChannelTurnInput,
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

function isLaterSnowflake(candidate: string, current: string | null): boolean {
  return current === null || BigInt(candidate) > BigInt(current);
}

export async function channelSessionWorkflow(
  input: ChannelWorkflowInput,
): Promise<void> {
  let lastSeenMessageId = input.initialLastSeenMessageId;
  let codexThreadId = input.codexThreadId;
  let rollingSummary = input.rollingSummary;
  let recentMessages = input.recentMessages.slice(-50);
  let processedTurns = input.processedTurns;
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
    lastSeenMessageId,
    codexThreadId,
    rollingSummary,
    recentMessages,
    queuedMessages: queue.length,
    processedTurns,
  }));

  for (;;) {
    await condition(() => queue.length > 0);
    await sleep(`${input.debounceMs} milliseconds`);
    const messages = queue.splice(0, queue.length);
    const triggeringMessageId = messages.at(-1)?.id;
    if (!triggeringMessageId) continue;

    let action: AgentTurnResult;
    try {
      action = await processChannelTurn({
        guildId: input.guildId,
        channelId: input.channelId,
        messages,
        recentMessages,
        rollingSummary,
        codexThreadId,
      });
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
    await deliverDiscordAction({
      channelId: input.channelId,
      triggeringMessageId,
      action,
    });

    recentMessages = [...recentMessages, ...messages].slice(-50);
    processedTurns += 1;

    if (processedTurns >= 100 && queue.length === 0) {
      await continueAsNew<typeof channelSessionWorkflow>({
        guildId: input.guildId,
        channelId: input.channelId,
        initialLastSeenMessageId: lastSeenMessageId,
        codexThreadId,
        rollingSummary,
        recentMessages,
        processedTurns: 0,
        debounceMs: input.debounceMs,
      });
    }
  }
}
