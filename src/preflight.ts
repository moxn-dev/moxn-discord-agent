import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Connection } from "@temporalio/client";
import { REST, Routes } from "discord.js";
import { config as loadDotenv } from "dotenv";
import { createAgentEnvironment } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { prepareLocalState } from "./local-state.js";

const execFileAsync = promisify(execFile);

loadDotenv({ path: process.env.AGENT_ENV_FILE?.trim() || ".env" });

interface DiscordIdentity {
  id: string;
  username?: string;
}

interface DiscordChannel {
  id: string;
  guild_id?: string;
  name?: string;
}

async function checkDiscord(config: ReturnType<typeof loadConfig>) {
  const rest = new REST({ version: "10" }).setToken(config.discord.botToken);
  const [identity, channel] = await Promise.all([
    rest.get(Routes.user()) as Promise<DiscordIdentity>,
    rest.get(Routes.channel(config.discord.channelId)) as Promise<DiscordChannel>,
  ]);
  if (channel.guild_id !== config.discord.guildId) {
    throw new Error("Configured Discord channel does not belong to the guild");
  }
  console.info(
    `PASS Discord: ${identity.username ?? identity.id}; #${channel.name ?? channel.id}`,
  );
}

async function checkTemporal(config: ReturnType<typeof loadConfig>) {
  const connection = await Connection.connect({
    address: config.temporal.address,
    tls: true,
    apiKey: config.temporal.apiKey,
  });
  try {
    await connection.workflowService.describeNamespace({
      namespace: config.temporal.namespace,
    });
    console.info(`PASS Temporal: ${config.temporal.namespace}`);
  } finally {
    await connection.close();
  }
}

async function checkMoxn(config: ReturnType<typeof loadConfig>) {
  const { stdout } = await execFileAsync(
    config.moxn.contextCliBin,
    ["--format", "json", "filesystems"],
    {
      env: createAgentEnvironment(config),
      timeout: 30_000,
      maxBuffer: 1_000_000,
    },
  );
  const parsed = JSON.parse(stdout) as
    | unknown[]
    | { filesystems?: unknown[]; items?: unknown[] };
  const filesystems = Array.isArray(parsed)
    ? parsed
    : parsed.filesystems || parsed.items || [];
  console.info(`PASS Moxn: Context CLI; ${filesystems.length} filesystem(s)`);
}

async function main() {
  const config = loadConfig();
  await prepareLocalState(config);
  await checkDiscord(config);
  await checkTemporal(config);
  await checkMoxn(config);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Preflight failed: ${message}`);
  process.exitCode = 1;
});
