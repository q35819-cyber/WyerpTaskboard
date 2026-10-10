#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChatgptHealthMonitor } from "../server/chatgpt-health-monitor.mjs";
import { logCliError } from "./cli-event-log.mjs";

const ROOT = process.env.WYERP_TASKBOARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] || "check";
const logPath = path.join(ROOT, "data", "runtime", "chatgpt-health", "last-run.log");

try {
  const monitor = await new ChatgptHealthMonitor(ROOT).init();
  let result;
  if (command === "check") result = await monitor.check();
  else if (command === "status") result = await monitor.status();
  else if (command === "help") result = {
    commands: ["chatgpt-health check", "chatgpt-health status"],
    schedule: "WyerpTaskboard-ChatGPT-MCP-Health"
  };
  else throw new Error("unknown command: " + command);
  const output = JSON.stringify(result, null, 2) + "\n";
  if (command === "check") {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, output, "utf8");
  }
  process.stdout.write(output);
} catch (error) {
  await logCliError(ROOT, "cli-chatgpt-health", command, error, { command });
  const output = JSON.stringify({ error: {
    code: error.code || "ERROR",
    message: error.message
  } }, null, 2) + "\n";
  if (command === "check") {
    try {
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, output, "utf8");
    } catch (logWriteError) {
      await logCliError(ROOT, "cli-chatgpt-health", "last_run_log_write", logWriteError, { log_path: logPath });
    }
  }
  process.stderr.write(output);
  process.exitCode = 1;
}
