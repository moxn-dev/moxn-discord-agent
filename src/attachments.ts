import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment, Message } from "discord.js";
import type { AgentConfig } from "./config.js";
import { sanitizeFilename } from "./discord-utils.js";
import type { StoredAttachment } from "./types.js";

const allowedDiscordCdnHosts = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

export function isAllowedDiscordAttachmentUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && allowedDiscordCdnHosts.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function assertSnowflake(value: string, label: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid Discord ${label}`);
  }
}

async function downloadAttachment(
  attachment: Attachment,
  messageId: string,
  config: AgentConfig,
): Promise<StoredAttachment> {
  const base: StoredAttachment = {
    id: attachment.id,
    filename: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    localPath: null,
    downloadError: null,
  };

  if (attachment.size > config.discord.attachmentMaxBytes) {
    return {
      ...base,
      downloadError: `Attachment exceeds the ${config.discord.attachmentMaxBytes}-byte limit`,
    };
  }

  try {
    assertSnowflake(messageId, "message ID");
    assertSnowflake(attachment.id, "attachment ID");
    const messageDirectory = join(
      config.local.dataDirectory,
      "inbox",
      messageId,
    );
    await mkdir(messageDirectory, { recursive: true, mode: 0o700 });

    const filename = `${attachment.id}-${sanitizeFilename(attachment.name)}`;
    const destination = join(messageDirectory, filename);
    try {
      await access(destination);
      return { ...base, localPath: destination };
    } catch {
      // Continue with the download when the deterministic target is absent.
    }

    if (!isAllowedDiscordAttachmentUrl(attachment.url)) {
      throw new Error("Discord attachment URL used an unexpected host");
    }
    const attachmentUrl = new URL(attachment.url);

    const response = await fetch(attachmentUrl, {
      headers: { "User-Agent": "moxn-discord-agent/0.1" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`Discord CDN returned HTTP ${response.status}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > config.discord.attachmentMaxBytes) {
      throw new Error("Downloaded attachment exceeded the configured limit");
    }
    if (attachment.size > 0 && bytes.byteLength !== attachment.size) {
      throw new Error(
        `Downloaded ${bytes.byteLength} bytes; Discord reported ${attachment.size}`,
      );
    }

    const temporary = `${destination}.${process.pid}.part`;
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
    return { ...base, localPath: destination };
  } catch (error) {
    return {
      ...base,
      downloadError: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function storeMessageAttachments(
  message: Message,
  config: AgentConfig,
): Promise<StoredAttachment[]> {
  return Promise.all(
    message.attachments.map((attachment) =>
      downloadAttachment(attachment, message.id, config),
    ),
  );
}
