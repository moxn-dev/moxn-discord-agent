import { heartbeat } from "@temporalio/activity";
import { msToNumber } from "@temporalio/common/lib/time.js";
import type { NativeConnection } from "@temporalio/worker";
import { EventEmitter } from "node:events";
import { Events, type Client } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivities, type AgentActivities } from "./activities.js";
import type { CodexRunner } from "./codex-runner.js";
import type { AgentConfig } from "./config.js";
import {
  AGENT_TURN_HEARTBEAT_INTERVAL_MS,
  AGENT_TURN_HEARTBEAT_TIMEOUT,
  AGENT_TURN_START_TO_CLOSE_TIMEOUT,
  WORKER_SHUTDOWN_FORCE_TIME,
  WORKER_SHUTDOWN_GRACE_TIME,
} from "./temporal-lifecycle.js";
import { createWorkerOptions } from "./temporal-runtime.js";
import type { AgentTurnResult, ProcessChannelTurnInput } from "./types.js";

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const input: ProcessChannelTurnInput = {
  guildId: "100",
  channelId: "200",
  messages: [],
  recentMessages: [],
  rollingSummary: "",
  codexThreadId: null,
};

const result: AgentTurnResult = {
  disposition: "silent",
  message: null,
  replyToMessageId: null,
  reaction: null,
  updatedSummary: "",
  codexThreadId: "thread-1",
};

function discordWithChannel(sendTyping = vi.fn().mockResolvedValue(undefined)) {
  const channel = {
    isTextBased: () => true,
    isDMBased: () => false,
    sendTyping,
  };
  const discord = {
    isReady: () => true,
    channels: { fetch: vi.fn().mockResolvedValue(channel) },
  } as unknown as Client;
  return { discord, sendTyping };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("Temporal activity lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(heartbeat).mockReset();
  });

  afterEach(() => vi.useRealTimers());

  it("heartbeats throughout a long Codex turn and stops afterward", async () => {
    let finishTurn!: (value: AgentTurnResult) => void;
    const turn = new Promise<AgentTurnResult>((resolve) => {
      finishTurn = resolve;
    });
    const codex = { run: vi.fn().mockReturnValue(turn) } as unknown as CodexRunner;
    const { discord, sendTyping } = discordWithChannel();
    const activity = createActivities(discord, codex).processChannelTurn(input);

    await flushPromises();
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(codex.run).toHaveBeenCalledWith(input);

    await vi.advanceTimersByTimeAsync(AGENT_TURN_HEARTBEAT_INTERVAL_MS);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(sendTyping).toHaveBeenCalledTimes(2);

    finishTurn(result);
    await expect(activity).resolves.toEqual(result);
    await vi.advanceTimersByTimeAsync(AGENT_TURN_HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("clears its heartbeat when setup fails", async () => {
    const discord = {
      isReady: () => true,
      channels: { fetch: vi.fn().mockRejectedValue(new Error("Discord down")) },
    } as unknown as Client;
    const codex = { run: vi.fn() } as unknown as CodexRunner;

    await expect(
      createActivities(discord, codex).processChannelTurn(input),
    ).rejects.toThrow("Discord down");
    expect(heartbeat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AGENT_TURN_HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeat).toHaveBeenCalledTimes(1);
  });

  it("waits for Discord readiness before fetching the channel", async () => {
    let ready = false;
    const channel = {
      isTextBased: () => true,
      isDMBased: () => false,
      sendTyping: vi.fn().mockResolvedValue(undefined),
    };
    const discord = Object.assign(new EventEmitter(), {
      isReady: () => ready,
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    }) as unknown as Client;
    const codex = {
      run: vi.fn().mockResolvedValue(result),
    } as unknown as CodexRunner;

    const activity = createActivities(discord, codex).processChannelTurn(input);
    await flushPromises();
    expect(discord.channels.fetch).not.toHaveBeenCalled();

    ready = true;
    discord.emit(Events.ClientReady, discord as Client<true>);
    await expect(activity).resolves.toEqual(result);
    expect(discord.channels.fetch).toHaveBeenCalledWith(input.channelId);
  });

  it("gives in-flight activities a bounded deployment drain window", () => {
    const config = {
      temporal: { namespace: "test", taskQueue: "agent-turns" },
    } as AgentConfig;
    const options = createWorkerOptions(
      config,
      {} as AgentActivities,
      {} as NativeConnection,
    );

    expect(options.shutdownGraceTime).toBe(WORKER_SHUTDOWN_GRACE_TIME);
    expect(options.shutdownForceTime).toBe(WORKER_SHUTDOWN_FORCE_TIME);
    expect(msToNumber(AGENT_TURN_HEARTBEAT_TIMEOUT)).toBe(45_000);
    expect(msToNumber(AGENT_TURN_START_TO_CLOSE_TIMEOUT)).toBe(1_800_000);
    expect(msToNumber(WORKER_SHUTDOWN_GRACE_TIME)).toBe(300_000);
    expect(msToNumber(WORKER_SHUTDOWN_FORCE_TIME)).toBe(315_000);
  });
});
