export function splitDiscordMessage(content: string, limit = 2_000): string[] {
  const normalized = content.trim();
  if (!normalized) return [];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let boundary = remaining.lastIndexOf("\n", limit);
    if (boundary < Math.floor(limit * 0.6)) {
      boundary = remaining.lastIndexOf(" ", limit);
    }
    if (boundary < Math.floor(limit * 0.6)) boundary = limit;
    chunks.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function sanitizeFilename(filename: string): string {
  const safe = filename
    .normalize("NFKC")
    .replaceAll(/[^a-zA-Z0-9._-]+/g, "-")
    .replaceAll(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return safe || "attachment";
}

export function compareDiscordSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export interface SessionCommand {
  type: "task" | "fork";
  request: string;
}

/**
 * Session creation is deliberately explicit: the bot mention must be first,
 * followed by exactly `task` or `fork` and a non-empty request.
 */
export function parseSessionCommand(
  content: string,
  botUserId: string,
): SessionCommand | null {
  const trimmed = content.trimStart();
  const plainMention = `<@${botUserId}>`;
  const nicknameMention = `<@!${botUserId}>`;
  const mention = trimmed.startsWith(plainMention)
    ? plainMention
    : trimmed.startsWith(nicknameMention)
      ? nicknameMention
      : null;
  if (!mention) return null;

  const remainder = trimmed.slice(mention.length).trim();
  const match = /^(task|fork)(?:\s+([\s\S]+))?$/i.exec(remainder);
  const request = match?.[2]?.trim();
  if (!match || !request) return null;
  return { type: match[1]!.toLowerCase() as SessionCommand["type"], request };
}

export function discordThreadName(command: SessionCommand): string {
  const compactRequest = command.request
    .replaceAll(/<@!?\d+>/g, "")
    .replaceAll(/[`*_~|>#]+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  const prefix = `${command.type} · `;
  const available = 100 - prefix.length;
  const title = compactRequest.slice(0, available).trim();
  return `${prefix}${title || "untitled"}`;
}
