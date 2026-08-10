import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = optional(name)?.toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

const codexReasoningEfforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type CodexReasoningEffort = (typeof codexReasoningEfforts)[number];

function optionalCodexReasoningEffort(): CodexReasoningEffort | undefined {
  const value = optional("CODEX_REASONING_EFFORT");
  if (!value) return undefined;
  if (!codexReasoningEfforts.includes(value as CodexReasoningEffort)) {
    throw new Error(
      `CODEX_REASONING_EFFORT must be one of: ${codexReasoningEfforts.join(", ")}`,
    );
  }
  return value as CodexReasoningEffort;
}

function requiredSnowflake(name: string): string {
  const value = required(name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric Discord ID`);
  }
  return value;
}

function optionalSnowflake(name: string): string | undefined {
  const value = optional(name);
  if (value && !/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric Discord ID`);
  }
  return value;
}

function snowflakeList(name: string): string[] {
  const raw = optional(name);
  if (!raw) return [];
  const values = [...new Set(raw.split(",").map((value) => value.trim()))].filter(
    Boolean,
  );
  for (const value of values) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`${name} must contain comma-separated numeric Discord IDs`);
    }
  }
  return values;
}

export interface AgentConfig {
  codex: {
    model: string | undefined;
    reasoningEffort: CodexReasoningEffort | undefined;
  };
  discord: {
    botToken: string;
    guildId: string;
    channelId: string;
    allowAllUsers: boolean;
    allowedUserId: string | undefined;
    allowedBotIds: string[];
    attachmentMaxBytes: number;
    backfillLimit: number;
  };
  temporal: {
    address: string;
    namespace: string;
    apiKey: string;
    taskQueue: string;
  };
  moxn: {
    apiKey: string;
    mcpEnabled: boolean;
    mcpToken: string | undefined;
    workspace: string;
    baseUrl: string | undefined;
    vercelBypass: string | undefined;
    mcpEntry: string;
    contextCliBin: string;
    contextCliBinDirectory: string;
  };
  local: {
    dataDirectory: string;
    agentWorkspace: string;
    codexHome: string;
    personaTemplate: string;
  };
  debounceMs: number;
}

export function loadConfig(): AgentConfig {
  const dataDirectory = resolve(
    optional("AGENT_DATA_DIR") ||
      resolve(homedir(), ".moxn", "discord-agent"),
  );
  const allowAllDiscordUsers = boolean("DISCORD_ALLOW_ALL_USERS", false);

  return {
    codex: {
      model: optional("CODEX_MODEL"),
      reasoningEffort: optionalCodexReasoningEffort(),
    },
    discord: {
      botToken: required("DISCORD_BOT_TOKEN"),
      guildId: requiredSnowflake("DISCORD_GUILD_ID"),
      channelId: requiredSnowflake("DISCORD_CHANNEL_ID"),
      allowAllUsers: allowAllDiscordUsers,
      allowedUserId: allowAllDiscordUsers
        ? optionalSnowflake("DISCORD_ALLOWED_USER_ID")
        : requiredSnowflake("DISCORD_ALLOWED_USER_ID"),
      allowedBotIds: snowflakeList("DISCORD_ALLOWED_BOT_IDS"),
      attachmentMaxBytes: positiveInteger(
        "DISCORD_ATTACHMENT_MAX_BYTES",
        25 * 1024 * 1024,
      ),
      backfillLimit: Math.min(
        positiveInteger("DISCORD_BACKFILL_LIMIT", 100),
        100,
      ),
    },
    temporal: {
      address: required("TEMPORAL_ADDRESS"),
      namespace: required("TEMPORAL_NAMESPACE"),
      apiKey: required("TEMPORAL_API_KEY"),
      taskQueue:
        process.env.TEMPORAL_TASK_QUEUE?.trim() || "moxn-discord-agent",
    },
    moxn: {
      apiKey: required("MOXN_API_KEY"),
      mcpEnabled: boolean("MOXN_MCP_ENABLED", false),
      mcpToken: optional("MOXN_MCP_TOKEN"),
      workspace: required("MOXN_WORKSPACE"),
      baseUrl: optional("MOXN_BASE_URL"),
      vercelBypass: optional("MOXN_VERCEL_BYPASS"),
      mcpEntry: resolve(
        optional("MOXN_MCP_ENTRY") || require.resolve("@moxn/mcp-kb"),
      ),
      contextCliBin: resolve(
        packageDirectory,
        "node_modules",
        ".bin",
        "context",
      ),
      contextCliBinDirectory: resolve(
        packageDirectory,
        "node_modules",
        ".bin",
      ),
    },
    local: {
      dataDirectory,
      agentWorkspace: resolve(
        optional("AGENT_WORKSPACE") || resolve(dataDirectory, "workspace"),
      ),
      codexHome: resolve(dataDirectory, "codex"),
      personaTemplate: resolve(
        optional("AGENT_PERSONA_FILE") ||
          resolve(packageDirectory, "agent", "AGENTS.md"),
      ),
    },
    debounceMs: positiveInteger("AGENT_DEBOUNCE_MS", 2_000),
  };
}

export function workflowIdForChannel(channelId: string): string {
  return `moxn-discord-channel-${channelId}`;
}
