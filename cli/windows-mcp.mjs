#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WindowsMcpClient } from "../server/windows-mcp-client.mjs";
import { AutomationControlStore } from "../server/automation-control.mjs";
import { logCliError } from "./cli-event-log.mjs";

const ROOT = process.env.WYERP_TASKBOARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const command = argv[0] || "status";

function value(name, fallback = null) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}
function out(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }

try {
  const automationControl = await new AutomationControlStore(ROOT).init({ resetLifecycle: false });
  const client = await new WindowsMcpClient(ROOT, { automationControl }).init();
  if (command === "status") out(await client.status());
  else if (command === "list-tools") out(await client.listTools());
  else if (command === "smoke") out(await client.smokeCursorControl());
  else if (command === "call") {
    const tool = value("tool");
    if (!tool) throw new Error("missing --tool");
    let args = {};
    const raw = value("args", "{}");
    try { args = JSON.parse(raw); } catch { throw new Error("--args must be JSON"); }
    out(await client.callTool(tool, args));
  } else if (command === "help") {
    out({ commands: [
      "windows-mcp status",
      "windows-mcp list-tools",
      "windows-mcp smoke",
      "windows-mcp call --tool Snapshot --args '{}'"
    ], security: "Only tools in config/windows-mcp.json allowed_tools can be invoked." });
  } else throw new Error("unknown command: " + command);
} catch (error) {
  await logCliError(ROOT, "cli-windows-mcp", command, error, { command });
  process.stderr.write(JSON.stringify({ error: {
    code: error.code || "ERROR",
    message: error.message,
    details: error.details || null
  } }, null, 2) + "\n");
  process.exitCode = 1;
}
