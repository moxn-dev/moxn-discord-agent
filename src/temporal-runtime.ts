import { Client, Connection } from "@temporalio/client";
import {
  NativeConnection,
  Worker,
  type WorkerOptions,
} from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./config.js";
import type { AgentActivities } from "./activities.js";
import {
  WORKER_SHUTDOWN_FORCE_TIME,
  WORKER_SHUTDOWN_GRACE_TIME,
} from "./temporal-lifecycle.js";

export interface TemporalRuntime {
  client: Client;
  worker: Worker;
  close(): Promise<void>;
}

export function createWorkerOptions(
  config: AgentConfig,
  activities: AgentActivities,
  connection: NativeConnection,
): WorkerOptions {
  return {
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    workflowsPath: fileURLToPath(
      new URL("./workflows/channel-session.js", import.meta.url),
    ),
    activities,
    shutdownGraceTime: WORKER_SHUTDOWN_GRACE_TIME,
    shutdownForceTime: WORKER_SHUTDOWN_FORCE_TIME,
  };
}

export async function createTemporalRuntime(
  config: AgentConfig,
  activities: AgentActivities,
): Promise<TemporalRuntime> {
  const connectionOptions = {
    address: config.temporal.address,
    tls: true,
    apiKey: config.temporal.apiKey,
  } as const;
  const [clientConnection, workerConnection] = await Promise.all([
    Connection.connect(connectionOptions),
    NativeConnection.connect(connectionOptions),
  ]);
  const client = new Client({
    connection: clientConnection,
    namespace: config.temporal.namespace,
  });
  const worker = await Worker.create(
    createWorkerOptions(config, activities, workerConnection),
  );

  return {
    client,
    worker,
    async close() {
      if (worker.getState() === "RUNNING") worker.shutdown();
      await Promise.allSettled([
        workerConnection.close(),
        clientConnection.close(),
      ]);
    },
  };
}
