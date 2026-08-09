import { describe, expect, it } from "vitest";
import { isAllowedDiscordAttachmentUrl } from "./attachments.js";

describe("Discord attachment URL validation", () => {
  it.each([
    "https://cdn.discordapp.com/attachments/1/2/photo.jpg",
    "https://media.discordapp.net/attachments/1/2/photo.jpg?width=800",
  ])("accepts Discord CDN URLs", (url) => {
    expect(isAllowedDiscordAttachmentUrl(url)).toBe(true);
  });

  it.each([
    "http://cdn.discordapp.com/attachments/1/2/photo.jpg",
    "https://cdn.discordapp.com.example.com/photo.jpg",
    "https://example.com/photo.jpg",
    "not-a-url",
  ])("rejects non-Discord or insecure URLs", (url) => {
    expect(isAllowedDiscordAttachmentUrl(url)).toBe(false);
  });
});
