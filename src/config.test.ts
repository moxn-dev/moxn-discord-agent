import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadConfig,
  registryWorkflowIdForChannel,
  workflowIdForChannel,
  workflowIdForThreadSession,
} from "./config.js";

const requiredEnvironment = {
  DISCORD_BOT_TOKEN: "discord-test-token",
  DISCORD_GUILD_ID: "100",
  DISCORD_CHANNEL_ID: "200",
  DISCORD_ALLOWED_USER_ID: "300",
  TEMPORAL_ADDRESS: "example.tmprl.cloud:7233",
  TEMPORAL_NAMESPACE: "example.namespace",
  TEMPORAL_API_KEY: "temporal-test-token",
  MOXN_WORKSPACE: "example-workspace",
  MOXN_API_KEY: "example-moxn-token",
};

describe("configuration", () => {
  beforeEach(() => {
    for (const [name, value] of Object.entries(requiredEnvironment)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("MOXN_MCP_ENABLED", "");
    vi.stubEnv("DISCORD_ALLOW_ALL_USERS", "");
    vi.stubEnv("DISCORD_ALLOWED_BOT_IDS", "");
    vi.stubEnv("CODEX_MODEL", "");
    vi.stubEnv("CODEX_REASONING_EFFORT", "");
    vi.stubEnv("CODEX_SANDBOX_MODE", "");
    vi.stubEnv("CODEX_WEB_SEARCH_MODE", "");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("AGENT_MAX_CONCURRENT_ACTIVITIES", "");
    vi.stubEnv("AGENT_DATA_DIR", "/tmp/moxn-discord-agent-test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("uses the CLI by default and resolves published package executables", () => {
    const config = loadConfig();
    expect(config.moxn.mcpEnabled).toBe(false);
    expect(config.moxn.contextCliBin).toContain("node_modules/.bin/context");
    expect(config.moxn.mcpEntry).toContain("node_modules/@moxn/mcp-kb");
  });

  it("accepts an explicit MCP opt-in", () => {
    vi.stubEnv("MOXN_MCP_ENABLED", "true");
    expect(loadConfig().moxn.mcpEnabled).toBe(true);
  });

  it("accepts explicit Codex model and reasoning settings", () => {
    vi.stubEnv("CODEX_MODEL", "gpt-5.6-terra");
    vi.stubEnv("CODEX_REASONING_EFFORT", "high");
    expect(loadConfig().codex).toEqual({
      model: "gpt-5.6-terra",
      reasoningEffort: "high",
      sandboxMode: "workspace-write",
      webSearchMode: "disabled",
    });
  });

  it("rejects an unsupported Codex reasoning setting", () => {
    vi.stubEnv("CODEX_REASONING_EFFORT", "extreme");
    expect(() => loadConfig()).toThrow(/CODEX_REASONING_EFFORT/);
  });

  it("accepts an explicit Codex sandbox mode", () => {
    vi.stubEnv("CODEX_SANDBOX_MODE", "danger-full-access");
    expect(loadConfig().codex.sandboxMode).toBe("danger-full-access");
  });

  it("rejects an unsupported Codex sandbox mode", () => {
    vi.stubEnv("CODEX_SANDBOX_MODE", "container");
    expect(() => loadConfig()).toThrow(/CODEX_SANDBOX_MODE/);
  });

  it("accepts an explicit Codex web search mode", () => {
    vi.stubEnv("CODEX_WEB_SEARCH_MODE", "live");
    expect(loadConfig().codex.webSearchMode).toBe("live");
  });

  it("rejects an unsupported Codex web search mode", () => {
    vi.stubEnv("CODEX_WEB_SEARCH_MODE", "indexed");
    expect(() => loadConfig()).toThrow(/CODEX_WEB_SEARCH_MODE/);
  });

  it("limits concurrent Temporal activities to four by default", () => {
    expect(loadConfig().temporal.maxConcurrentActivities).toBe(4);
  });

  it("accepts an explicit positive Temporal activity limit", () => {
    vi.stubEnv("AGENT_MAX_CONCURRENT_ACTIVITIES", "3");
    expect(loadConfig().temporal.maxConcurrentActivities).toBe(3);
  });

  it("rejects an invalid Temporal activity limit", () => {
    vi.stubEnv("AGENT_MAX_CONCURRENT_ACTIVITIES", "0");
    expect(() => loadConfig()).toThrow(/AGENT_MAX_CONCURRENT_ACTIVITIES/);
  });

  it("derives all private runtime paths from a provider-mounted data path", () => {
    vi.stubEnv("AGENT_DATA_DIR", "/mnt/persistent/alpha");
    vi.stubEnv("AGENT_WORKSPACE", "");
    const config = loadConfig();
    expect(config.local.dataDirectory).toBe("/mnt/persistent/alpha");
    expect(config.local.codexHome).toBe("/mnt/persistent/alpha/codex");
    expect(config.local.agentWorkspace).toBe(
      "/mnt/persistent/alpha/workspace",
    );
  });

  it("honors an explicit persistent Codex home", () => {
    vi.stubEnv("CODEX_HOME", "/mnt/persistent/codex-home");
    expect(loadConfig().local.codexHome).toBe(
      "/mnt/persistent/codex-home",
    );
  });

  it("supports a channel-wide Discord allow-list without a user ID", () => {
    vi.stubEnv("DISCORD_ALLOW_ALL_USERS", "true");
    vi.stubEnv("DISCORD_ALLOWED_USER_ID", "");
    const config = loadConfig();
    expect(config.discord.allowAllUsers).toBe(true);
    expect(config.discord.allowedUserId).toBeUndefined();
  });

  it("parses an explicit Discord bot allow-list", () => {
    vi.stubEnv("DISCORD_ALLOWED_BOT_IDS", "400, 401,400");
    expect(loadConfig().discord.allowedBotIds).toEqual(["400", "401"]);
  });

  it("rejects an invalid Discord bot allow-list", () => {
    vi.stubEnv("DISCORD_ALLOWED_BOT_IDS", "400,snow");
    expect(() => loadConfig()).toThrow(/DISCORD_ALLOWED_BOT_IDS/);
  });

  it("rejects ambiguous boolean configuration", () => {
    vi.stubEnv("MOXN_MCP_ENABLED", "sometimes");
    expect(() => loadConfig()).toThrow(/must be true or false/);
  });

  it("requires the Context CLI API key", () => {
    vi.stubEnv("MOXN_API_KEY", "");
    expect(() => loadConfig()).toThrow(/MOXN_API_KEY/);
  });

  it("uses stable, distinct Workflow IDs for the registry and sessions", () => {
    expect(workflowIdForChannel("200")).toBe("moxn-discord-channel-200");
    expect(registryWorkflowIdForChannel("200")).toBe(
      "moxn-discord-registry-200",
    );
    expect(workflowIdForThreadSession("200", "201")).toBe(
      "moxn-discord-channel-200-thread-201",
    );
  });
});
