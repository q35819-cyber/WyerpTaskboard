import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { listenTaskboard } from "./http-server.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { TaskScanLoop } from "./task-scan-loop.mjs";
import { SystemEventLog } from "./system-event-log.mjs";
import { installTemporaryTestServiceLease } from "./test-instance-lease.mjs";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else out[arg.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.root || "D:\\WyerpTaskboard");
const host = args.host || "127.0.0.1";
const port = Number(args.port || 47831);
const instanceToken = args["instance-token"];
const instanceFile = path.resolve(args["instance-file"] || path.join(rootDir, "data", "runtime", "instance.json"));
const systemEventLog = await new SystemEventLog(rootDir).init();

if (!instanceToken || !Number.isInteger(port) || port < 1 || port > 65535) {
  await systemEventLog.append({ level: "critical", component: "service", event: "startup_arguments_invalid", error_code: "INVALID_STARTUP_ARGUMENTS", details: { host, port, instance_token_present: Boolean(instanceToken) } });
  console.error("invalid startup arguments");
  process.exit(2);
}

async function hardenProjectConfig() {
  if (process.platform !== "win32") return;
  const script = path.join(rootDir, "scripts", "harden-config-acl.ps1");
  const configPath = path.join(rootDir, "config", "projects.json");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-PathValue", configPath,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
}

await hardenProjectConfig();
let app;
let scanLoop;
let stopping = false;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  try {
    const current = JSON.parse(await fs.readFile(instanceFile, "utf8"));
    if (current.pid === process.pid && current.instanceToken === instanceToken) {
      await fs.rm(instanceFile, { force: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await systemEventLog.error("service", "instance_cleanup_failed", error, { instance_file: instanceFile, pid: process.pid });
    }
  }
}

async function shutdown() {
  scanLoop?.stop();
  if (app?.server?.listening) {
    await new Promise((resolve) => app.server.close(resolve));
  }
  await cleanup();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", async (error) => {
  await systemEventLog.error("service", "uncaught_exception", error, { phase: "runtime" });
  console.error(error?.stack || error);
  await cleanup();
  process.exit(1);
});
process.on("unhandledRejection", async (error) => {
  await systemEventLog.error("service", "unhandled_rejection", error, { phase: "runtime" });
  console.error(error?.stack || error);
  await cleanup();
  process.exit(1);
});

app = await listenTaskboard({ rootDir, host, port });
await atomicWriteJson(instanceFile, {
  version: 1,
  pid: process.pid,
  host,
  port,
  rootDir,
  entryPath: path.resolve(process.argv[1]),
  nodeExecutable: process.execPath,
  instanceToken,
  startedAt: new Date().toISOString(),
});
console.log(`WyerpTaskboard listening on http://${host}:${port}`);
await systemEventLog.append({ component: "service", event: "service_listening", result: "running", details: { host, port, pid: process.pid } });
try {
  scanLoop = await new TaskScanLoop(rootDir, {
    systemEventLog,
    onError: (error) => {
      console.error("task-scan loop failed:", error?.message || error);
    }
  }).start();
  console.log("task-scan loop started: idle=10s, busy=10m, rearm<=1s");
  await systemEventLog.append({ component: "task-scan-loop", event: "loop_started", details: { idle_seconds: 10, busy_minutes: 10, rearm_seconds_max: 1 } });
} catch (error) {
  console.error("startup task-scan loop failed; service continues:", error?.message || error);
  await systemEventLog.error("task-scan-loop", "startup_failed", error, { service_continues: true });
}

installTemporaryTestServiceLease({
  instanceFile, port,
  shutdown: async () => {
    // Test fixtures alone expire; a short fallback prevents a hanging socket
    // from keeping a detached WMI-launched test instance alive indefinitely.
    const forceExit = setTimeout(() => process.exit(0), 15000);
    forceExit.unref();
    await systemEventLog.append({ component: "service", event: "test_fixture_lease_expired", details: { port } });
    await shutdown();
  }
});