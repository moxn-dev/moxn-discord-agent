import { describe, expect, it } from "vitest";
import { describeCodexAuthStatus } from "./preflight.js";

describe("describeCodexAuthStatus", () => {
  it("recognizes ChatGPT subscription authentication", () => {
    expect(describeCodexAuthStatus("Logged in using ChatGPT")).toBe("ChatGPT");
  });

  it("recognizes API-key authentication", () => {
    expect(describeCodexAuthStatus("Logged in using an API key")).toBe(
      "API key",
    );
  });

  it("does not echo an unfamiliar status line", () => {
    expect(describeCodexAuthStatus("Logged in as person@example.com")).toBe(
      "authenticated",
    );
  });
});
