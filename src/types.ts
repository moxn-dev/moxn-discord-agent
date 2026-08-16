export type DiscordDisposition = "reply" | "react" | "silent";
export type AgentSessionType = "main" | "task" | "fork";

export interface StoredAttachment {
  id: string;
  filename: string;
  contentType: string | null;
  size: number;
  localPath: string | null;
  downloadError: string | null;
}

export interface DiscordChannelMessage {
  id: string;
  guildId: string;
  channelId: string;
  /** Parent channel for thread messages; absent on legacy Temporal payloads. */
  parentChannelId?: string | null;
  authorId: string;
  authorName: string;
  /** Optional for compatibility with messages already stored in Temporal. */
  authorIsBot?: boolean;
  content: string;
  createdAt: string;
  mentionedBot: boolean;
  replyToMessageId: string | null;
  attachments: StoredAttachment[];
}

export interface ForkContextSnapshot {
  sourceSessionId: string;
  sourceRevision: number;
  capturedAt: string;
  rollingSummary: string;
  recentMessages: DiscordChannelMessage[];
}

export interface ChannelWorkflowInput {
  guildId: string;
  channelId: string;
  /** Optional for replay compatibility with the original single-session workflow. */
  parentChannelId?: string;
  /** Stable application session key: `main` or a Discord thread snowflake. */
  sessionId?: string;
  /** Optional for replay compatibility; legacy workflows are the main session. */
  sessionType?: AgentSessionType;
  initialLastSeenMessageId: string | null;
  codexThreadId: string | null;
  rollingSummary: string;
  recentMessages: DiscordChannelMessage[];
  processedTurns: number;
  contextRevision?: number;
  forkContext?: ForkContextSnapshot | null;
  debounceMs: number;
}

export interface ChannelWorkflowState {
  guildId: string;
  channelId: string;
  parentChannelId: string;
  sessionId: string;
  sessionType: AgentSessionType;
  lastSeenMessageId: string | null;
  codexThreadId: string | null;
  rollingSummary: string;
  recentMessages: DiscordChannelMessage[];
  queuedMessages: number;
  processedTurns: number;
  contextRevision: number;
  sourceSessionId: string | null;
  sourceRevision: number | null;
  forkedAt: string | null;
}

export interface ProcessChannelTurnInput {
  guildId: string;
  channelId: string;
  /** Optional while an original single-session Workflow history drains. */
  parentChannelId?: string;
  sessionId?: string;
  sessionType?: AgentSessionType;
  messages: DiscordChannelMessage[];
  recentMessages: DiscordChannelMessage[];
  rollingSummary: string;
  codexThreadId: string | null;
  forkContext?: ForkContextSnapshot | null;
}

export interface AgentTurnResult {
  disposition: DiscordDisposition;
  message: string | null;
  replyToMessageId: string | null;
  reaction: string | null;
  updatedSummary: string;
  codexThreadId: string;
}

export interface DeliverDiscordActionInput {
  channelId: string;
  triggeringMessageId: string;
  action: AgentTurnResult;
}

export interface SessionRegistryEntry {
  sessionId: string;
  sessionType: AgentSessionType;
  discordChannelId: string;
  temporalWorkflowId: string;
  status: "open" | "closed";
  createdAt: string;
  lastActiveAt: string;
  sourceSessionId: string | null;
  sourceRevision: number | null;
  forkedAt: string | null;
}

export interface ChannelRegistryInput {
  guildId: string;
  channelId: string;
  lastSeenMessageId: string | null;
  sessions: SessionRegistryEntry[];
  eventsSinceContinueAsNew: number;
}

export interface ChannelRegistryState {
  guildId: string;
  channelId: string;
  lastSeenMessageId: string | null;
  sessions: SessionRegistryEntry[];
}
