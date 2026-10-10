#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskboardRuntimeStatus } from "../server/runtime-status.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { logCliError } from "./cli-event-log.mjs";

const ROOT = process.env.WYERP_TASKBOARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const taskStore = await new TaskStore(ROOT).init();
  const result = await new TaskboardRuntimeStatus(ROOT, { taskStore }).snapshot();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  await logCliError(ROOT, "cli-runtime-status", "snapshot", error);
  process.stderr.write(JSON.stringify({ error: {
    code: error.code || "ERROR",
    message: error.message
  } }, null, 2) + "\n");
  process.exitCode = 1;
}
