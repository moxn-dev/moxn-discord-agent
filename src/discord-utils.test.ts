import { describe, expect, it } from "vitest";
import {
  compareDiscordSnowflakes,
  discordThreadName,
  parseSessionCommand,
  sanitizeFilename,
  splitDiscordMessage,
} from "./discord-utils.js";

describe("Discord helpers", () => {
  it("sanitizes paths and unusual attachment names", () => {
    expect(sanitizeFilename("../../Trip photo (1).jpg")).toBe(
      "Trip-photo-1-.jpg",
    );
  });

  it("splits long replies without losing their text", () => {
    const content = `${"a".repeat(1_200)}\n${"b".repeat(1_200)}`;
    const chunks = splitDiscordMessage(content);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join("\n")).toBe(content);
  });

  it("orders snowflakes without number precision loss", () => {
    expect(
      compareDiscordSnowflakes("123456789012345678", "123456789012345679"),
    ).toBe(-1);
  });

  it.each([
    ["<@123> task research the event", "task", "research the event"],
    ["  <@!123> FORK\nExplore the other option", "fork", "Explore the other option"],
  ])("parses explicit mentioned session commands", (content, type, request) => {
    expect(parseSessionCommand(content, "123")).toEqual({ type, request });
  });

  it.each([
    "task research the event",
    "<@123> task",
    "hello <@123> task research the event",
    "<@123> tasks research this fork",
    "<@999> fork explore it",
  ])("does not treat ordinary messages as session commands", (content) => {
    expect(parseSessionCommand(content, "123")).toBeNull();
  });

  it("creates a compact Discord thread name", () => {
    const name = discordThreadName({
      type: "fork",
      request: "**Explore**   a very long alternative ".repeat(10),
    });
    expect(name.startsWith("fork · Explore a very long alternative")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(100);
  });
});
