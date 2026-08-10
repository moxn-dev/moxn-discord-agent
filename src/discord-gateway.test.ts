import { describe, expect, it } from "vitest";
import { isAllowedDiscordMessage } from "./discord-gateway.js";

const config = {
  discord: {
    botToken: "unused",
    guildId: "100",
    channelId: "200",
    allowAllUsers: false,
    allowedUserId: "300",
    attachmentMaxBytes: 1,
    backfillLimit: 1,
  },
};

describe("Discord ingress authorization", () => {
  const allowed = {
    author: { bot: false, id: "300" },
    guildId: "100",
    channelId: "200",
  };

  it("accepts only the configured user in the configured guild/channel", () => {
    expect(isAllowedDiscordMessage(allowed, config)).toBe(true);
  });

  it("accepts any non-bot user when the channel is the allow-list boundary", () => {
    const channelWide = {
      discord: { ...config.discord, allowAllUsers: true },
    };
    expect(
      isAllowedDiscordMessage(
        { ...allowed, author: { bot: false, id: "301" } },
        channelWide,
      ),
    ).toBe(true);
  });

  it.each([
    { ...allowed, author: { bot: false, id: "301" } },
    { ...allowed, guildId: "101" },
    { ...allowed, channelId: "201" },
    { ...allowed, author: { bot: true, id: "300" } },
  ])("rejects a mismatched or bot-authored message", (message) => {
    expect(isAllowedDiscordMessage(message, config)).toBe(false);
  });

  it.each([
    { ...allowed, guildId: "101" },
    { ...allowed, channelId: "201" },
    { ...allowed, author: { bot: true, id: "301" } },
  ])("keeps guild, channel, and bot filters in channel-wide mode", (message) => {
    const channelWide = {
      discord: { ...config.discord, allowAllUsers: true },
    };
    expect(isAllowedDiscordMessage(message, channelWide)).toBe(false);
  });
});
