import { Codex, type UserInput } from "@openai/codex-sdk";
import { delimiter } from "node:path";
import type { AgentConfig } from "./config.js";
import type {
  AgentTurnResult,
  DiscordChannelMessage,
  ProcessChannelTurnInput,
} from "./types.js";

const responseSchema = {
  type: "object",
  properties: {
    disposition: { type: "string", enum: ["reply", "react", "silent"] },
    message: { anyOf: [{ type: "string" }, { type: "null" }] },
    replyToMessageId: { anyOf: [{ type: "string" }, { type: "null" }] },
    reaction: { anyOf: [{ type: "string" }, { type: "null" }] },
    updatedSummary: { type: "string" },
  },
  required: [
    "disposition",
    "message",
    "replyToMessageId",
    "reaction",
    "updatedSummary",
  ],
  additionalProperties: false,
} as const;

interface StructuredAgentResponse {
  disposition: "reply" | "react" | "silent";
  message: string | null;
  replyToMessageId: string | null;
  reaction: string | null;
  updatedSummary: string;
}

export function createAgentEnvironment(
  config: AgentConfig,
): Record<string, string> {
  const environment: Record<string, string> = {
    CODEX_HOME: config.local.codexHome,
    HOME: process.env.HOME || config.local.dataDirectory,
    PATH: [
      config.moxn.contextCliBinDirectory,
      process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    ].join(delimiter),
    MOXN_WORKSPACE: config.moxn.workspace,
  };

  for (const name of [
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  if (config.moxn.apiKey) environment.MOXN_API_KEY = config.moxn.apiKey;
  if (config.moxn.mcpToken) environment.MOXN_TOKEN = config.moxn.mcpToken;
  if (config.moxn.baseUrl) environment.MOXN_BASE_URL = config.moxn.baseUrl;
  if (config.moxn.vercelBypass) {
    environment.MOXN_VERCEL_BYPASS = config.moxn.vercelBypass;
  }
  return environment;
}

function renderMessage(message: DiscordChannelMessage): string {
  const attachmentLines = message.attachments.map((attachment) => {
    if (attachment.localPath) {
      return `  - ${attachment.filename} (${attachment.contentType ?? "unknown type"}, ${attachment.size} bytes): ${attachment.localPath}`;
    }
    return `  - ${attachment.filename}: download unavailable (${attachment.downloadError ?? "unknown error"})`;
  });
  return [
    `[${message.createdAt}] ${message.authorName}${message.authorIsBot ? " [bot]" : ""} (message ${message.id}${message.mentionedBot ? ", mentioned you" : ""}${message.replyToMessageId ? `, replying to ${message.replyToMessageId}` : ""})`,
    message.content || "(no text)",
    ...(attachmentLines.length > 0 ? ["Attachments:", ...attachmentLines] : []),
  ].join("\n");
}

export function buildAgentPrompt(input: ProcessChannelTurnInput): string {
  const previousContext = input.recentMessages
    .slice(-20)
    .map(renderMessage)
    .join("\n\n");
  const newMessages = input.messages.map(renderMessage).join("\n\n");

  return [
    "You are receiving one durable turn from your private Discord channel.",
    "Follow AGENTS.md and use Moxn tools when context or an action calls for them.",
    "Choose reply, react, or silent. A reply must be useful and ready to post verbatim.",
    "Use only a single standard Unicode emoji for a reaction.",
    "Keep updatedSummary compact (under 1,500 characters), durable, and focused on facts/follow-ups that will matter in later channel turns.",
    "Do not put operational commentary or JSON in message.",
    "",
    `Rolling channel summary:\n${input.rollingSummary || "(none yet)"}`,
    "",
    `Recent messages before this turn:\n${previousContext || "(none)"}`,
    "",
    `New message batch:\n${newMessages}`,
  ].join("\n");
}

function parseResponse(raw: string): StructuredAgentResponse {
  const parsed = JSON.parse(raw) as Partial<StructuredAgentResponse>;
  if (
    !["reply", "react", "silent"].includes(parsed.disposition ?? "") ||
    typeof parsed.updatedSummary !== "string"
  ) {
    throw new Error("Codex returned an invalid structured response");
  }
  const response = {
    disposition: parsed.disposition as StructuredAgentResponse["disposition"],
    message: typeof parsed.message === "string" ? parsed.message : null,
    replyToMessageId:
      typeof parsed.replyToMessageId === "string"
        ? parsed.replyToMessageId
        : null,
    reaction: typeof parsed.reaction === "string" ? parsed.reaction : null,
    updatedSummary: parsed.updatedSummary.slice(0, 1_500),
  };
  if (response.disposition === "reply" && !response.message?.trim()) {
    throw new Error("Codex chose reply without supplying a message");
  }
  if (response.disposition === "react" && !response.reaction?.trim()) {
    throw new Error("Codex chose react without supplying an emoji");
  }
  return response;
}

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }

  return parts.join("\n").toLowerCase();
}

