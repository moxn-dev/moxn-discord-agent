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
