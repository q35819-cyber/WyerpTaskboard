import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);
const WINDOWS = process.platform === "win32";

function norm(p) {
  if (!p) return "";
  const x = path.resolve(String(p));
  return WINDOWS ? x.toLowerCase() : x;
}
function argValue(argv, key) {
  const exact = `--${key}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === exact) return argv[i + 1];
    if (argv[i]?.startsWith(exact + "=")) return argv[i].slice(exact.length + 1);
  }
  return undefined;
}
async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class ServiceController {
  constructor(rootDir, {
    host = "127.0.0.1",
    port = 47831,
    powershell = "powershell.exe",
    processQuery = null,
    listenerQuery = null,
    systemEventLog = null,
  } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.host = host;
    this.port = port;
    this.powershell = powershell;
    this.entryPath = path.join(this.rootDir, "server", "main.mjs");
    this.instanceFile = path.join(this.rootDir, "data", "runtime", "instance.json");
    this.stdoutLog = path.join(this.rootDir, "data", "logs", "service.stdout.log");
    this.stderrLog = path.join(this.rootDir, "data", "logs", "service.stderr.log");
    this.processQuery = processQuery || ((pid) => this.queryProcess(pid));
    this.listenerQuery = listenerQuery || ((port) => this.queryListener(port));
    this.systemEventLog = systemEventLog;
  }

  async logger() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    return this.systemEventLog;
  }

  async queryProcess(pid) {
    if (!WINDOWS) {
      try {
        process.kill(pid, 0);
        return { exists: true, pid, executablePath: "", commandLine: "", argv: [] };
      } catch (error) {
        if (error?.code !== "ESRCH") await (await this.logger()).error("service-control", "process_probe_failed", error, { pid });
        return { exists: false, pid };
      }
    }
    const script = path.join(this.rootDir, "scripts", "query-process.ps1");
    const { stdout } = await execFileAsync(this.powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-PidValue", String(pid),
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout.trim());
  }

  async queryListener(port) {
    if (!WINDOWS) return { port, pids: [] };
    const script = path.join(this.rootDir, "scripts", "query-listener.ps1");
    const { stdout } = await execFileAsync(this.powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Port", String(port),
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout.trim());
    return { port, pids: Array.isArray(parsed.pids) ? parsed.pids.map(Number) : [] };
  }

  async readInstance() {
    try { return JSON.parse(await fs.readFile(this.instanceFile, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      throw new TaskboardError("instance metadata损坏或不可读", {
        code: "INSTANCE_METADATA_INVALID", status: 500, details: { cause: error.message },
      });
    }
  }

  verifyIdentity(instance, proc, listener) {
    const mismatches = [];
    if (!instance) mismatches.push("instance_missing");
    if (!proc?.exists) mismatches.push("process_missing");
    if (instance && proc?.pid !== instance.pid) mismatches.push("pid_mismatch");
    if (instance && !listener?.pids?.includes(instance.pid)) mismatches.push("listener_pid_mismatch");
    if (instance && proc?.executablePath && norm(proc.executablePath) !== norm(instance.nodeExecutable)) mismatches.push("node_executable_mismatch");

    const argv = proc?.argv || [];
    if (instance && argv.length) {
      const scriptArg = argv.find((value, index) => index > 0 && norm(value) === norm(instance.entryPath));
      if (!scriptArg || norm(instance.entryPath) !== norm(this.entryPath)) mismatches.push("entry_path_mismatch");
      if (argValue(argv, "instance-token") !== instance.instanceToken) mismatches.push("instance_token_mismatch");
      if (norm(argValue(argv, "root")) !== norm(this.rootDir)) mismatches.push("root_arg_mismatch");
      if (Number(argValue(argv, "port")) !== Number(instance.port)) mismatches.push("port_arg_mismatch");
      if (argValue(argv, "host") !== instance.host) mismatches.push("host_arg_mismatch");
      if (norm(argValue(argv, "instance-file")) !== norm(this.instanceFile)) mismatches.push("instance_file_arg_mismatch");
    } else if (instance && WINDOWS) {
      mismatches.push("argv_unavailable");
    }
    return { ok: mismatches.length === 0, mismatches };
  }

  async status() {
    const instance = await this.readInstance();
    const listener = await this.listenerQuery(this.port);
    if (!instance) {
      return listener.pids.length
        ? { state: "port_conflict", port: this.port, listenerPids: listener.pids }
        : { state: "stopped", port: this.port };
    }

    let proc;
    try { proc = await this.processQuery(instance.pid); }
    catch (error) {
      return { state: "identity_unknown", instance, port: this.port, error: error.message };
    }
    const identity = this.verifyIdentity(instance, proc, listener);
    if (identity.ok) return { state: "running", instance, identity, listenerPids: listener.pids };
    if (!proc?.exists && listener.pids.length === 0) {
      return { state: "stale_instance", instance, identity, listenerPids: [] };
    }
    return { state: "identity_mismatch", instance, identity, listenerPids: listener.pids, process: proc };
  }

  async recoverOrphanedInstance() {
    const existing = await this.readInstance();
    if (existing) {
      throw new TaskboardError("instance metadata已存在，不需要恢复", {
        code: "INSTANCE_ALREADY_PRESENT", status: 409, details: { pid: existing.pid },
      });
    }
    const listener = await this.listenerQuery(this.port);
    if (listener.pids.length !== 1) {
      throw new TaskboardError("无法唯一确定监听进程，拒绝恢复instance metadata", {
        code: "ORPHAN_RECOVERY_AMBIGUOUS", status: 409, details: { port: this.port, pids: listener.pids },
      });
    }
    const pid = Number(listener.pids[0]);
    const proc = await this.processQuery(pid);
    if (!proc?.exists) {
      throw new TaskboardError("监听PID已不存在，拒绝恢复instance metadata", {
        code: "ORPHAN_PROCESS_MISSING", status: 409, details: { pid },
      });
    }
    const argv = proc.argv || [];
    const token = argValue(argv, "instance-token");
    const mismatches = [];
    if (!proc.executablePath || norm(proc.executablePath) !== norm(process.execPath)) mismatches.push("node_executable_mismatch");
    if (!argv.some((value, index) => index > 0 && norm(value) === norm(this.entryPath))) mismatches.push("entry_path_mismatch");
    if (norm(argValue(argv, "root")) !== norm(this.rootDir)) mismatches.push("root_arg_mismatch");
    if (argValue(argv, "host") !== this.host) mismatches.push("host_arg_mismatch");
    if (Number(argValue(argv, "port")) !== Number(this.port)) mismatches.push("port_arg_mismatch");
    if (norm(argValue(argv, "instance-file")) !== norm(this.instanceFile)) mismatches.push("instance_file_arg_mismatch");
    if (!token || token.length < 16) mismatches.push("instance_token_missing");
    if (mismatches.length) {
      throw new TaskboardError("监听进程不是可恢复的B-10实例，拒绝重建metadata", {
        code: "ORPHAN_IDENTITY_MISMATCH", status: 409, details: { pid, mismatches },
      });
    }

    const instance = {
      version: 1,
      pid,
      host: this.host,
      port: this.port,
      rootDir: this.rootDir,
      entryPath: this.entryPath,
      nodeExecutable: proc.executablePath,
      instanceToken: token,
      startedAt: null,
      recoveredAt: new Date().toISOString(),
      recoveryReason: "instance_metadata_missing",
    };
    await fs.mkdir(path.dirname(this.instanceFile), { recursive: true });
    await atomicWriteJson(this.instanceFile, instance);
    const state = await this.status();
    if (state.state !== "running" || !state.identity?.ok) {
      await fs.rm(this.instanceFile, { force: true }).catch(async (error) => {
        await (await this.logger()).error("service-control", "orphan_recovery_rollback_cleanup_failed", error, { instance_file: this.instanceFile });
      });
      throw new TaskboardError("metadata重建后严格身份复核失败，已回滚恢复文件", {
        code: "ORPHAN_RECOVERY_VERIFY_FAILED", status: 409, details: state,
      });
    }
    return { recovered: true, ...state };
  }
  async launchWindows(token) {
    const script = path.join(this.rootDir, "scripts", "create-service-process.ps1");
    const { stdout } = await execFileAsync(this.powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script,
      "-NodeExe", process.execPath,
      "-EntryPath", this.entryPath,
      "-RootDir", this.rootDir,
      "-HostValue", this.host,
      "-PortValue", String(this.port),
      "-InstanceToken", token,
      "-InstanceFile", this.instanceFile,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout.trim());
    if (!result.pid) throw new TaskboardError("Win32_Process.Create未返回PID", {
      code: "START_PROCESS_CREATE_FAILED", status: 500,
    });
    return { pid: Number(result.pid) };
  }
  async start({ timeoutMs = 10000 } = {}) {
    await fs.mkdir(path.dirname(this.instanceFile), { recursive: true });
    await fs.mkdir(path.dirname(this.stdoutLog), { recursive: true });

    const current = await this.status();
    if (current.state === "running") return { alreadyRunning: true, ...current };
    if (["port_conflict", "identity_mismatch", "identity_unknown"].includes(current.state)) {
      throw new TaskboardError("47831或instance metadata指向未知/不匹配进程，拒绝启动或覆盖", {
        code: "PORT_OR_IDENTITY_CONFLICT", status: 409, details: current,
      });
    }
    if (current.state === "stale_instance") await fs.rm(this.instanceFile, { force: true });

    const listeners = await this.listenerQuery(this.port);
    if (listeners.pids.length) throw new TaskboardError("目标端口已被其它进程监听", {
      code: "PORT_IN_USE", status: 409, details: { port: this.port, pids: listeners.pids },
    });

    const token = randomBytes(24).toString("base64url");
    let childPid;
    if (WINDOWS) {
      childPid = (await this.launchWindows(token)).pid;
    } else {
      const outFd = fsSync.openSync(this.stdoutLog, "a");
      const errFd = fsSync.openSync(this.stderrLog, "a");
      try {
        const child = spawn(process.execPath, [
          this.entryPath,
          "--root", this.rootDir,
          "--host", this.host,
          "--port", String(this.port),
          "--instance-token", token,
          "--instance-file", this.instanceFile,
        ], {
          detached: true,
          stdio: ["ignore", outFd, errFd],
        });
        childPid = child.pid;
        child.unref();
      } finally {
        fsSync.closeSync(outFd);
        fsSync.closeSync(errFd);
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(100);
      const instance = await this.readInstance();
      if (instance?.pid === childPid && instance.instanceToken === token) {
        const state = await this.status();
        if (state.state === "running") return { alreadyRunning: false, ...state };
        if (["identity_mismatch", "identity_unknown"].includes(state.state)) {
          throw new TaskboardError("服务已启动但严格身份校验失败", {
            code: "START_IDENTITY_FAILED", status: 500, details: state,
          });
        }
      }
      const proc = await this.processQuery(childPid).catch(async (error) => {
        await (await this.logger()).error("service-control", "start_process_query_failed", error, { pid: childPid });
        return { exists: false, queryFailed: true };
      });
      if (!proc.exists) break;
    }

    throw new TaskboardError("B-10服务启动超时或子进程提前退出", {
      code: "START_TIMEOUT", status: 500,
      details: { pid: childPid, stderrLog: this.stderrLog },
    });
  }

  async stop({ timeoutMs = 10000 } = {}) {
    const state = await this.status();
    if (state.state === "stopped") return { alreadyStopped: true, ...state };
    if (state.state === "stale_instance") {
      await fs.rm(this.instanceFile, { force: true });
      return { alreadyStopped: true, state: "stopped", staleMetadataRemoved: true };
    }
    if (state.state !== "running") {
      throw new TaskboardError("进程身份未完整匹配，拒绝终止", {
        code: "PROCESS_IDENTITY_MISMATCH", status: 409, details: state,
      });
    }

    if (WINDOWS) {
      await execFileAsync("taskkill.exe", ["/PID", String(state.instance.pid), "/T", "/F"], {
        windowsHide: true, maxBuffer: 1024 * 1024,
      });
    } else {
      process.kill(state.instance.pid, "SIGTERM");
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(100);
      const proc = await this.processQuery(state.instance.pid).catch(async (error) => {
        await (await this.logger()).error("service-control", "stop_process_query_failed", error, { pid: state.instance.pid });
        return { exists: false, queryFailed: true };
      });
      if (!proc.exists) {
        await fs.rm(this.instanceFile, { force: true }).catch(async (error) => {
          await (await this.logger()).error("service-control", "instance_cleanup_failed", error, { instance_file: this.instanceFile, pid: state.instance.pid });
        });
        return { alreadyStopped: false, state: "stopped", pid: state.instance.pid };
      }
    }
    throw new TaskboardError("B-10服务停止超时", {
      code: "STOP_TIMEOUT", status: 500, details: { pid: state.instance.pid },
    });
  }
}

