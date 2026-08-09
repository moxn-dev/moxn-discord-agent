import { describe, expect, it } from "vitest";
import { isUnusableCodexThreadError } from "./codex-runner.js";

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
