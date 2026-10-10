import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

function iso(ms) { return new Date(ms).toISOString(); }
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const INPUT_LEASE_KINDS = new Set(["Move", "Click", "Type", "Shortcut", "App", "SmokeCursorControl"]);

export class AutomationControlStore {
  constructor(rootDir, { clock = () => Date.now(), systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.configPath = path.join(rootDir, "config", "automation-control.json");
    this.runtimeDir = path.join(rootDir, "data", "runtime", "automation-control");
    this.statePath = path.join(this.runtimeDir, "state.json");
    this.tokenPath = path.join(this.runtimeDir, "control-token.json");
    this.eventsPath = path.join(this.runtimeDir, "events.jsonl");
    this.validationPath = path.join(rootDir, "data", "runtime", "validation", "npm-test.json");
    this.packagePath = path.join(rootDir, "package.json");
    this.config = null;
    this.token = null;
    this.systemEventLog = systemEventLog;
  }

  async init({ resetLifecycle = true } = {}) {
    await fs.mkdir(this.runtimeDir, { recursive: true });
    this.systemEventLog ||= await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    try { this.config = JSON.parse(await fs.readFile(this.configPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.config = { version: 1, approval_ttl_seconds: 120, pending_ttl_seconds: 600, input_lease_ms: 4000, unattended_requires_validation: true };
    }
    if (this.config?.version !== 1) throw new TaskboardError("自动化总控配置版本不支持", { code: "AUTOMATION_CONTROL_CONFIG_VERSION", status: 500 });

    try {
      const saved = JSON.parse(await fs.readFile(this.tokenPath, "utf8"));
      this.token = String(saved.token || "");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!this.token || this.token.length < 32) {
      this.token = crypto.randomBytes(32).toString("hex");
      await atomicWriteJson(this.tokenPath, { version: 1, token: this.token, created_at: iso(this.clock()) });
    }

    let stateExists = true;
    try { await fs.access(this.statePath); } catch { stateExists = false; }
    const previous = await this.readRaw();
    if (!resetLifecycle && stateExists) return this;
    const initial = {
      version: 1,
      running: false,
      unattended: Boolean(previous.unattended),
      user_takeover: false,
      interaction_paused: false,
      takeover_scope: null,
      pending_action: null,
      approval_grant: null,
      input_lease: null,
      manual_start_proof: null,
      in_flight_action: null,
      last_completed_action: previous.last_completed_action || null,
      last_decision: previous.last_decision || null,
      last_pause_reason: "lifecycle_start_requires_manual_start",
      lifecycle_started_at: iso(this.clock()),
      updated_at: iso(this.clock())
    };
    await this.write(initial);
    return this;
  }

  verifyToken(token) { return safeEqual(token, this.token); }
  async appendEvent(event = {}) {
    const at = iso(this.clock());
    const value = { at, ...event };
    await fs.appendFile(this.eventsPath, JSON.stringify(value) + "\n", "utf8");
    const name = String(event.stage || event.event || "automation_event");
    const level = /failed|safety_blocked/i.test(name) ? "error" :
      /rejected|user_takeover|interrupted|approval_required/i.test(name) ? "warning" : "info";
    await this.systemEventLog?.append({
      at,
      level,
      component: "automation-control",
      event: name,
      trace_id: event.trace_id || null,
      action_fingerprint: event.action_fingerprint || null,
      stage: event.stage || null,
      result: event.result || event.decision || null,
      error_source: event.error_source || null,
      error_code: event.error_code || null,
      error_message: event.error_message || null,
      details: value
    });
    return value;
  }


  inputLeaseFor(state, action, actionFingerprint, now) {
    if (action.source !== "windows-mcp" || !INPUT_LEASE_KINDS.has(action.kind)) return null;
    const leaseMs = Math.max(500, Math.min(15000, Number(this.config.input_lease_ms || 4000)));
    return {
      source: action.source,
      kind: action.kind,
      action_fingerprint: actionFingerprint,
      issued_at: iso(now),
      expires_at: iso(now + leaseMs)
    };
  }

  async readRaw() {
    try { return { version: 1, ...(JSON.parse(await fs.readFile(this.statePath, "utf8"))) }; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { version: 1, running: false, unattended: false, user_takeover: false, interaction_paused: false, takeover_scope: null, pending_action: null, approval_grant: null, input_lease: null, manual_start_proof: null, in_flight_action: null, last_completed_action: null, last_decision: null };
    }
  }

  async write(state) {
    state.version = 1;
    state.updated_at = iso(this.clock());
    await atomicWriteJson(this.statePath, state);
    return state;
  }

  async validationGate() {
    try {
      const value = JSON.parse(await fs.readFile(this.validationPath, "utf8"));
      const pkg = JSON.parse(await fs.readFile(this.packagePath, "utf8"));
      const failedFiles = Number(value.failedFiles ?? value.failed_files ?? 0);
      const testedPackageVersion = String(value.package_version || value.packageVersion || "");
      const currentPackageVersion = String(pkg.version || "");
      const versionMatch = Boolean(testedPackageVersion && currentPackageVersion && testedPackageVersion === currentPackageVersion);
      const passed = value.state === "passed" && failedFiles === 0 && versionMatch;
      return {
        passed,
        state: value.state || "unknown",
        failed_files: failedFiles,
        finished_at: value.finished_at || value.finishedAt || null,
        tested_package_version: testedPackageVersion || null,
        current_package_version: currentPackageVersion || null,
        version_match: versionMatch
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { passed: false, state: "never_run", failed_files: null, finished_at: null, tested_package_version: null, current_package_version: null, version_match: false };
    }
  }

  async publicState() {
    const state = await this.readRaw();
    const validation = await this.validationGate();
    const unattendedAvailable = this.config.unattended_requires_validation === false || validation.passed;
    return {
      ...state,
      token: undefined,
      manual_start_proof: undefined,
      validation,
      unattended_available: unattendedAvailable,
      unattended_effective: Boolean(state.unattended && unattendedAvailable && state.running && !state.user_takeover),
      interactive_automation_enabled: Boolean(state.running && !state.user_takeover),
      background_work_preserved: Boolean(state.user_takeover),
      approval_mode: state.unattended && unattendedAvailable ? "unattended" : "manual_approval"
    };
  }

  async issueManualStartProof({ injected = true, input_type = "unknown" } = {}) {
    const normalizedInputType = String(input_type || "unknown").slice(0, 40);
    if (injected === true || !["mouse", "keyboard"].includes(normalizedInputType)) {
      throw new TaskboardError("首次启动需要可证明的人工输入", {
        code: "AUTOMATION_MANUAL_START_PROOF_REJECTED", status: 409,
        details: { injected: injected === true, input_type: normalizedInputType }
      });
    }
    const state = await this.readRaw();
    const now = this.clock();
    const ttlMs = Math.max(500, Math.min(3000, Number(this.config.manual_start_proof_ms || 1500)));
    state.manual_start_proof = {
      id: crypto.randomUUID(),
      input_type: normalizedInputType,
      issued_at: iso(now),
      expires_at: iso(now + ttlMs)
    };
    await this.write(state);
    await this.appendEvent({ stage: "manual_start_proof_issued", input_type: normalizedInputType, expires_at: state.manual_start_proof.expires_at });
    return { proof_id: state.manual_start_proof.id, expires_at: state.manual_start_proof.expires_at };
  }

  async start({ proof_id = null, require_manual_proof = false } = {}) {
    const state = await this.readRaw();
    if (require_manual_proof) {
      const proof = state.manual_start_proof;
      const now = this.clock();
      if (!proof || !safeEqual(proof.id, proof_id) || Date.parse(proof.expires_at || "") <= now) {
        state.manual_start_proof = null;
        await this.write(state);
        await this.appendEvent({ stage: "manual_start_rejected", result: "manual_proof_required" });
        throw new TaskboardError("首次启动必须由人工在全局控制台触发", {
          code: "AUTOMATION_MANUAL_START_REQUIRED", status: 409
        });
      }
      state.manual_start_proof = null;
      await this.appendEvent({ stage: "manual_start_proof_consumed", input_type: proof.input_type });
    }
    state.running = true;
    state.user_takeover = false;
    state.interaction_paused = false;
    state.takeover_scope = null;
    state.input_lease = null;
    state.manual_start_proof = null;
    state.last_pause_reason = null;
    state.started_at = iso(this.clock());
    await this.write(state);
    return this.publicState();
  }

  async pause(reason = "user_pause") {
    const state = await this.readRaw();
    state.running = false;
    state.pending_action = null;
    state.approval_grant = null;
    state.input_lease = null;
    state.manual_start_proof = null;
    state.last_pause_reason = String(reason || "user_pause").slice(0, 200);
    state.paused_at = iso(this.clock());
    await this.write(state);
    return this.publicState();
  }

  async setUnattended(enabled) {
    const value = Boolean(enabled);
    const current = await this.readRaw();
    if (value && current.user_takeover) throw new TaskboardError("人工接管期间不能开启无人值守；请先恢复交互自动化", {
      code: "UNATTENDED_USER_TAKEOVER_ACTIVE", status: 409
    });
    if (value && this.config.unattended_requires_validation !== false) {
      const gate = await this.validationGate();
      if (!gate.passed) throw new TaskboardError("测试门禁未通过，不能开启无人值守", {
        code: "UNATTENDED_VALIDATION_REQUIRED", status: 409, details: gate
      });
    }
    const state = current;
    state.unattended = value;
    if (!value) state.approval_grant = null;
    await this.write(state);
    return this.publicState();
  }

  async issueInputLease({ kind, action_fingerprint = null } = {}) {
    const normalizedKind = String(kind || "");
    if (!INPUT_LEASE_KINDS.has(normalizedKind)) throw new TaskboardError("输入租约动作类型无效", {
      code: "AUTOMATION_INPUT_LEASE_KIND_INVALID", status: 400, details: { kind: normalizedKind }
    });
    const state = await this.readRaw();
    if (!state.running || state.user_takeover) throw new TaskboardError("自动化未处于可执行状态", {
      code: "AUTOMATION_INPUT_LEASE_BLOCKED", status: 409,
      details: { running: Boolean(state.running), user_takeover: Boolean(state.user_takeover) }
    });
    const now = this.clock();
    const action = { source: "windows-mcp", kind: normalizedKind };
    const leaseFingerprint = String(action_fingerprint || fingerprint(action));
    state.input_lease = this.inputLeaseFor(state, action, leaseFingerprint, now);
    await this.write(state);
    return state.input_lease;
  }

  async userTakeover(reason = "human_input") {
    const state = await this.readRaw();
    const now = this.clock();
    const interrupted = state.in_flight_action || null;
    state.user_takeover = true;
    state.interaction_paused = true;
    state.takeover_scope = "interactive_input_only";
    state.unattended = false;
    state.pending_action = null;
    state.approval_grant = null;
    state.input_lease = null;
    state.manual_start_proof = null;
    state.in_flight_action = null;
    if (interrupted) {
      state.last_completed_action = {
        trace_id: interrupted.trace_id || null,
        action_fingerprint: interrupted.action_fingerprint || null,
        result: "user_takeover",
        error_source: "human_input",
        error_code: null,
        finished_at: iso(now)
      };
    }
    state.last_pause_reason = String(reason || "human_input").slice(0, 200);
    state.user_takeover_at = iso(now);
    await this.write(state);
    await this.appendEvent({
      trace_id: interrupted?.trace_id || null,
      action_fingerprint: interrupted?.action_fingerprint || null,
      stage: interrupted ? "execution_interrupted_by_user_takeover" : "user_takeover",
      result: interrupted ? "user_takeover" : null,
      error_source: interrupted ? "human_input" : null,
      reason: state.last_pause_reason,
      takeover_scope: "interactive_input_only",
      background_work_preserved: true
    });
    return this.publicState();
  }

  async requestAction({ source, kind, summary, details = null, action_fingerprint = null } = {}) {
    const action = {
      source: String(source || "automation").slice(0, 80),
      kind: String(kind || "unknown").slice(0, 120),
      summary: String(summary || kind || "自动化操作").slice(0, 300),
      details
    };
    const actionFingerprint = String(action_fingerprint || fingerprint(action));
    const state = await this.readRaw();
    const now = this.clock();
    if (!state.running) return { allowed: false, state: "paused", reason: state.last_pause_reason || "manual_start_required", action_fingerprint: actionFingerprint };
    if (state.user_takeover) return { allowed: false, state: "user_takeover", reason: "human_control_active", action_fingerprint: actionFingerprint };
    const inFlight = state.in_flight_action;
    if (inFlight && inFlight.action_fingerprint === actionFingerprint && Date.parse(inFlight.expires_at || "") > now) {
      return { allowed: false, state: "in_flight", reason: "same_action_already_executing", action_fingerprint: actionFingerprint, trace_id: inFlight.trace_id, approval_id: inFlight.approval_id || null };
    }
    const lastCompleted = state.last_completed_action;
    if (lastCompleted && lastCompleted.action_fingerprint === actionFingerprint && lastCompleted.result === "safety_blocked") {
      const blockedAt = Date.parse(lastCompleted.finished_at || "");
      const suppressMs = Math.max(10_000, Number(this.config.safety_block_retry_suppression_seconds || 60) * 1000);
      if (Number.isFinite(blockedAt) && now - blockedAt >= 0 && now - blockedAt < suppressMs) {
        return { allowed: false, state: "safety_blocked_recent", reason: "same_action_recently_blocked_by_safety", action_fingerprint: actionFingerprint, trace_id: lastCompleted.trace_id || null };
      }
    }

    const validation = await this.validationGate();
    const unattendedEffective = Boolean(state.unattended && (this.config.unattended_requires_validation === false || validation.passed));
    if (unattendedEffective) {
      const traceId = crypto.randomUUID();
      const executionSeconds = Math.max(15, Number(this.config.execution_ttl_seconds || 120));
      state.input_lease = this.inputLeaseFor(state, action, actionFingerprint, now);
      state.in_flight_action = {
        trace_id: traceId,
        approval_id: null,
        action_fingerprint: actionFingerprint,
        source: action.source,
        kind: action.kind,
        summary: action.summary,
        started_at: iso(now),
        expires_at: iso(now + executionSeconds * 1000),
        mode: "unattended"
      };
      await this.write(state);
      await this.appendEvent({ trace_id: traceId, action_fingerprint: actionFingerprint, stage: "execution_started", mode: "unattended", source: action.source, kind: action.kind, summary: action.summary });
      return { allowed: true, state: "allowed", mode: "unattended", action_fingerprint: actionFingerprint, trace_id: traceId, input_lease: state.input_lease || null };
    }

    const grant = state.approval_grant;
    if (grant && grant.action_fingerprint === actionFingerprint && Date.parse(grant.expires_at || "") > now) {
      const traceId = grant.trace_id || crypto.randomUUID();
      const executionSeconds = Math.max(15, Number(this.config.execution_ttl_seconds || 120));
      state.approval_grant = null;
      state.input_lease = this.inputLeaseFor(state, action, actionFingerprint, now);
      state.last_executed_approval = { approval_id: grant.approval_id, action_fingerprint: actionFingerprint, trace_id: traceId, consumed_at: iso(now) };
      state.in_flight_action = {
        trace_id: traceId,
        approval_id: grant.approval_id,
        action_fingerprint: actionFingerprint,
        source: action.source,
        kind: action.kind,
        summary: action.summary,
        started_at: iso(now),
        expires_at: iso(now + executionSeconds * 1000),
        mode: "approved_once"
      };
      await this.write(state);
      await this.appendEvent({ trace_id: traceId, approval_id: grant.approval_id, action_fingerprint: actionFingerprint, stage: "execution_started", mode: "approved_once", source: action.source, kind: action.kind, summary: action.summary });
      return { allowed: true, state: "allowed", mode: "approved_once", approval_id: grant.approval_id, action_fingerprint: actionFingerprint, trace_id: traceId, input_lease: state.input_lease || null };
    }

    const existing = state.pending_action;
    if (existing && existing.action_fingerprint === actionFingerprint && Date.parse(existing.expires_at || "") > now) {
      return { allowed: false, state: "approval_required", approval_id: existing.id, pending_action: existing, action_fingerprint: actionFingerprint };
    }

    const id = crypto.randomUUID();
    const pendingSeconds = Math.max(30, Number(this.config.pending_ttl_seconds || 600));
    const traceId = crypto.randomUUID();
    state.pending_action = {
      id, trace_id: traceId, ...action, action_fingerprint: actionFingerprint,
      created_at: iso(now),
      expires_at: iso(now + pendingSeconds * 1000)
    };
    state.approval_grant = null;
    await this.write(state);
    await this.appendEvent({ trace_id: traceId, approval_id: id, action_fingerprint: actionFingerprint, stage: "approval_requested", source: action.source, kind: action.kind, summary: action.summary });
    return { allowed: false, state: "approval_required", approval_id: id, trace_id: traceId, pending_action: state.pending_action, action_fingerprint: actionFingerprint };
  }

  async finishExecution({ action_fingerprint, trace_id = null, result = "succeeded", error_source = null, error_code = null, error_message = null } = {}) {
    const state = await this.readRaw();
    const now = this.clock();
    const inFlight = state.in_flight_action;
    const effectiveTraceId = trace_id || inFlight?.trace_id || null;
    if (inFlight && inFlight.action_fingerprint === action_fingerprint && (!trace_id || inFlight.trace_id === trace_id)) {
      state.in_flight_action = null;
    }
    state.input_lease = null;
    state.last_completed_action = {
      trace_id: effectiveTraceId,
      action_fingerprint: String(action_fingerprint || ""),
      result: String(result || "unknown"),
      error_source: error_source || null,
      error_code: error_code || null,
      finished_at: iso(now)
    };
    await this.write(state);
    await this.appendEvent({
      trace_id: effectiveTraceId,
      action_fingerprint: String(action_fingerprint || ""),
      stage: result === "succeeded" ? "execution_succeeded" : result === "safety_blocked" ? "execution_safety_blocked" : "execution_failed",
      result,
      error_source: error_source || null,
      error_code: error_code || null,
      error_message: error_message ? String(error_message).slice(0, 500) : null
    });
    return this.publicState();
  }

  async observeInput({ injected = false, input_type = "unknown" } = {}) {
    const state = await this.readRaw();
    const now = this.clock();
    if (!state.running) {
      return { classification: "ignored_while_paused", takeover: false, control: await this.publicState() };
    }
    if (state.user_takeover) {
      return { classification: "already_user_takeover", takeover: false, control: await this.publicState() };
    }
    const normalizedInputType = String(input_type || "unknown").slice(0, 40);
    if ((state.pending_action || state.approval_grant) && normalizedInputType === "mouse_move") {
      return { classification: "approval_navigation", takeover: false, control: await this.publicState() };
    }
    if (!injected) {
      return { classification: "human", takeover: true, control: await this.userTakeover(`human_${normalizedInputType}`) };
    }
    const lease = state.input_lease;
    if (lease && Date.parse(lease.expires_at || "") > now && lease.source === "windows-mcp") {
      return { classification: "automation", takeover: false, input_lease: lease, control: await this.publicState() };
    }
    return { classification: "unknown_injected", takeover: true, control: await this.userTakeover(`unknown_injected_${normalizedInputType}`) };
  }

  async decide(approvalId, decision) {
    const normalized = String(decision || "").toLowerCase();
    if (!["allow", "reject"].includes(normalized)) throw new TaskboardError("审批决定无效", { code: "AUTOMATION_DECISION_INVALID", status: 400 });
    const state = await this.readRaw();
    const pending = state.pending_action;
    if (!pending || pending.id !== approvalId) throw new TaskboardError("待审批动作不存在或已变化", { code: "AUTOMATION_APPROVAL_NOT_FOUND", status: 409 });
    const now = this.clock();
    if (Date.parse(pending.expires_at || "") <= now) {
      state.pending_action = null;
      state.approval_grant = null;
      await this.write(state);
      throw new TaskboardError("待审批动作已过期", { code: "AUTOMATION_APPROVAL_EXPIRED", status: 409 });
    }
    state.last_decision = { approval_id: pending.id, decision: normalized, action_fingerprint: pending.action_fingerprint, trace_id: pending.trace_id || null, decided_at: iso(now) };
    state.pending_action = null;
    if (normalized === "allow") {
      const ttlSeconds = Math.max(10, Number(this.config.approval_ttl_seconds || 120));
      state.approval_grant = { approval_id: pending.id, trace_id: pending.trace_id || null, action_fingerprint: pending.action_fingerprint, expires_at: iso(now + ttlSeconds * 1000) };
    } else state.approval_grant = null;
    await this.write(state);
    await this.appendEvent({ trace_id: pending.trace_id || null, approval_id: pending.id, action_fingerprint: pending.action_fingerprint, stage: normalized === "allow" ? "approval_allowed" : "approval_rejected", decision: normalized, source: pending.source, kind: pending.kind, summary: pending.summary });
    return this.publicState();
  }
}
