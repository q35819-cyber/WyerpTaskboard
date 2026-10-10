import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { SystemEventLog } from "./system-event-log.mjs";

function iso(ms) { return new Date(ms).toISOString(); }
function cleanRef(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9._:/-]{1,160}$/.test(text) ? text : null;
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export class ChatBrowserWake {
  constructor(rootDir, { clock = () => Date.now(), systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.configPath = path.join(rootDir, "config", "chat-browser-wake.json");
    this.statePath = path.join(rootDir, "data", "runtime", "task-scan", "chat-browser-wake.json");
    this.config = null;
    this.latestDispatcherEpoch = 0;
    this.latestDispatcherClientId = null;
    this.systemEventLog = systemEventLog;
    this.stateWriteChain = Promise.resolve();
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    try {
      this.config = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    } catch (error) {
      await this.systemEventLog.error("chat-wake-server", "config_load_failed", error, { config_path: this.configPath });
      throw error;
    }
    if (!this.config?.token || String(this.config.token).length < 32) {
      const error = new Error("chat browser wake token missing");
      await this.systemEventLog.error("chat-wake-server", "config_invalid", error, { token_present: Boolean(this.config?.token) });
      throw error;
    }
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    return this;
  }

  verifyConfiguredToken(token) {
    return Boolean(this.config?.token && safeEqual(token, this.config.token));
  }

  verifyToken(token) {
    return Boolean(this.config?.enabled && this.verifyConfiguredToken(token));
  }

  verifyExtensionVersion(version) {
    const expected = String(this.config?.expected_extension_version || "").trim();
    const actual = String(version || "").trim();
    return Boolean(expected && actual && expected === actual);
  }


  admitDispatcher(clientId, dispatcherEpoch) {
    const client = cleanRef(clientId);
    const epoch = Number(dispatcherEpoch);
    if (!client || !Number.isSafeInteger(epoch) || epoch <= 0) {
      void this.systemEventLog?.append({
        level: "warning", component: "chat-wake-server", event: "dispatcher_invalid", result: "rejected",
        details: { client_id_valid: Boolean(client), dispatcher_epoch: Number.isFinite(epoch) ? epoch : null }
      });
      return { allowed: false, state: "invalid_dispatcher" };
    }
    if (epoch < this.latestDispatcherEpoch) {
      void this.systemEventLog?.append({
        level: "warning", component: "chat-wake-server", event: "dispatcher_superseded", result: "rejected",
        details: { client_id: client, dispatcher_epoch: epoch, latest_dispatcher_epoch: this.latestDispatcherEpoch }
      });
      return { allowed: false, state: "superseded", dispatcher_epoch: epoch, latest_dispatcher_epoch: this.latestDispatcherEpoch };
    }
    if (epoch > this.latestDispatcherEpoch) {
      this.latestDispatcherEpoch = epoch;
      this.latestDispatcherClientId = client;
    } else if (this.latestDispatcherClientId && this.latestDispatcherClientId !== client) {
      void this.systemEventLog?.append({
        level: "warning", component: "chat-wake-server", event: "dispatcher_client_conflict", result: "rejected",
        details: { client_id: client, dispatcher_epoch: epoch, latest_client_id: this.latestDispatcherClientId }
      });
      return { allowed: false, state: "superseded", dispatcher_epoch: epoch, latest_dispatcher_epoch: this.latestDispatcherEpoch };
    } else if (!this.latestDispatcherClientId) {
      this.latestDispatcherClientId = client;
    }
    return { allowed: true, state: "current", client_id: client, dispatcher_epoch: epoch };
  }

  async readState() {
    try {
      const value = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      return { version: 1, leases: {}, acked: {}, dispatcher: null, ...value };
    } catch (error) {
      if (error.code !== "ENOENT") {
        await this.systemEventLog?.error("chat-wake-server", "state_read_failed", error, { state_path: this.statePath });
        throw error;
      }
      return { version: 1, leases: {}, acked: {}, dispatcher: null, updated_at: null };
    }
  }

  async writeState(state) {
    const snapshot = { ...state, updated_at: iso(this.clock()) };
    const payload = JSON.stringify(snapshot, null, 2) + "\n";
    const run = async () => {
      const tmp = this.statePath + ".tmp-" + process.pid + "-" + crypto.randomUUID();
      await fs.writeFile(tmp, payload, "utf8");
      let lastError = null;
      try {
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          try {
            await fs.rename(tmp, this.statePath);
            return;
          } catch (error) {
            lastError = error;
            if (!["EPERM", "EACCES", "EBUSY"].includes(String(error?.code || "")) || attempt === 5) throw error;
            if (attempt === 1) {
              await this.systemEventLog?.append({
                level: "warning",
                component: "chat-wake-server",
                event: "state_write_retry",
                result: "retrying",
                error_code: error.code || null,
                error_message: error.message || String(error),
                details: { attempt, state_path: this.statePath }
              });
            }
            await new Promise(resolve => setTimeout(resolve, attempt * 25));
          }
        }
        if (lastError) throw lastError;
      } finally {
        await fs.rm(tmp, { force: true }).catch(() => { /* LOG-IGNORE: best-effort temp cleanup after write outcome. */ });
      }
    };
    this.stateWriteChain = this.stateWriteChain.catch(() => { /* LOG-IGNORE: recover the write queue; the failed write is surfaced by its original caller/log path. */ }).then(run);
    return this.stateWriteChain;
  }

  async claim(candidates, clientId, preferredRole = null, dispatcherEpoch = null) {
    if (!this.config?.enabled) return { state: "disabled" };
    const gate = this.admitDispatcher(clientId, dispatcherEpoch);
    if (!gate.allowed) return { state: gate.state, latest_dispatcher_epoch: gate.latest_dispatcher_epoch || null };
    const client = gate.client_id;
    const epoch = gate.dispatcher_epoch;
    const role = preferredRole && ["developer_ai", "test_ai"].includes(preferredRole) ? preferredRole : null;
    const state = await this.readState();
    const now = this.clock();
    const leaseMs = Math.max(5000, Number(this.config.lease_ms || 30000));
    const heartbeatMs = 30_000;
    const previousSeen = Number(state.dispatcher?.last_seen_at_ms || 0);
    const dispatcherChanged =
      state.dispatcher?.client_id !== client ||
      Number(state.dispatcher?.dispatcher_epoch || 0) !== epoch;
    const heartbeatDue = dispatcherChanged || now - previousSeen >= heartbeatMs;
    if (heartbeatDue) {
      const previous = dispatcherChanged ? {} : (state.dispatcher || {});
      state.dispatcher = {
        ...previous,
        client_id: client,
        dispatcher_epoch: epoch,
        role: role || previous.role || null,
        last_seen_at: iso(now),
        last_seen_at_ms: now
      };
    }

    for (const item of (candidates || [])) {
      if (!item?.eligible || (role && item.eligible_role !== role)) continue;
      const candidate = {
        project_id: cleanRef(item.project_id),
        task_id: cleanRef(item.task_id),
        detection_id: cleanRef(item.detection_id),
        eligible_role: cleanRef(item.eligible_role)
      };
      if (Object.values(candidate).some(value => !value)) continue;
      if (state.acked[candidate.detection_id]) continue;

      const lease = state.leases[candidate.detection_id];
      if (lease && Number(lease.expires_at_ms || 0) > now) {
        const leaseEpoch = Number(lease.dispatcher_epoch || 0);
        if (lease.client_id === client && leaseEpoch === epoch) return { state: "candidate", candidate };
        if (leaseEpoch >= epoch) continue;
      }

      state.leases[candidate.detection_id] = {
        client_id: client,
        dispatcher_epoch: epoch,
        leased_at: iso(now),
        expires_at: iso(now + leaseMs),
        expires_at_ms: now + leaseMs
      };
      await this.writeState(state);
      return { state: "candidate", candidate };
    }
    if (heartbeatDue) await this.writeState(state);
    return { state: "no_candidate" };
  }
  async uiHeartbeat(clientId, metadata = {}) {
    const gate = this.admitDispatcher(clientId, metadata.dispatcher_epoch);
    if (!gate.allowed) return { state: gate.state, latest_dispatcher_epoch: gate.latest_dispatcher_epoch || null };

    const state = await this.readState();
    const now = this.clock();
    const previous =
      state.dispatcher?.client_id === gate.client_id &&
      Number(state.dispatcher?.dispatcher_epoch || 0) === gate.dispatcher_epoch
        ? state.dispatcher
        : {};

    const allowedStates = new Set(["stable", "generating", "processing_delayed", "execution_error", "login_required", "unknown"]);
    const uiState = allowedStates.has(String(metadata.ui_state || "")) ? String(metadata.ui_state) : "unknown";
    const stateChanged = previous.ui_state !== uiState;
    const composerPresent = metadata.composer_present === true;
    const allowedRecoveryStatuses = new Set(["started", "succeeded", "failed", "exhausted"]);
    const allowedRecoveryActions = new Set(["stop_and_continue", "retry_or_continue"]);
    const allowedActivityPhases = new Set(["idle", "busy", "preparing", "prompt_sent", "waiting_claim", "executing", "recovering", "completed", "blocked"]);
    const activityPhase = allowedActivityPhases.has(String(metadata.activity_phase || ""))
      ? String(metadata.activity_phase)
      : (previous.activity_phase || "idle");
    const recoveryAction = allowedRecoveryActions.has(String(metadata.recovery_action || ""))
      ? String(metadata.recovery_action)
      : null;
    const recoveryStatus = allowedRecoveryStatuses.has(String(metadata.recovery_status || ""))
      ? String(metadata.recovery_status)
      : null;
    const recoveryAttempt = Number(metadata.recovery_attempt || 0);
    const conversation = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(String(metadata.conversation_url || ""))
      ? String(metadata.conversation_url)
      : null;

    let recoveryEvent = null;
    if (
      recoveryAction &&
      recoveryStatus &&
      Number.isInteger(recoveryAttempt) &&
      recoveryAttempt > 0 &&
      recoveryAttempt <= 10
    ) {
      recoveryEvent = {
        at: iso(now),
        action: recoveryAction,
        status: recoveryStatus,
        attempt: recoveryAttempt,
        reason: String(metadata.recovery_reason || "").slice(0, 160) || null,
        conversation_url: conversation
      };
      state.recovery_events = [...(Array.isArray(state.recovery_events) ? state.recovery_events : []), recoveryEvent].slice(-50);
      if (["failed", "exhausted"].includes(recoveryStatus)) {
        await this.systemEventLog?.append({
          level: recoveryStatus === "exhausted" ? "error" : "warning",
          component: "chat-wake-server",
          event: "recovery_" + recoveryStatus,
          detection_id: cleanRef(metadata.activity_detection_id) || null,
          result: recoveryStatus,
          details: recoveryEvent
        });
      }
    }

    state.dispatcher = {
      ...previous,
      client_id: gate.client_id,
      dispatcher_epoch: gate.dispatcher_epoch,
      extension_version: cleanRef(metadata.extension_version) || previous.extension_version || null,
      last_seen_at: iso(now),
      last_seen_at_ms: now,
      last_ui_seen_at: iso(now),
      last_ui_seen_at_ms: now,
      ui_state: uiState,
      ui_state_since_at: stateChanged ? iso(now) : (previous.ui_state_since_at || iso(now)),
      ui_state_since_at_ms: stateChanged ? now : Number(previous.ui_state_since_at_ms || now),
      composer_present: composerPresent,
      composer_empty: metadata.composer_empty === true,
      content_busy: metadata.content_busy === true,
      switch_safe: metadata.switch_safe === true,
      activity_project_id: cleanRef(metadata.activity_project_id) || previous.activity_project_id || null,
      activity_task_id: cleanRef(metadata.activity_task_id) || previous.activity_task_id || null,
      activity_detection_id: cleanRef(metadata.activity_detection_id) || previous.activity_detection_id || null,
      activity_role: cleanRef(metadata.activity_role) || previous.activity_role || null,
      activity_phase: activityPhase,
      activity_updated_at: iso(now),
      is_new_chat: metadata.is_new_chat === true,
      conversation_url: conversation,
      composer_missing_since_at: composerPresent ? null : (previous.composer_missing_since_at || iso(now)),
      composer_missing_since_at_ms: composerPresent ? null : Number(previous.composer_missing_since_at_ms || now),
      recovery: recoveryEvent || previous.recovery || null
    };

    await this.writeState(state);
    if (stateChanged && ["execution_error", "login_required"].includes(uiState)) {
      await this.systemEventLog?.append({
        level: "warning",
        component: "chat-wake-server",
        event: "ui_state_anomaly",
        project_id: state.dispatcher.activity_project_id || null,
        task_id: state.dispatcher.activity_task_id || null,
        detection_id: state.dispatcher.activity_detection_id || null,
        result: uiState,
        extension_version: state.dispatcher.extension_version || null,
        details: { ui_state: uiState, activity_phase: state.dispatcher.activity_phase }
      });
    }
    return { state: "heartbeat", ui_state: uiState };
  }

  async ack(detectionId, clientId, metadata = {}) {
    const detection = cleanRef(detectionId);
    const gate = this.admitDispatcher(clientId, metadata.dispatcher_epoch);
    if (!detection || !gate.allowed) {
      await this.systemEventLog?.append({
        level: "warning",
        component: "chat-wake-server",
        event: "ack_rejected",
        detection_id: detection || null,
        result: detection ? gate.state : "invalid"
      });
      return { state: detection ? gate.state : "invalid" };
    }
    const client = gate.client_id;
    const epoch = gate.dispatcher_epoch;
    const state = await this.readState();
    const lease = state.leases[detection];
    if (
      lease &&
      Number(lease.expires_at_ms || 0) > this.clock() &&
      (lease.client_id !== client || Number(lease.dispatcher_epoch || 0) !== epoch)
    ) {
      await this.systemEventLog?.append({
        level: "warning",
        component: "chat-wake-server",
        event: "ack_lease_mismatch",
        detection_id: detection,
        result: "lease_mismatch",
        details: {
          lease_client_id: lease.client_id,
          request_client_id: client,
          lease_dispatcher_epoch: Number(lease.dispatcher_epoch || 0),
          request_dispatcher_epoch: epoch
        }
      });
      return { state: "lease_mismatch" };
    }
    const role = ["developer_ai", "test_ai"].includes(String(metadata.role || "")) ? String(metadata.role) : null;
    const url = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(String(metadata.conversation_url || "")) ? String(metadata.conversation_url) : null;
    const requestCount = Number(metadata.request_count || 0);
    state.acked[detection] = {
      at: iso(this.clock()),
      client_id: client,
      dispatcher_epoch: epoch,
      role,
      conversation_url: url,
      request_count: Number.isInteger(requestCount) && requestCount > 0 && requestCount <= 20 ? requestCount : null
    };
    delete state.leases[detection];
    await this.writeState(state);
    return { state: "acked", detection_id: detection };
  }

  publicStatus() {
    return {
      enabled: Boolean(this.config?.enabled),
      mode: "browser_extension_chat_only",
      endpoint: "127.0.0.1",
      verified: Boolean(this.config?.verified),
      expected_extension_version: String(this.config?.expected_extension_version || "") || null
    };
  }
}
