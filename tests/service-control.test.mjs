import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ServiceController } from "../server/service-control.mjs";

const root = "D:\\WyerpTaskboard";
const testRuntime = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-taskboard-service-control-"));
const instancePath = path.join(testRuntime, "instance.json");

function controllerFor(port, options = {}) {
  const controller = new ServiceController(root, { port, ...options });
  controller.instanceFile = instancePath;
  return controller;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForListener(controller, pid, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const q = await controller.queryListener(controller.port);
    if (q.pids.includes(pid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("listener timeout");
}
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function killChild(child) {
  if (!child || !isAlive(child.pid)) return;
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => killer.once("exit", resolve));
}

test("query-process returns CommandLineToArgvW argv for current node process", async () => {
  const controller = controllerFor(await freePort());
  const proc = await controller.queryProcess(process.pid);
  assert.equal(proc.exists, true);
  assert.equal(proc.pid, process.pid);
  assert.ok(proc.argv.length >= 2);
  assert.match(path.basename(proc.executablePath).toLowerCase(), /^node\.exe$/);
});

test("other Node occupying port is never killed", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", `require('net').createServer().listen(${port},'127.0.0.1');setInterval(()=>{},1000)`], {
    windowsHide: true, stdio: "ignore",
  });
  t.after(() => killChild(child));
  const controller = controllerFor(port);
  await waitForListener(controller, child.pid);
  await fs.rm(instancePath, { force: true });
  const state = await controller.status();
  assert.equal(state.state, "port_conflict");
  await assert.rejects(controller.stop(), (error) => error.code === "PROCESS_IDENTITY_MISMATCH");
  assert.equal(isAlive(child.pid), true);
});

test("non-Node process occupying port is never killed", async (t) => {
  const port = await freePort();
  const command = `$l=[System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback,${port});$l.Start();while($true){Start-Sleep -Seconds 1}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true, stdio: "ignore",
  });
  t.after(() => killChild(child));
  const controller = controllerFor(port);
  await waitForListener(controller, child.pid);
  await fs.rm(instancePath, { force: true });
  const state = await controller.status();
  assert.equal(state.state, "port_conflict");
  await assert.rejects(controller.stop(), (error) => error.code === "PROCESS_IDENTITY_MISMATCH");
  assert.equal(isAlive(child.pid), true);
});

test("stale PID metadata pointing at another live process is never killed", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  t.after(() => killChild(child));
  await new Promise((r) => setTimeout(r, 200));
  const controller = controllerFor(port);
  await fs.writeFile(instancePath, JSON.stringify({
    version: 1,
    pid: child.pid,
    host: "127.0.0.1",
    port,
    rootDir: root,
    entryPath: path.join(root, "server", "main.mjs"),
    nodeExecutable: process.execPath,
    instanceToken: "stale-token",
    startedAt: new Date().toISOString(),
  }), "utf8");
  const state = await controller.status();
  assert.equal(state.state, "identity_mismatch");
  await assert.rejects(controller.stop(), (error) => error.code === "PROCESS_IDENTITY_MISMATCH");
  assert.equal(isAlive(child.pid), true);
  await fs.rm(instancePath, { force: true });
});

test("Windows service process is created hidden", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "create-service-process.ps1"), "utf8");
  assert.match(source, /\[wmiclass\]'Win32_ProcessStartup'/);
  assert.match(source, /ShowWindow = 0/);
  assert.match(source, /\[wmiclass\]'Win32_Process'/);
  assert.match(source, /\.Create\(\$commandLine, \$RootDir, \$startup\)/);
});

test("service startup owns the adaptive task-scan loop independent of Windows scheduler state", async () => {
  const source = await fs.readFile(path.join(root, "server", "main.mjs"), "utf8");
  assert.match(source, /TaskScanLoop/);
  assert.match(source, /new TaskScanLoop\(rootDir,\s*\{/);
  assert.match(source, /systemEventLog/);
  assert.match(source, /\}\)\.start\(\)/);
  assert.match(source, /scanLoop\?\.stop\(\)/);
  assert.match(source, /idle=10s, busy=10m, rearm<=1s/);
  assert.doesNotMatch(source, /task-scan-schedule-status\.ps1/);
});

test("strict controller starts, verifies and stops genuine taskboard process", async () => {
  const port = await freePort();
  await fs.rm(instancePath, { force: true });
  const controller = controllerFor(port);
  const started = await controller.start({ timeoutMs: 10000 });
  try {
    assert.equal(started.state, "running");
    assert.equal(started.identity.ok, true);
    assert.equal(started.instance.port, port);
    const status = await controller.status();
    assert.equal(status.state, "running");
    assert.equal(status.identity.ok, true);
  } finally {
    const stopped = await controller.stop({ timeoutMs: 10000 });
    assert.equal(stopped.state, "stopped");
  }
  assert.equal((await controller.status()).state, "stopped");
});


test("recover-instance rebuilds metadata only for a fully matching orphaned taskboard process", async () => {
  const port = await freePort();
  await fs.rm(instancePath, { force: true });
  const controller = controllerFor(port);
  const token = "abcdefghijklmnopqrstuvwxyz123456";
  const pid = 424242;
  controller.listenerQuery = async () => ({ port, pids: [pid] });
  controller.processQuery = async () => ({
    exists: true,
    pid,
    executablePath: process.execPath,
    argv: [
      process.execPath,
      controller.entryPath,
      "--root", controller.rootDir,
      "--host", controller.host,
      "--port", String(port),
      "--instance-token", token,
      "--instance-file", controller.instanceFile,
    ],
  });
  const recovered = await controller.recoverOrphanedInstance();
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.state, "running");
  assert.equal(recovered.identity.ok, true);
  const persisted = JSON.parse(await fs.readFile(instancePath, "utf8"));
  assert.equal(persisted.pid, pid);
  assert.equal(persisted.instanceToken, token);
  assert.equal(persisted.recoveryReason, "instance_metadata_missing");
  await fs.rm(instancePath, { force: true });
});

test("recover-instance refuses a Node listener whose argv does not identify B-10", async () => {
  const port = await freePort();
  await fs.rm(instancePath, { force: true });
  const controller = controllerFor(port);
  const pid = 434343;
  controller.listenerQuery = async () => ({ port, pids: [pid] });
  controller.processQuery = async () => ({
    exists: true,
    pid,
    executablePath: process.execPath,
    argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
  });
  await assert.rejects(
    controller.recoverOrphanedInstance(),
    (error) => error.code === "ORPHAN_IDENTITY_MISMATCH"
  );
  await assert.rejects(fs.stat(instancePath), (error) => error.code === "ENOENT");
});
