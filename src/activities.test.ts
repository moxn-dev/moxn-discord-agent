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
  parentChannelId: "200",
  sessionId: "main",
  sessionType: "main",
  messages: [],
  recentMessages: [],
  rollingSummary: "",
  codexThreadId: null,
  forkContext: null,
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

  it("allows independent session turns to enter Codex concurrently", async () => {
    const finishes: Array<(value: AgentTurnResult) => void> = [];
    const codex = {
      run: vi.fn().mockImplementation(
        () =>
          new Promise<AgentTurnResult>((resolve) => {
            finishes.push(resolve);
          }),
      ),
    } as unknown as CodexRunner;
    const { discord } = discordWithChannel();
    const activities = createActivities(discord, codex);

    const mainTurn = activities.processChannelTurn(input);
    const taskTurn = activities.processChannelTurn({
      ...input,
      channelId: "201",
      sessionId: "201",
      sessionType: "task",
    });

    await flushPromises();
    expect(codex.run).toHaveBeenCalledTimes(2);
    expect(finishes).toHaveLength(2);

    for (const finish of finishes) finish(result);
    await expect(Promise.all([mainTurn, taskTurn])).resolves.toEqual([
      result,
      result,
    ]);
  });

  it("gives in-flight activities a bounded deployment drain window", () => {
    const config = {
      temporal: {
        namespace: "test",
        taskQueue: "agent-turns",
        maxConcurrentActivities: 4,
      },
    } as AgentConfig;
    const options = createWorkerOptions(
      config,
      {} as AgentActivities,
      {} as NativeConnection,
    );

    expect(options.shutdownGraceTime).toBe(WORKER_SHUTDOWN_GRACE_TIME);
    expect(options.shutdownForceTime).toBe(WORKER_SHUTDOWN_FORCE_TIME);
    expect(options.maxConcurrentActivityTaskExecutions).toBe(4);
    expect(msToNumber(AGENT_TURN_HEARTBEAT_TIMEOUT)).toBe(45_000);
    expect(msToNumber(AGENT_TURN_START_TO_CLOSE_TIMEOUT)).toBe(1_800_000);
    expect(msToNumber(WORKER_SHUTDOWN_GRACE_TIME)).toBe(300_000);
    expect(msToNumber(WORKER_SHUTDOWN_FORCE_TIME)).toBe(315_000);
  });
});

describe("Discord delivery", () => {
  function replyAction(replyToMessageId: string | null = null): AgentTurnResult {
    return {
      disposition: "reply",
      message: "Ready.",
      replyToMessageId,
      reaction: null,
      updatedSummary: "",
      codexThreadId: "thread-1",
    };
  }

  it("posts directly in a thread when responding to its starter message", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const fetchMessage = vi.fn();
    const thread = {
      id: "201",
      parentId: "200",
      isTextBased: () => true,
      isDMBased: () => false,
      isThread: () => true,
      messages: { fetch: fetchMessage },
      send,
    };
    const discord = {
      isReady: () => true,
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client;

    await createActivities(
      discord,
      {} as CodexRunner,
    ).deliverDiscordAction({
      channelId: "201",
      triggeringMessageId: "201",
      action: replyAction("201"),
    });

    expect(fetchMessage).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      content: "Ready.",
      allowedMentions: { parse: [] },
      nonce: "201-0",
      enforceNonce: true,
    });
  });

  it("replies to an ordinary message inside a thread", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const target = { reply };
    const fetchMessage = vi.fn().mockResolvedValue(target);
    const thread = {
      id: "201",
      parentId: "200",
      isTextBased: () => true,
      isDMBased: () => false,
      isThread: () => true,
      messages: { fetch: fetchMessage },
      send: vi.fn(),
    };
    const discord = {
      isReady: () => true,
      channels: { fetch: vi.fn().mockResolvedValue(thread) },
    } as unknown as Client;

    await createActivities(
      discord,
      {} as CodexRunner,
    ).deliverDiscordAction({
      channelId: "201",
      triggeringMessageId: "202",
      action: replyAction("202"),
    });

    expect(fetchMessage).toHaveBeenCalledWith("202");
    expect(reply).toHaveBeenCalledWith({
      content: "Ready.",
      allowedMentions: { parse: [], repliedUser: false },
      nonce: "202-0",
      enforceNonce: true,
    });
  });

  it("reacts to a thread starter through its parent channel", async () => {
    const react = vi.fn().mockResolvedValue(undefined);
    const parentFetch = vi.fn().mockResolvedValue({ react });
    const thread = {
      id: "201",
      parentId: "200",
      isTextBased: () => true,
      isDMBased: () => false,
      isThread: () => true,
      messages: { fetch: vi.fn() },
    };
    const parent = {
      id: "200",
      isTextBased: () => true,
      isDMBased: () => false,
      isThread: () => false,
      messages: { fetch: parentFetch },
    };
    const fetchChannel = vi
      .fn()
      .mockImplementation((id: string) =>
        Promise.resolve(id === "201" ? thread : parent),
      );
    const discord = {
      isReady: () => true,
      channels: { fetch: fetchChannel },
    } as unknown as Client;

    await createActivities(
      discord,
      {} as CodexRunner,
    ).deliverDiscordAction({
      channelId: "201",
      triggeringMessageId: "201",
      action: {
        ...replyAction("201"),
        disposition: "react",
        message: null,
        reaction: "👍",
      },
    });

    expect(fetchChannel).toHaveBeenCalledWith("200");
    expect(parentFetch).toHaveBeenCalledWith("201");
    expect(react).toHaveBeenCalledWith("👍");
  });
});
