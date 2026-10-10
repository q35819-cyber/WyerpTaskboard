#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { ServiceController } from "../server/service-control.mjs";
import { logCliError, logCliEvent } from "./cli-event-log.mjs";

const rootDir = process.env.WYERP_TASKBOARD_ROOT || "D:\\WyerpTaskboard";
const action = process.argv[2] || "status";

function launchGlobalControl() {
  if (process.platform !== "win32") return;
  const child = spawn("schtasks.exe", ["/Run", "/TN", "WyerpTaskboard-Global-Status"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquireServiceActionLock({ staleMs = 60_000 } = {}) {
  const runtimeDir = path.join(rootDir, "data", "runtime");
  const lockPath = path.join(runtimeDir, "service-action.lock");
  await fs.mkdir(runtimeDir, { recursive: true });
  const token = crypto.randomUUID();
  const payload = {
    version: 1,
    token,
    pid: process.pid,
    action,
    acquiredAt: new Date().toISOString()
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try { await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8"); }
      finally { await handle.close(); }
      return { lockPath, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(await fs.readFile(lockPath, "utf8")); }
      catch (lockReadError) {
        await logCliError(rootDir, "cli-service", "service_action_lock_read", lockReadError, { action, lock_path: lockPath });
      }
      const age = existing?.acquiredAt ? Date.now() - Date.parse(existing.acquiredAt) : Number.POSITIVE_INFINITY;
      const alive = await processAlive(Number(existing?.pid || 0));
      if ((!alive || age > staleMs) && attempt === 0) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      const busy = new Error("service action already in progress");
      busy.code = "SERVICE_ACTION_BUSY";
      busy.details = {
        action: existing?.action || null,
        pid: Number(existing?.pid || 0) || null,
        acquiredAt: existing?.acquiredAt || null
      };
      throw busy;
    }
  }
  throw new Error("failed to acquire service action lock");
}

async function releaseServiceActionLock(lock) {
  if (!lock?.lockPath || !lock?.token) return;
  let current = null;
  try { current = JSON.parse(await fs.readFile(lock.lockPath, "utf8")); }
  catch (lockReadError) {
    if (lockReadError?.code !== "ENOENT") {
      await logCliError(rootDir, "cli-service", "service_action_lock_release_read", lockReadError, { action, lock_path: lock.lockPath });
    }
  }
  if (!current || current.token === lock.token) {
    await fs.rm(lock.lockPath, { force: true }).catch(async removeError => {
      await logCliError(rootDir, "cli-service", "service_action_lock_remove", removeError, { action, lock_path: lock.lockPath });
    });
  }
}

if (action === "secret") {
  try {
    const config = JSON.parse(await fs.readFile(path.join(rootDir, "config", "admin-secret.json"), "utf8"));
    if (!config.adminSecret) throw new Error("admin-secret.json is invalid");
    console.log(config.adminSecret);
    process.exitCode = 0;
  } catch (error) {
    await logCliError(rootDir, "cli-service", "secret", error);
    console.error(JSON.stringify({ error: { code: error.code || "ERROR", message: error.message } }, null, 2));
    process.exitCode = 1;
  }
} else {
  const controller = new ServiceController(rootDir, {
    host: process.env.WYERP_TASKBOARD_HOST || "127.0.0.1",
    port: Number(process.env.WYERP_TASKBOARD_PORT || 47831),
  });
  let serviceActionLock = null;
  try {
    if (["start", "stop", "start-or-restart", "recover-instance"].includes(action)) {
      serviceActionLock = await acquireServiceActionLock();
    }
    const delayMs = Math.max(0, Number(process.env.WYERP_SERVICE_ACTION_DELAY_MS || 0));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    let result;
    if (action === "start") {
      result = await controller.start();
      launchGlobalControl();
    }
    else if (action === "stop") result = await controller.stop();
    else if (action === "status") result = await controller.status();
    else if (action === "recover-instance") result = await controller.recoverOrphanedInstance();
    else if (action === "start-or-restart") {
      const before = await controller.status();
      if (before.state === "running") await controller.stop();
      result = { action: before.state === "running" ? "restart" : "start", ...(await controller.start()) };
      launchGlobalControl();
    } else {
      throw new Error("usage: node cli/service.mjs <start|stop|start-or-restart|status|recover-instance|secret>");
    }
    console.log(JSON.stringify(result, null, 2));
    await logCliEvent(rootDir, "cli-service", "service_action_succeeded", {
      action,
      state: result?.state || null,
      pid: result?.instance?.pid || result?.pid || null
    });
    process.exitCode = 0;
  } catch (error) {
    await logCliError(rootDir, "cli-service", action, error, { action });
    console.error(JSON.stringify({ error: { code: error.code || "ERROR", message: error.message, details: error.details || null } }, null, 2));
    process.exitCode = 1;
  } finally {
    await releaseServiceActionLock(serviceActionLock);
  }
}
