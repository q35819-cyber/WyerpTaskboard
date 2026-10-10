#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ManualWindowsMcpClient } from "../server/manual-windows-mcp-client.mjs";
import { logCliError } from "./cli-event-log.mjs";

const ROOT = process.env.WYERP_TASKBOARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const command = argv[0] || "status";

function value(name, fallback = null) {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] != null ? argv[i + 1] : fallback;
}
function out(result) { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); }

try {
  const client = await new ManualWindowsMcpClient(ROOT).init();
  if (command === "status") out(await client.status());
  else if (command === "list-tools") out(await client.listTools());
  else if (command === "snapshot") {
    out(await client.callTool("Snapshot", {
      use_vision: value("vision", "false") === "true",
      use_dom: value("dom", "false") === "true",
      use_annotation: value("annotation", "true") !== "false",
      use_ui_tree: value("ui-tree", "true") !== "false"
    }));
  } else if (command === "call") {
    const tool = value("tool");
    if (!tool) throw new Error("missing --tool");
    let args = {};
    try { args = JSON.parse(value("args", "{}")); }
    catch { throw new Error("--args must be JSON"); }
    out(await client.callTool(tool, args));
  } else if (command === "help") {
    out({
      mode: "manual_only",
      commands: [
        "manual-windows-mcp status",
        "manual-windows-mcp list-tools",
        "manual-windows-mcp snapshot [--vision true] [--dom true]",
        "manual-windows-mcp call --tool Snapshot --args '{}'"
      ],
      safety: "仅显式调用时创建临时stdio会话；不连接task-scan、Chat Wake、ChatGPT健康监控或无人值守。"
    });
  } else throw new Error("unknown command: " + command);
} catch (error) {
  await logCliError(ROOT, "cli-manual-windows-mcp", command, error, { command });
  process.stderr.write(JSON.stringify({ error: {
    code: error.code || "ERROR",
    message: error.message,
    details: error.details || null
  } }, null, 2) + "\n");
  process.exitCode = 1;
}
