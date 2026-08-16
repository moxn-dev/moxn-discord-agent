import { describe, expect, it } from "vitest";
import { buildAgentPrompt, isUnusableCodexThreadError } from "./codex-runner.js";
import type { ProcessChannelTurnInput } from "./types.js";

describe("isUnusableCodexThreadError", () => {
  it("recognizes a missing rollout file during thread resume", () => {
    const error = new Error(
      "thread/resume failed: failed to resolve rollout path /old/codex/session.jsonl: file does not exist",
    );

    expect(isUnusableCodexThreadError(error)).toBe(true);
  });

  it("recognizes the failure through an error cause chain", () => {
    const cause = new Error(
      "thread/resume failed: rollout file was not found",
    );
    const error = new Error("Codex Exec exited with code 1", { cause });

    expect(isUnusableCodexThreadError(error)).toBe(true);
  });

  it("does not discard a thread for an unrelated runtime failure", () => {
    expect(
      isUnusableCodexThreadError(
        new Error("Codex Exec exited with code 1: authentication failed"),
      ),
    ).toBe(false);
  });
});

describe("session prompts", () => {
  const baseInput: ProcessChannelTurnInput = {
    guildId: "100",
    channelId: "201",
    parentChannelId: "200",
    sessionId: "201",
    sessionType: "task",
    messages: [],
    recentMessages: [],
    rollingSummary: "",
    codexThreadId: null,
    forkContext: null,
  };

  it("marks task sessions as fresh while retaining shared Moxn knowledge", () => {
    const prompt = buildAgentPrompt(baseInput);
    expect(prompt).toContain("independent task thread");
    expect(prompt).toContain("Moxn remains shared durable knowledge");
    expect(prompt).not.toContain("Fork source:");
  });

  it("seeds a fork with a frozen, revisioned main snapshot", () => {
    const prompt = buildAgentPrompt({
      ...baseInput,
      sessionType: "fork",
      forkContext: {
        sourceSessionId: "main",
        sourceRevision: 7,
        capturedAt: "2026-08-15T13:00:00.000Z",
        rollingSummary: "Main knows the Yellowstone plan.",
        recentMessages: [],
      },
    });
    expect(prompt).toContain("independent fork");
    expect(prompt).toContain("main revision 7");
    expect(prompt).toContain("Main knows the Yellowstone plan.");
  });
});
