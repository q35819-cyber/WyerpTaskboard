import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function runServiceCli(root, action, { port = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("cli/service.mjs"), action], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        WYERP_TASKBOARD_ROOT: root,
        ...(port ? { WYERP_TASKBOARD_PORT: String(port) } : {})
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("exit", code => resolve({ code, stdout, stderr }));
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("service mutation refuses a concurrent live action lock", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-service-lock-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "data", "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "service-action.lock"), JSON.stringify({
    version: 1,
    token: "held-by-test",
    pid: process.pid,
    action: "start-or-restart",
    acquiredAt: new Date().toISOString()
  }));

  const result = await runServiceCli(root, "start");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SERVICE_ACTION_BUSY/);
  assert.match(result.stderr, /start-or-restart/);
});

test("service status remains readable while a mutation lock is held", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-service-lock-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "data", "runtime");
  const scriptsDir = path.join(root, "scripts");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.copyFile(
    path.resolve("scripts/query-listener.ps1"),
    path.join(scriptsDir, "query-listener.ps1")
  );
  await fs.writeFile(path.join(runtimeDir, "service-action.lock"), JSON.stringify({
    version: 1,
    token: "held-by-test",
    pid: process.pid,
    action: "start-or-restart",
    acquiredAt: new Date().toISOString()
  }));

  const result = await runServiceCli(root, "status", { port: await freePort() });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /"state": "stopped"/);
});
