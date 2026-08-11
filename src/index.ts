import { access } from "node:fs/promises";
import { Client } from "@temporalio/client";
import { config as loadDotenv } from "dotenv";
import { createActivities } from "./activities.js";
import { CodexRunner } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { createDiscordClient, DiscordGateway } from "./discord-gateway.js";
import { prepareLocalState } from "./local-state.js";
import { createTemporalRuntime } from "./temporal-runtime.js";

loadDotenv({ path: process.env.AGENT_ENV_FILE?.trim() || ".env" });

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.moxn.mcpEnabled) await access(config.moxn.mcpEntry);
  await prepareLocalState(config);

  const discord = createDiscordClient();
  const codex = new CodexRunner(config);

  // Activities need the Discord client and Codex runner; the gateway gets the
  // Temporal client after both Cloud connections have been established.
  const temporal = await createTemporalRuntime(
    config,
    createActivities(discord, codex),
  );
  const gateway = new DiscordGateway(
    discord,
    temporal.client as Client,
    config,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info("Shutting down local Discord agent...");
    discord.destroy();
    if (temporal.worker.getState() === "RUNNING") {
      temporal.worker.shutdown();
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  let workerRun: Promise<void> | undefined;
  try {
    // Connect Discord and complete its channel/backfill checks before polling
    // Temporal. Otherwise an already queued turn can reach an Activity while
    // Discord.js is still identifying and its channel cache is unavailable.
    await gateway.start();
    workerRun = temporal.worker.run();
    await workerRun;
  } finally {
    discord.destroy();
    if (temporal.worker.getState() === "RUNNING") {
      temporal.worker.shutdown();
    }
    await workerRun?.catch(() => undefined);
    await temporal.close();
  }
}

main().catch((error: unknown) => {
  console.error("Discord agent failed", error);
  process.exitCode = 1;
});