export function isUnusableCodexThreadError(error: unknown): boolean {
  const text = errorChainText(error);
  return (
    text.includes("thread/resume") &&
    (text.includes("failed to resolve rollout path") ||
      text.includes("file does not exist") ||
      text.includes("not found"))
  );
}

export class CodexRunner {
  private readonly codex: Codex;
  private readonly config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    const inheritedMoxnVariables = ["MOXN_WORKSPACE"];
    if (config.moxn.mcpToken) inheritedMoxnVariables.push("MOXN_TOKEN");
    if (config.moxn.baseUrl) inheritedMoxnVariables.push("MOXN_BASE_URL");
    if (config.moxn.vercelBypass) {
      inheritedMoxnVariables.push("MOXN_VERCEL_BYPASS");
    }

    this.codex = new Codex({
      env: createAgentEnvironment(config),
      config: {
        // This assistant needs only its explicit local CLI and optional Moxn
        // MCP server, not any Apps configured in the operator's Codex account.
        features: { apps: false },
        ...(config.moxn.mcpEnabled
          ? {
              mcp_servers: {
                moxn: {
                  command: process.execPath,
                  args: [config.moxn.mcpEntry],
                  env_vars: inheritedMoxnVariables,
                  required: true,
                  startup_timeout_sec: 30,
                  // The configured user deliberately grants this unattended
                  // assistant full Moxn access. It cannot surface an approval
                  // prompt through Discord and Temporal.
                  default_tools_approval_mode: "approve",
                },
              },
            }
          : {}),
      },
    });
  }

  async run(input: ProcessChannelTurnInput): Promise<AgentTurnResult> {
    const threadOptions = {
      ...(this.config.codex.model ? { model: this.config.codex.model } : {}),
      ...(this.config.codex.reasoningEffort
        ? { modelReasoningEffort: this.config.codex.reasoningEffort }
        : {}),
      workingDirectory: this.config.local.agentWorkspace,
      skipGitRepoCheck: true,
      sandboxMode: this.config.codex.sandboxMode,
      // The pinned Context CLI needs outbound access to Moxn. Web search is a
      // separate, explicit operator choice because retrieved pages are
      // untrusted input to an assistant with write access.
      networkAccessEnabled: true,
      webSearchMode: this.config.codex.webSearchMode,
      approvalPolicy: "never" as const,
    };
    let thread = input.codexThreadId
      ? this.codex.resumeThread(input.codexThreadId, threadOptions)
      : this.codex.startThread(threadOptions);

    const codexInput: UserInput[] = [
      { type: "text", text: buildAgentPrompt(input) },
    ];
    for (const message of input.messages) {
      for (const attachment of message.attachments) {
        if (
          attachment.localPath &&
          attachment.contentType?.startsWith("image/")
        ) {
          codexInput.push({ type: "local_image", path: attachment.localPath });
        }
      }
    }

    let turn;
    try {
      turn = await thread.run(codexInput, { outputSchema: responseSchema });
    } catch (error) {
      if (!input.codexThreadId || !isUnusableCodexThreadError(error)) {
        throw error;
      }

      // Thread rollout paths are local to CODEX_HOME. If an operator migrates
      // persistent agent state between a host and a container with a different
      // mount path, preserve the durable Discord context and begin a new Codex
      // thread instead of failing every subsequent channel turn.
      console.warn("Codex thread state is unavailable; starting a fresh thread");
      thread = this.codex.startThread(threadOptions);
      turn = await thread.run(codexInput, { outputSchema: responseSchema });
    }
    const response = parseResponse(turn.finalResponse);
    const threadId = thread.id;
    if (!threadId) throw new Error("Codex did not return a thread ID");

    const knownMessageIds = new Set(
      [...input.recentMessages, ...input.messages].map((message) => message.id),
    );
    if (
      response.replyToMessageId &&
      !knownMessageIds.has(response.replyToMessageId)
    ) {
      response.replyToMessageId = null;
    }

    return { ...response, codexThreadId: threadId };
  }
}
