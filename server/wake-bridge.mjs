import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);
function iso(value) { return new Date(value).toISOString(); }
function nowMs(clock) { return Number(clock?.() ?? Date.now()); }
function errorText(error) { return String(error?.message || error || "unknown error").slice(0, 1000); }
function cleanRef(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(text) ? text : null;
}

function normalizeConfig(raw) {
  const config = {
    version: 1,
    enabled: false,
    provider: "github_pr_comment",
    repo: "",
    pr_number: 0,
    gh_command: "gh",
    execution_mode: "legacy_bridge",
    disabled_reason: "",
    chat_trigger_verified: false,
    work_trigger_verified: false,
    ...raw,
  };
  if (!config.enabled) return config;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(config.repo || ""))) {
    throw new Error("wake bridge repo must be owner/name");
  }
  config.pr_number = Number(config.pr_number);
  if (!Number.isInteger(config.pr_number) || config.pr_number <= 0) {
    throw new Error("wake bridge pr_number must be a positive integer");
  }
  return config;
}

export class WakeBridge {
  constructor(rootDir, { clock = () => Date.now(), execFileFn = execFileAsync, config = null, systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.execFileFn = execFileFn;
    this.configOverride = config;
    this.configPath = path.join(rootDir, "config", "wake-bridge.json");
    this.statePath = path.join(rootDir, "data", "runtime", "task-scan", "wake-bridge.json");
    this.config = null;
    this.systemEventLog = systemEventLog;
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    if (this.configOverride) {
      this.config = normalizeConfig(this.configOverride);
      return this;
    }
    try {
      this.config = normalizeConfig(JSON.parse(await fs.readFile(this.configPath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") {
        this.config = normalizeConfig({ enabled: false, configuration_state: "missing" });
      } else {
        await this.systemEventLog?.error("wake-bridge", "config_load_failed", error, { config_path: this.configPath });
        this.config = normalizeConfig({
          enabled: false,
          configuration_state: "invalid",
          configuration_error: errorText(error),
        });
      }
    }
    return this;
  }

  emptyState() {
    return { version: 1, sent: {}, last_success: null, last_error: null, updated_at: iso(nowMs(this.clock)) };
  }

  async readState() {
    try {
      const state = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (state?.version !== 1 || !state.sent || typeof state.sent !== "object") throw new Error("invalid wake bridge state");
      return state;
    } catch (error) {
      if (error.code === "ENOENT") return this.emptyState();
      const state = this.emptyState();
      state.last_error = { at: iso(nowMs(this.clock)), code: "WAKE_STATE_RESET", message: errorText(error) };
      await this.systemEventLog?.error("wake-bridge", "state_reset", error, { state_path: this.statePath });
      return state;
    }
  }

  async writeState(state) {
    state.updated_at = iso(nowMs(this.clock));
    await atomicWriteJson(this.statePath, state);
  }

  triggerState(state) {
    if (this.config?.execution_mode === "chat_only" && !this.config?.chat_trigger_verified) {
      return "chat_mode_only_unavailable";
    }
    if (!this.config?.enabled) return "disabled_unverified";
    if (state?.last_error) return "github_bridge_error_fallback";
    if (this.config.chat_trigger_verified) return "enabled_verified";
    return "github_bridge_ready_unverified";
  }

  publicStatus(state, extra = {}) {
    return {
      provider: this.config?.provider || "github_pr_comment",
      repo: this.config?.repo || null,
      pr_number: this.config?.pr_number || null,
      execution_mode: this.config?.execution_mode || "legacy_bridge",
      disabled_reason: this.config?.disabled_reason || null,
      chat_trigger_verified: Boolean(this.config?.chat_trigger_verified),
      work_trigger_verified: Boolean(this.config?.work_trigger_verified),
      instant_trigger: this.triggerState(state),
      last_success: state?.last_success || null,
      last_error: state?.last_error || null,
      ...extra,
    };
  }

  async notifyCandidate(candidate) {
    if (!this.config) await this.init();
    const state = await this.readState();
    if (!this.config.enabled) return this.publicStatus(state, { state: "disabled" });
    if (!candidate?.eligible || !candidate.detection_id) {
      return this.publicStatus(state, { state: "no_candidate" });
    }

    const projectId = cleanRef(candidate.project_id);
    const taskId = cleanRef(candidate.task_id);
    const detectionId = cleanRef(candidate.detection_id);
    const eligibleRole = cleanRef(candidate.eligible_role);
    if (!projectId || !taskId || !detectionId || !eligibleRole) {
      const at = iso(nowMs(this.clock));
      state.last_error = { at, code: "INVALID_WAKE_REFERENCE", message: "candidate wake references failed allowlist validation", detection_id: detectionId || null };
      await this.writeState(state);
      await this.systemEventLog?.append({
        level: "warning", component: "wake-bridge", event: "invalid_wake_reference",
        detection_id: detectionId || null, result: "rejected", error_code: "INVALID_WAKE_REFERENCE",
        error_message: state.last_error.message
      });
      return this.publicStatus(state, { state: "error", detection_id: detectionId || null, error: state.last_error });
    }
    if (state.sent[detectionId]) {
      return this.publicStatus(state, {
        state: "deduped",
        detection_id: detectionId,
        sent: state.sent[detectionId],
      });
    }

    const body = [
      "candidate_ready",
      projectId,
      taskId,
      detectionId,
      eligibleRole,
    ].join(" | ");

    try {
      const endpoint = "repos/" + this.config.repo + "/issues/" + this.config.pr_number + "/comments";
      const result = await this.execFileFn(
        this.config.gh_command || "gh",
        ["api", "--method", "POST", endpoint, "-f", "body=" + body],
        { windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 }
      );
      let response = {};
      try { response = JSON.parse(String(result?.stdout || "").trim() || "{}"); }
      catch (parseError) {
        await this.systemEventLog?.error("wake-bridge", "provider_response_parse_failed", parseError, {
          detection_id: detectionId,
          stdout_length: String(result?.stdout || "").length
        });
      }
      const at = iso(nowMs(this.clock));
      const sent = {
        sent_at: at,
        project_id: projectId,
        task_id: taskId,
        eligible_role: eligibleRole,
        comment_id: response.id || null,
        comment_url: response.html_url || null,
      };
      state.sent[detectionId] = sent;
      const entries = Object.entries(state.sent).sort((a, b) =>
        String(b[1]?.sent_at || "").localeCompare(String(a[1]?.sent_at || ""))
      );
      state.sent = Object.fromEntries(entries.slice(0, 500));
      state.last_success = { at, detection_id: detectionId, comment_id: sent.comment_id, comment_url: sent.comment_url };
      state.last_error = null;
      await this.writeState(state);
      return this.publicStatus(state, { state: "sent", detection_id: detectionId, sent });
    } catch (error) {
      const at = iso(nowMs(this.clock));
      state.last_error = {
        at,
        code: error?.code || "GITHUB_WAKE_FAILED",
        message: errorText(error),
        detection_id: detectionId,
      };
      await this.writeState(state);
      await this.systemEventLog?.error("wake-bridge", "candidate_notify_failed", error, {
        detection_id: detectionId,
        project_id: projectId,
        task_id: taskId,
        eligible_role: eligibleRole
      });
      return this.publicStatus(state, { state: "error", detection_id: detectionId, error: state.last_error });
    }
  }
}
