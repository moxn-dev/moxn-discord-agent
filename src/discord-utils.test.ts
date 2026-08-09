import { describe, expect, it } from "vitest";
import {
  compareDiscordSnowflakes,
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
});
