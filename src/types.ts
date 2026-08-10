export type DiscordDisposition = "reply" | "react" | "silent";

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

export interface ChannelWorkflowInput {
  guildId: string;
  channelId: string;
  initialLastSeenMessageId: string | null;
  codexThreadId: string | null;
  rollingSummary: string;
  recentMessages: DiscordChannelMessage[];
  processedTurns: number;
  debounceMs: number;
}

export interface ChannelWorkflowState {
  guildId: string;
  channelId: string;
  lastSeenMessageId: string | null;
  codexThreadId: string | null;
  rollingSummary: string;
  recentMessages: DiscordChannelMessage[];
  queuedMessages: number;
  processedTurns: number;
}

export interface ProcessChannelTurnInput {
  guildId: string;
  channelId: string;
  messages: DiscordChannelMessage[];
  recentMessages: DiscordChannelMessage[];
  rollingSummary: string;
  codexThreadId: string | null;
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
