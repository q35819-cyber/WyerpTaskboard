import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { TaskboardError } from "./core/errors.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_AI_EXECUTION_SETTINGS = Object.freeze({
  version: 1,
  developer: { model: "GPT-5.6 Sol", reasoning_effort: "high" },
  test: { model: "GPT-5.6 Sol", reasoning_effort: "high" },
  scan_interval_minutes: 10,
  max_requests_per_chat: 20,
  context_warning_at: 15,
  timeout_retry_limit: 3,
  anomaly_window_minutes: 10,
  anomaly_limit: 6,
  role_switch_limit: 3
});

const REASONING = new Set(["instant", "medium", "high", "extra_high"]);

function intField(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new TaskboardError(name + "必须是" + min + "～" + max + "之间的整数", {
      code: "INVALID_AI_EXECUTION_SETTINGS", status: 400, details: { field: name }
    });
  }
  return n;
}

function roleConfig(value, name) {
  const model = String(value?.model || "").trim();
  const reasoning = String(value?.reasoning_effort || "").trim().toLowerCase();
  if (!model || model.length > 80) {
    throw new TaskboardError(name + "模型名称不能为空且不能超过80字符", {
      code: "INVALID_AI_EXECUTION_SETTINGS", status: 400, details: { field: name + ".model" }
    });
  }
  if (!REASONING.has(reasoning)) {
    throw new TaskboardError(name + "推理强度无效", {
      code: "INVALID_AI_EXECUTION_SETTINGS", status: 400, details: { field: name + ".reasoning_effort" }
    });
  }
  return { model, reasoning_effort: reasoning };
}
export function normalizeAiExecutionSettings(input = {}) {
  const merged = {
    ...DEFAULT_AI_EXECUTION_SETTINGS,
    ...input,
    developer: { ...DEFAULT_AI_EXECUTION_SETTINGS.developer, ...(input.developer || {}) },
    test: { ...DEFAULT_AI_EXECUTION_SETTINGS.test, ...(input.test || {}) }
  };
  const out = {
    version: 1,
    developer: roleConfig(merged.developer, "开发AI"),
    test: roleConfig(merged.test, "独立测试AI"),
    scan_interval_minutes: intField(merged.scan_interval_minutes, "扫描间隔", 1, 1440),
    max_requests_per_chat: intField(merged.max_requests_per_chat, "单聊天最大请求数", 1, 100),
    context_warning_at: intField(merged.context_warning_at, "上下文预警阈值", 1, 100),
    timeout_retry_limit: intField(merged.timeout_retry_limit, "超时重试次数", 0, 10),
    anomaly_window_minutes: intField(merged.anomaly_window_minutes, "异常统计窗口", 1, 240),
    anomaly_limit: intField(merged.anomaly_limit, "异常熔断阈值", 1, 100),
    role_switch_limit: intField(merged.role_switch_limit, "连续换会话熔断阈值", 1, 20)
  };
  if (out.context_warning_at > out.max_requests_per_chat) {
    throw new TaskboardError("上下文预警阈值不能大于单聊天最大请求数", {
      code: "INVALID_AI_EXECUTION_SETTINGS", status: 400,
      details: { context_warning_at: out.context_warning_at, max_requests_per_chat: out.max_requests_per_chat }
    });
  }
  return out;
}

export class AiExecutionSettingsStore {
  constructor(rootDir, { systemEventLog = null } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.file = path.join(this.rootDir, "config", "ai-execution.json");
    this.systemEventLog = systemEventLog;
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8"));
      const normalized = normalizeAiExecutionSettings(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await atomicWriteJson(this.file, normalized);
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await atomicWriteJson(this.file, DEFAULT_AI_EXECUTION_SETTINGS);
    }
    return this;
  }

  async get() {
    try {
      return normalizeAiExecutionSettings(JSON.parse(await fs.readFile(this.file, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        await this.init();
        return structuredClone(DEFAULT_AI_EXECUTION_SETTINGS);
      }
      throw error;
    }
  }
  async save(value, { applyScheduler = true } = {}) {
    const normalized = normalizeAiExecutionSettings(value);
    const previous = await this.get();
    let scheduler = { applied: false, reason: "interval_unchanged" };
    if (!applyScheduler) {
      scheduler = { applied: false, reason: "not_requested" };
    } else if (previous.scan_interval_minutes !== normalized.scan_interval_minutes) {
      scheduler = await this.applyScheduler(normalized.scan_interval_minutes);
    }
    try {
      await atomicWriteJson(this.file, normalized);
    } catch (error) {
      if (scheduler.applied) {
        try { await this.applyScheduler(previous.scan_interval_minutes); }
        catch (rollbackError) {
          await this.systemEventLog?.error("ai-execution-settings", "scheduler_rollback_failed", rollbackError, {
            attempted_interval_minutes: previous.scan_interval_minutes,
            failed_settings_write: String(error?.message || error).slice(0, 500)
          });
        }
      }
      await this.systemEventLog?.error("ai-execution-settings", "settings_write_failed", error, {
        scheduler_applied: Boolean(scheduler.applied),
        requested_scan_interval_minutes: normalized.scan_interval_minutes
      });
      throw error;
    }
    return { settings: normalized, scheduler };
  }

  async applyScheduler(intervalMinutes) {
    if (process.platform !== "win32") return { applied: false, reason: "non_windows" };
    const script = path.join(this.rootDir, "scripts", "install-task-scan-schedule.ps1");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", script, "-IntervalMinutes", String(intervalMinutes)
      ], { windowsHide: true, timeout: 30000, maxBuffer: 256 * 1024 });
      return { applied: true, interval_minutes: intervalMinutes, output: String(stdout || "").trim().slice(0, 2000) };
    } catch (error) {
      await this.systemEventLog?.error("ai-execution-settings", "scheduler_update_failed", error, { interval_minutes: intervalMinutes });
      throw new TaskboardError("AI设置已验证，但扫描计划任务更新失败", {
        code: "AI_EXECUTION_SCHEDULER_UPDATE_FAILED", status: 500,
        details: { interval_minutes: intervalMinutes, message: error?.message || String(error) }
      });
    }
  }

  forChatWake(settings) {
    const value = settings || DEFAULT_AI_EXECUTION_SETTINGS;
    return {
      developer: value.developer,
      test: value.test,
      max_requests_per_chat: value.max_requests_per_chat,
      context_warning_at: value.context_warning_at,
      timeout_retry_limit: value.timeout_retry_limit,
      anomaly_window_minutes: value.anomaly_window_minutes,
      anomaly_limit: value.anomaly_limit,
      role_switch_limit: value.role_switch_limit
    };
  }
}
