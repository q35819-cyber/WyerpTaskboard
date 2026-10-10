import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);
function iso(value) { return new Date(value).toISOString(); }
function nowMs(clock) { return Number(clock?.() ?? Date.now()); }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
async function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class ScanStore {
  constructor(rootDir, { clock = () => Date.now(), ttlMs = 30 * 60 * 1000, maxRunMs = 8 * 60 * 1000, systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxRunMs = maxRunMs;
    this.dir = path.join(rootDir, "data", "runtime", "task-scan");
    this.statePath = path.join(this.dir, "candidates.json");
    this.statusPath = path.join(this.dir, "status.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.lockPath = path.join(this.dir, "scan.lock");
    this.schedulerProbeCache = null;
    this.systemEventLog = systemEventLog;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    this.systemEventLog ||= await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    return this;
  }

  emptyState() { return { version: 1, candidates: {}, updated_at: iso(nowMs(this.clock)) }; }

  async appendEvent(event) {
    await this.init();
    const timestamp = iso(nowMs(this.clock));
    const value = { timestamp, ...event };
    const line = JSON.stringify(value) + "\n";
    const handle = await fs.open(this.eventsPath, "a");
    try { await handle.writeFile(line, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    const name = String(event.type || "scan_event");
    const level = /failed|error|corrupt/i.test(name) ? "error" :
      /stale|skipped|rearm_dispatch/i.test(name) ? "warning" : "info";
    await this.systemEventLog?.append({
      at: timestamp,
      level,
      component: "task-scan",
      event: name,
      detection_id: event.detection_id || null,
      result: event.reason || null,
      error_code: event.error_code || null,
      error_message: event.error || null,
      details: value
    });
  }

  async readState() {
    await this.init();
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      if (parsed?.version !== 1 || !parsed.candidates || typeof parsed.candidates !== "object") throw new Error("invalid candidate state");
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return this.emptyState();
      const quarantine = path.join(this.dir, `candidates.corrupt.${nowMs(this.clock)}.json`);
      let quarantineError = null;
      try { await fs.rename(this.statePath, quarantine); }
      catch (renameError) {
        quarantineError = String(renameError?.message || renameError).slice(0, 500);
        await this.systemEventLog?.error("task-scan", "candidate_quarantine_failed", renameError, {
          state_path: this.statePath,
          quarantine
        });
      }
      await this.appendEvent({
        type: "candidate_store_corrupt",
        error: error.message,
        quarantine: path.basename(quarantine),
        quarantine_error: quarantineError
      });
      return this.emptyState();
    }
  }

  async writeState(state) {
    state.updated_at = iso(nowMs(this.clock));
    await atomicWriteJson(this.statePath, state);
  }

  async schedulerStatus() {
    await this.init();
    const file = path.join(this.dir, "scheduler.json");
    let recorded;
    try { recorded = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      recorded = { version: 1, installed: false, state: "not_recorded", task_name: "WyerpTaskboard-TaskScan" };
      if (error?.code !== "ENOENT") {
        await this.appendEvent({ type: "scheduler_state_read_failed", error: String(error?.message || error).slice(0, 500) });
      }
    }

    if (process.platform !== "win32") return recorded;
    const probeScript = path.join(this.rootDir, "scripts", "task-scan-schedule-status.ps1");
    try { await fs.access(probeScript); }
    catch (error) {
      await this.appendEvent({ type: "scheduler_probe_script_unavailable", error: String(error?.message || error).slice(0, 500), probe_script: probeScript });
      return recorded;
    }
    const now = nowMs(this.clock);
    if (this.schedulerProbeCache && now - this.schedulerProbeCache.at < 60_000) return this.schedulerProbeCache.value;
    try {
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probeScript], {
        windowsHide: true,
        timeout: 12000,
        maxBuffer: 64 * 1024,
      });
      const live = JSON.parse(String(stdout).trim());
      const value = { ...recorded, ...live, probe_error: null };
      this.schedulerProbeCache = { at: now, value };
      return value;
    } catch (error) {
      const value = { ...recorded, live_probe: false, probe_error: error.message };
      this.schedulerProbeCache = { at: now, value };
      await this.appendEvent({ type: "scheduler_live_probe_failed", error: String(error?.message || error).slice(0, 500) });
      return value;
    }
  }
  async status() {
    await this.init();
    try { return JSON.parse(await fs.readFile(this.statusPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") {
        await this.appendEvent({ type: "scan_status_read_failed", error: String(error?.message || error).slice(0, 500) });
      }
      return { state: "never_run", last_scan_at: null, scheduler_mode: "idle_hunt", rearm_pending: true };
    }
  }

  async triggerScheduledTaskNow() {
    if (process.platform !== "win32") return { started: false, reason: "non_windows" };
    const schedulerFile = path.join(this.dir, "scheduler.json");
    let recorded = null;
    try { recorded = JSON.parse(await fs.readFile(schedulerFile, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") {
        await this.appendEvent({ type: "scheduler_trigger_state_read_failed", error: String(error?.message || error).slice(0, 500) });
      }
    }
    if (!recorded?.installed || recorded.task_name !== "WyerpTaskboard-TaskScan") {
      return { started: false, reason: "scheduler_not_installed" };
    }
    try {
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Start-ScheduledTask -TaskName 'WyerpTaskboard-TaskScan'"
      ], { windowsHide: true, timeout: 12000, maxBuffer: 64 * 1024 });
      return { started: true, task_name: "WyerpTaskboard-TaskScan" };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      await this.appendEvent({ type: "scheduler_start_failed", error: message });
      return { started: false, reason: "scheduler_start_failed", error: message };
    }
  }

  async requestRearm(reason = "state_change", metadata = {}) {
    const at = iso(nowMs(this.clock));
    const normalizedReason = String(reason || "state_change").slice(0, 120);
    const next = await this.writeStatus({
      rearm_pending: true,
      rearm_requested_at: at,
      rearm_reason: normalizedReason,
      rearm_metadata: metadata && typeof metadata === "object" ? metadata : {}
    });
    await this.appendEvent({ type: "scan_rearmed", reason: normalizedReason, metadata: next.rearm_metadata });
    const schedulerTrigger = await this.triggerScheduledTaskNow();
    await this.appendEvent({ type: "scan_rearm_dispatch", reason: normalizedReason, scheduler_trigger: schedulerTrigger });
    return { ...next, scheduler_trigger: schedulerTrigger };
  }

  async scheduledDecision() {
    const status = await this.status();
    const mode = status.scheduler_mode || "idle_hunt";
    if (status.rearm_pending) return { run: true, reason: "rearm", scheduler_mode: mode, next_due_at: status.next_due_at || null };
    const due = !status.next_due_at || Date.parse(status.next_due_at) <= nowMs(this.clock);
    return { run: due, reason: due ? "interval_due" : "not_due", scheduler_mode: mode, next_due_at: status.next_due_at || null };
  }

  async writeStatus(patch) {
    const current = await this.status();
    const next = { version: 1, ...current, ...patch, updated_at: iso(nowMs(this.clock)) };
    await atomicWriteJson(this.statusPath, next);
    return next;
  }

  async acquireRunLock({ pid = process.pid, isAlive = processAlive } = {}) {
    await this.init();
    const token = crypto.randomUUID();
    const startedAt = nowMs(this.clock);
    const payload = { version: 1, token, pid, started_at: iso(startedAt) };
    try {
      const handle = await fs.open(this.lockPath, "wx");
      try { await handle.writeFile(JSON.stringify(payload, null, 2) + "\n", "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      return { acquired: true, token, pid, startedAt };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let existing = null;
      try { existing = JSON.parse(await fs.readFile(this.lockPath, "utf8")); }
      catch (readError) {
        await this.appendEvent({ type: "scan_lock_read_failed", error: String(readError?.message || readError).slice(0, 500) });
      }
      const age = existing?.started_at ? startedAt - Date.parse(existing.started_at) : Number.POSITIVE_INFINITY;
      const active = existing?.pid ? await isAlive(Number(existing.pid)) : false;
      if (active && age >= 0 && age < this.maxRunMs) {
        await this.writeStatus({ state: "skipped", reason: "previous_run_active", last_skip_at: iso(startedAt) });
        await this.appendEvent({ type: "scan_skipped", reason: "previous_run_active", existing_pid: existing.pid });
        return { acquired: false, reason: "previous_run_active", existing };
      }
      await fs.rm(this.lockPath, { force: true });
      await this.appendEvent({ type: "stale_lock_recovered", existing });
      return this.acquireRunLock({ pid, isAlive });
    }
  }

  async releaseRunLock(token) {
    let existing = null;
    try { existing = JSON.parse(await fs.readFile(this.lockPath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") {
        await this.appendEvent({ type: "scan_lock_release_read_failed", error: String(error?.message || error).slice(0, 500) });
      }
    }
    if (!existing || existing.token === token) await fs.rm(this.lockPath, { force: true });
  }

  async upsertScan({ runId, detectedAt, projectResults }) {
    const state = await this.readState();
    const now = Date.parse(detectedAt);
    for (const item of Object.values(state.candidates)) {
      if (!item.consumed_at && !item.stale_at && Date.parse(item.expires_at) <= now) {
        item.stale_at = detectedAt;
        item.stale_reason = "expired";
      }
    }

    let created = 0, refreshed = 0, superseded = 0;
    for (const projectResult of projectResults) {
      const currentCandidates = projectResult.candidates || [];
      if (projectResult.status === "ok") {
        const currentByTask = new Map(currentCandidates.map((candidate) => [candidate.task_id, candidate]));
        for (const item of Object.values(state.candidates)) {
          if (item.project_id !== projectResult.project_id || item.consumed_at || item.stale_at) continue;
          const current = currentByTask.get(item.task_id);
          if (!current) {
            item.stale_at = detectedAt;
            item.stale_reason = "not_detected_in_latest_scan";
            superseded++;
            continue;
          }
          if (item.dedupe_key !== current.dedupe_key) {
            item.stale_at = detectedAt;
            item.stale_reason = "superseded";
            superseded++;
          }
        }
      }
      for (const candidate of currentCandidates) {
        const dedupeKey = candidate.dedupe_key;
        const existing = Object.values(state.candidates).find((x) =>
          x.dedupe_key === dedupeKey && !x.consumed_at && !x.stale_at
        );
        if (existing) {
          existing.last_confirmed_at = detectedAt;
          existing.expires_at = iso(now + this.ttlMs);
          existing.track = candidate.track;
          existing.priority = candidate.priority;
          existing.status = candidate.status;
          existing.planned_role = candidate.planned_role;
          existing.current_assignee = candidate.current_assignee;
          existing.current_session_id = candidate.current_session_id;
          existing.task_updated_at = candidate.task_updated_at || "";
          existing.registry_revision = candidate.registry_revision;
          existing.registry_sha = candidate.registry_sha;
          existing.resource_ledger_sha = candidate.resource_ledger_sha;
          existing.read_dependencies = candidate.read_dependencies;
          existing.write_targets = candidate.write_targets;
          existing.checkpoint_report_refs = candidate.checkpoint_report_refs;
          existing.eligible_role = candidate.eligible_role;
          existing.eligible = candidate.eligible;
          existing.blockers = candidate.blockers;
          existing.reason = candidate.reason;
          existing.source_fingerprint = candidate.source_fingerprint;
          existing.requires_runtime_recheck = candidate.requires_runtime_recheck;
          existing.detected_at = candidate.detected_at;
          refreshed++;
          continue;
        }
        const detectionId = "det_" + hash(runId + "|" + dedupeKey + "|" + detectedAt).slice(0, 24);
        state.candidates[detectionId] = {
          detection_id: detectionId,
          first_detected_at: detectedAt,
          last_confirmed_at: detectedAt,
          expires_at: iso(now + this.ttlMs),
          consumed_at: null,
          stale_at: null,
          stale_reason: null,
          ...candidate,
        };
        created++;
      }
    }
    await this.writeState(state);
    await this.appendEvent({ type: "scan_persisted", run_id: runId, created, refreshed, superseded, projects: projectResults.length });
    return { created, refreshed, superseded, active: this.activeFromState(state).length };
  }

  activeFromState(state) {
    const now = nowMs(this.clock);
    return Object.values(state.candidates).filter((x) =>
      !x.consumed_at && !x.stale_at && Date.parse(x.expires_at) > now
    );
  }

  async list({ includeInactive = false } = {}) {
    const state = await this.readState();
    const items = includeInactive ? Object.values(state.candidates) : this.activeFromState(state);
    const statusRank = { "待交付": 0, "测试失败待修复": 1, "阻断": 1, "待开发": 2, "待复测": 3, "待独测": 4, "待准备": 5 };
    const priorityRank = { P0: 0, P1: 1, P2: 2 };
    const queueRank = (item) => {
      if (item.eligible_role === "developer_ai") {
        if (item.status === "待交付") return 0;
        if (["测试失败待修复", "阻断"].includes(item.status)) return 1;
        if (item.status === "待开发") return 2;
        return 3;
      }
      if (item.eligible_role === "test_ai") {
        if (item.status === "待复测") return 0;
        if (item.status === "待独测") return 1;
      }
      return 9;
    };
    return items.sort((a, b) =>
      Number(Boolean(b.eligible)) - Number(Boolean(a.eligible)) ||
      queueRank(a) - queueRank(b) ||
      (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) ||
      (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) ||
      String(a.first_detected_at).localeCompare(String(b.first_detected_at)) ||
      String(a.task_id).localeCompare(String(b.task_id))
    );
  }

  async get(detectionId) {
    const state = await this.readState();
    return state.candidates[detectionId] || null;
  }

  async recentEvents(limit = 20) {
    await this.init();
    let text = "";
    try { text = await fs.readFile(this.eventsPath, "utf8"); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, limit)).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }

  async mark(detectionId, kind, { claimEventId = null, reason = null } = {}) {
    const state = await this.readState();
    const item = state.candidates[detectionId];
    if (!item) throw new Error("unknown detection_id: " + detectionId);
    const at = iso(nowMs(this.clock));
    if (kind === "consumed") {
      if (item.consumed_at) {
        if (!claimEventId || item.claim_event_id === claimEventId) return item;
        const error = new Error("candidate already consumed by another claim");
        error.code = "CANDIDATE_ALREADY_CONSUMED";
        throw error;
      }
      item.consumed_at = at;
      item.claim_event_id = claimEventId;
    } else if (kind === "stale") {
      if (item.consumed_at) {
        const error = new Error("consumed candidate cannot be marked stale");
        error.code = "CANDIDATE_ALREADY_CONSUMED";
        throw error;
      }
      item.stale_at = at;
      item.stale_reason = reason || "recheck_failed";
    } else throw new Error("unknown mark kind: " + kind);
    await this.writeState(state);
    await this.appendEvent({ type: "candidate_" + kind, detection_id: detectionId, claim_event_id: claimEventId, reason });
    return item;
  }
}
