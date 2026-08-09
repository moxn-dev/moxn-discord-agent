import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

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

  it("rejects ambiguous boolean configuration", () => {
    vi.stubEnv("MOXN_MCP_ENABLED", "sometimes");
    expect(() => loadConfig()).toThrow(/must be true or false/);
  });

  it("requires the Context CLI API key", () => {
    vi.stubEnv("MOXN_API_KEY", "");
    expect(() => loadConfig()).toThrow(/MOXN_API_KEY/);
  });
});
