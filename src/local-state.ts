import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "./config.js";

export async function prepareLocalState(config: AgentConfig): Promise<void> {
  await access(config.moxn.contextCliBin, constants.X_OK).catch(() => {
    throw new Error(
      `Moxn Context CLI is not installed at ${config.moxn.contextCliBin}; run npm install`,
    );
  });

  await mkdir(config.local.dataDirectory, { recursive: true, mode: 0o700 });
  await mkdir(config.local.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(config.local.agentWorkspace, { recursive: true, mode: 0o700 });
  await mkdir(join(config.local.dataDirectory, "inbox"), {
    recursive: true,
    mode: 0o700,
  });

  await Promise.all([
    chmod(config.local.dataDirectory, 0o700),
    chmod(config.local.codexHome, 0o700),
    chmod(config.local.agentWorkspace, 0o700),
  ]);

  // The checked-in file is the editable persona; the runtime copy keeps Codex
  // rooted outside the Moxn source tree.
  await copyFile(
    config.local.personaTemplate,
    join(config.local.agentWorkspace, "AGENTS.md"),
  );
}
