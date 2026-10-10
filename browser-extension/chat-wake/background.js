let configLoadError = null;
try { importScripts("config.js"); } catch (error) {
  configLoadError = error;
  console.error("Chat Wake config load failed:", error);
}
const GLOBAL_STATUS_BASE_URL = String(globalThis.WYERP_CHAT_WAKE_CONFIG?.baseUrl || "http://127.0.0.1:47831/api/chat-wake");
const GLOBAL_STATUS_TOKEN = String(globalThis.WYERP_CHAT_WAKE_CONFIG?.token || "");
const EXTENSION_VERSION = String(chrome.runtime.getManifest().version || "unknown");
const EXTENSION_FALLBACK_LOG_KEY = "wyerpExtensionFallbackLogs";

function extensionErrorDetails(error) {
  return {
    error_code: error?.code ? String(error.code).slice(0, 200) : null,
    error_message: String(error?.message || error || "unknown").slice(0, 1200)
  };
}

async function persistExtensionFallback(payload) {
  try {
    const saved = await chrome.storage.local.get(EXTENSION_FALLBACK_LOG_KEY);
    const rows = Array.isArray(saved?.[EXTENSION_FALLBACK_LOG_KEY]) ? saved[EXTENSION_FALLBACK_LOG_KEY] : [];
    rows.push({ at: new Date().toISOString(), ...payload });
    await chrome.storage.local.set({ [EXTENSION_FALLBACK_LOG_KEY]: rows.slice(-100) });
    return true;
  } catch (error) {
    console.warn("Chat Wake fallback log persist failed:", error?.message || error);
    return false;
  }
}

async function flushExtensionFallbackLogs() {
  if (!GLOBAL_STATUS_TOKEN) return;
  try {
    const saved = await chrome.storage.local.get(EXTENSION_FALLBACK_LOG_KEY);
    const rows = Array.isArray(saved?.[EXTENSION_FALLBACK_LOG_KEY]) ? saved[EXTENSION_FALLBACK_LOG_KEY] : [];
    if (!rows.length) return;
    let consumed = 0;
    for (const payload of rows) {
      const response = await fetch(
        GLOBAL_STATUS_BASE_URL + "/log-event?token=" + encodeURIComponent(GLOBAL_STATUS_TOKEN),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      if (!response.ok) break;
      consumed += 1;
    }
    if (consumed > 0) {
      await chrome.storage.local.set({ [EXTENSION_FALLBACK_LOG_KEY]: rows.slice(consumed) });
    }
  } catch (error) {
    console.warn("Chat Wake fallback log flush failed:", error?.message || error);
  }
}

async function reportExtensionEvent(level, event, details = {}, error = null) {
  const payload = {
    source: "background",
    level,
    event,
    extension_version: EXTENSION_VERSION,
    ...(error ? extensionErrorDetails(error) : {}),
    details
  };
  if (!GLOBAL_STATUS_TOKEN) {
    await persistExtensionFallback(payload);
    console.warn("Chat Wake log deferred: token unavailable", event);
    return { ok: false, reason: "token_unavailable", persisted_fallback: true };
  }
  try {
    const response = await fetch(
      GLOBAL_STATUS_BASE_URL + "/log-event?token=" + encodeURIComponent(GLOBAL_STATUS_TOKEN),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      await persistExtensionFallback(payload);
      console.warn("Chat Wake log upload failed:", event, response.status);
    }
    return { ok: response.ok, status: response.status };
  } catch (logError) {
    await persistExtensionFallback(payload);
    console.warn("Chat Wake log upload error:", event, logError?.message || logError);
    return { ok: false, reason: "log_upload_failed", persisted_fallback: true };
  }
}

if (configLoadError) void reportExtensionEvent("critical", "config_load_failed", {}, configLoadError);
globalThis.addEventListener?.("error", event => {
  void reportExtensionEvent("error", "uncaught_error", {
    filename: event?.filename || null,
    lineno: event?.lineno || null,
    colno: event?.colno || null
  }, event?.error || event?.message);
});
globalThis.addEventListener?.("unhandledrejection", event => {
  void reportExtensionEvent("error", "unhandled_rejection", {}, event?.reason);
});

async function requestMcpAction(action, payload = {}) {
  // The extension never mutates ChatGPT directly. It may request an action from the local
  // service, where ChatgptMcpExecutor is the sole component allowed to perform GPT changes.
  try {
    const response = await fetch(
      GLOBAL_STATUS_BASE_URL + "/mcp-action?token=" + encodeURIComponent(GLOBAL_STATUS_TOKEN),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload })
      }
    );
    const body = await response.json().catch(error => {
      void reportExtensionEvent("warning", "mcp_action_json_invalid", { action, http_status: response.status }, error);
      return null;
    });
    if (!response.ok) {
      void reportExtensionEvent("warning", "mcp_action_http_failed", { action, http_status: response.status });
      return { ok: false, executed: false, attempted: false, reason: "mcp_action_http_failed", http_status: response.status };
    }
    return body || { ok: false, executed: false, attempted: false, reason: "mcp_action_empty_response" };
  } catch (error) {
    void reportExtensionEvent("error", "mcp_action_request_failed", { action }, error);
    return { ok: false, executed: false, attempted: false, reason: "mcp_action_request_failed" };
  }
}

const CHAT_ROLES = Object.freeze(["developer_ai", "test_ai"]);
const SOFT_WARNING_AT = 15;
const MAX_REQUESTS_PER_SESSION = 20;

function normalizeRoleSessions(raw = {}) {
  const out = {};
  for (const role of CHAT_ROLES) {
    const value = raw?.[role];
    const url = /^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/.test(String(value?.url || "")) ? String(value.url) : null;
    const count = Number(value?.count || 0);
    if (url) out[role] = { url, count: Number.isInteger(count) ? Math.max(0, count) : 0 };
  }
  return out;
}

function routeForRole(role, sessions = {}, settings = {}) {
  if (!CHAT_ROLES.includes(role)) return { allowed: false, reason: "invalid_role" };
  const maxRequests = Math.max(1, Number(settings.max_requests_per_chat || MAX_REQUESTS_PER_SESSION));
  const warningAt = Math.max(1, Math.min(maxRequests, Number(settings.context_warning_at || SOFT_WARNING_AT)));
  const session = sessions[role] || null;
  if (session?.url && Number(session.count || 0) < maxRequests) {
    const requestCount = Number(session.count || 0) + 1;
    return {
      allowed: true,
      newSession: false,
      url: session.url,
      requestCount,
      softWarning: requestCount >= warningAt
    };
  }
  return {
    allowed: true,
    newSession: true,
    url: "https://chatgpt.com/",
    requestCount: 1,
    softWarning: false
  };
}

function executionStarted(status) {
  return Boolean(status?.consumed && status?.consumed_at && status?.claim_event_id);
}

let roleSessions = {};
const queues = new Map();
const active = new Map();
let executionCheckpoints = {};
let dispatcherTabId = null;
let dispatcherEpoch = 0;
const ANOMALY_WINDOW_MS = 10 * 60 * 1000;
const ANOMALY_LIMIT = 6;
const ROLE_SWITCH_LIMIT = 3;
let runtimeSettings = { max_requests_per_chat: 20, context_warning_at: 15, anomaly_window_minutes: 10, anomaly_limit: 6, role_switch_limit: 3 };
let wakeHealth = { events: [], role_switches: { developer_ai: 0, test_ai: 0 }, circuit_open: false };

async function restore() {
  const saved = await chrome.storage.local.get("wyerpRoleSessions").catch(error => {
    void reportExtensionEvent("warning", "role_sessions_restore_failed", {}, error);
    return {};
  });
  roleSessions = normalizeRoleSessions(saved?.wyerpRoleSessions || {});
}

async function restoreDispatcherEpoch() {
  const saved = await chrome.storage.local.get("wyerpDispatcherEpoch").catch(error => {
    void reportExtensionEvent("warning", "dispatcher_epoch_restore_failed", {}, error);
    return {};
  });
  const previous = Number(saved?.wyerpDispatcherEpoch || 0);
  dispatcherEpoch = Math.max(Date.now(), Number.isSafeInteger(previous) ? previous + 1 : Date.now());
  await chrome.storage.local.set({ wyerpDispatcherEpoch: dispatcherEpoch }).catch(error => {
    void reportExtensionEvent("error", "dispatcher_epoch_persist_failed", { dispatcher_epoch: dispatcherEpoch }, error);
  });
}

async function restoreHealth() {
  const saved = await chrome.storage.local.get("wyerpWakeHealth").catch(error => {
    void reportExtensionEvent("warning", "wake_health_restore_failed", {}, error);
    return {};
  });
  const raw = saved?.wyerpWakeHealth || {};
  wakeHealth = {
    events: Array.isArray(raw.events) ? raw.events : [],
    role_switches: {
      developer_ai: Number(raw.role_switches?.developer_ai || 0),
      test_ai: Number(raw.role_switches?.test_ai || 0)
    },
    circuit_open: Boolean(raw.circuit_open)
  };
  pruneHealth();
}

function validCheckpoint(value) {
  const expiresAt = Date.parse(String(value?.candidate?.expires_at || ""));
  return Boolean(
    value &&
    Number.isInteger(Number(value.tab_id)) &&
    value.candidate?.detection_id &&
    value.candidate?.task_id &&
    value.candidate?.project_id &&
    (!Number.isFinite(expiresAt) || expiresAt > Date.now())
  );
}

async function restoreExecutionCheckpoints() {
  const saved = await chrome.storage.local.get("wyerpExecutionCheckpoints").catch(error => {
    void reportExtensionEvent("warning", "execution_checkpoint_restore_failed", {}, error);
    return {};
  });
  const raw = saved?.wyerpExecutionCheckpoints || {};
  executionCheckpoints = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!validCheckpoint(value)) continue;
    executionCheckpoints[key] = value;
  }
  await chrome.storage.local.set({ wyerpExecutionCheckpoints: executionCheckpoints }).catch(error => {
    void reportExtensionEvent("error", "execution_checkpoint_cleanup_persist_failed", {
      checkpoint_count: Object.keys(executionCheckpoints).length
    }, error);
  });
}

async function persistExecutionCheckpoint(tabId) {
  const payload = active.get(tabId);
  const key = String(tabId);
  if (!payload) {
    delete executionCheckpoints[key];
  } else {
    executionCheckpoints[key] = {
      ...payload,
      tab_id: tabId,
      checkpointed_at: Date.now()
    };
  }
  await chrome.storage.local.set({ wyerpExecutionCheckpoints: executionCheckpoints }).catch(error => {
    void reportExtensionEvent("error", "execution_checkpoint_persist_failed", {
      tab_id: tabId,
      checkpoint_present: Boolean(payload)
    }, error);
  });
}

async function clearExecutionCheckpoint(tabId) {
  active.delete(tabId);
  delete executionCheckpoints[String(tabId)];
  await chrome.storage.local.set({ wyerpExecutionCheckpoints: executionCheckpoints }).catch(error => {
    void reportExtensionEvent("error", "execution_checkpoint_clear_failed", { tab_id: tabId }, error);
  });
}

function pruneHealth() {
  const cutoff = Date.now() - Math.max(1, Number(runtimeSettings.anomaly_window_minutes || 10)) * 60 * 1000;
  wakeHealth.events = wakeHealth.events.filter(event => Number(event?.at || 0) >= cutoff);
}

async function persistHealth() {
  pruneHealth();
  await chrome.storage.local.set({ wyerpWakeHealth: wakeHealth }).catch(error => {
    void reportExtensionEvent("error", "wake_health_persist_failed", {
      event_count: wakeHealth.events.length,
      circuit_open: wakeHealth.circuit_open
    }, error);
  });
}

async function ensureChatContentScript(tabId) {
  let state = null;
  try {
    state = await chrome.tabs.sendMessage(tabId, {
      type: "WYERP_READ_CHAT_STATE_V2",
      expected_extension_version: EXTENSION_VERSION
    });
    if (state?.ok && String(state.extension_version || "") === EXTENSION_VERSION) {
      return { injected: false, alive: true, extension_version: EXTENSION_VERSION };
    }
    if (state?.ok || state?.extension_version) {
      void reportExtensionEvent("warning", "content_script_version_mismatch", {
        tab_id: tabId,
        content_version: state?.extension_version || null,
        expected_extension_version: EXTENSION_VERSION
      });
    }
  } catch (error) {
    void reportExtensionEvent("info", "content_script_version_probe_failed_reinjecting", { tab_id: tabId }, error);
  }
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "WYERP_RETIRE_STALE_CONTENT",
      expected_extension_version: EXTENSION_VERSION
    });
  } catch {
    // LOG-IGNORE: runtimes before the versioned-probe contract do not implement retirement.
    // The service-side version/stream gate remains fail-closed and the current script is reinjected below.
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["config.js", "content.js"]
  });
  const verified = await chrome.tabs.sendMessage(tabId, {
    type: "WYERP_READ_CHAT_STATE_V2",
    expected_extension_version: EXTENSION_VERSION
  });
  if (!verified?.ok || String(verified.extension_version || "") !== EXTENSION_VERSION) {
    throw new Error("current Chat Wake content runtime did not become active after reinjection");
  }
  return { injected: true, alive: true, extension_version: EXTENSION_VERSION };
}

async function bootstrapExistingChatTabs() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" }).catch(error => {
    void reportExtensionEvent("error", "chat_tabs_query_failed", {}, error);
    return [];
  });
  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id)) continue;
    await ensureChatContentScript(tab.id).catch(error => {
      void reportExtensionEvent("error", "content_script_bootstrap_failed", { tab_id: tab.id }, error);
    });
  }
}

function recordAnomaly(role, reason) {
  pruneHealth();
  wakeHealth.events.push({ at: Date.now(), role, reason });
}

function shouldOpenCircuit(role) {
  pruneHealth();
  return wakeHealth.events.length >= Math.max(1, Number(runtimeSettings.anomaly_limit || ANOMALY_LIMIT)) ||
    Number(wakeHealth.role_switches?.[role] || 0) >= Math.max(1, Number(runtimeSettings.role_switch_limit || ROLE_SWITCH_LIMIT));
}

const ready = Promise.all([restore(), restoreHealth(), restoreDispatcherEpoch(), restoreExecutionCheckpoints()])
  .then(async () => {
    await flushExtensionFallbackLogs();
    await bootstrapExistingChatTabs();
  });

async function persist() {
  const limited = {};
  for (const role of CHAT_ROLES) {
    if (roleSessions[role]?.url) limited[role] = roleSessions[role];
  }
  await chrome.storage.local.set({ wyerpRoleSessions: limited }).catch(error => {
    void reportExtensionEvent("error", "role_sessions_persist_failed", { roles: Object.keys(limited) }, error);
  });
}

function queueFor(tabId) {
  if (!queues.has(tabId)) queues.set(tabId, []);
  return queues.get(tabId);
}

function scheduleRouteRetry(tabId, delayMs = 1500) {
  setTimeout(() => {
    const current = active.get(tabId);
    if (current && !current.delivered && tabId === dispatcherTabId) void prepareActive(tabId);
  }, delayMs);
}

async function readChatState(tabId) {
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "WYERP_READ_CHAT_STATE" });
    return state?.ok ? state : null;
  } catch {
    return null;
  }
}

async function prepareActive(tabId) {
  const payload = active.get(tabId);
  if (!payload || payload.delivered || tabId !== dispatcherTabId) return;

  const state = await readChatState(tabId);
  if (!state || !state.switch_safe) {
    scheduleRouteRetry(tabId, 1500);
    return;
  }

  if (payload.new_session) {
    if (state.is_new_chat) {
      setTimeout(() => deliver(tabId), 500);
      return;
    }
    try {
      const tab = await chrome.tabs.get(tabId).catch(error => {
        void reportExtensionEvent("warning", "active_tab_lookup_failed", { tab_id: tabId, action: "new_chat" }, error);
        return null;
      });
      const result = await requestMcpAction("new_chat", {
        project_id: payload.candidate.project_id,
        task_id: payload.candidate.task_id,
        detection_id: payload.candidate.detection_id,
        role: payload.target_role || payload.candidate.eligible_role,
        conversation_url: state.conversation_url || state.href || null,
        window_title: tab?.title || null
      });
      if (result?.executed) scheduleRouteRetry(tabId, 800);
      else scheduleRouteRetry(tabId, 1500);
    } catch (error) {
      void reportExtensionEvent("error", "new_chat_route_failed", {
        tab_id: tabId,
        detection_id: payload.candidate?.detection_id || null
      }, error);
      scheduleRouteRetry(tabId, 1500);
    }
    return;
  }

  const targetUrl = String(payload.target_url || "");
  if (!targetUrl) {
    scheduleRouteRetry(tabId, 1500);
    return;
  }
  if (state.conversation_url === targetUrl || state.href === targetUrl) {
    setTimeout(() => deliver(tabId), 500);
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(error => {
    void reportExtensionEvent("warning", "active_tab_lookup_failed", { tab_id: tabId, action: "navigate_session" }, error);
    return null;
  });
  const result = await requestMcpAction("navigate_session", {
    project_id: payload.candidate.project_id,
    task_id: payload.candidate.task_id,
    detection_id: payload.candidate.detection_id,
    role: payload.target_role || payload.candidate.eligible_role,
    conversation_url: state.conversation_url || state.href || null,
    target_url: targetUrl,
    window_title: tab?.title || null
  });
  scheduleRouteRetry(tabId, result?.executed ? 1200 : 1500);
}

function processNext(tabId) {
  if (tabId !== dispatcherTabId || active.has(tabId)) return;
  const q = queueFor(tabId);
  const payload = q.shift();
  if (!payload) return;

  const decision = routeForRole(payload.candidate.eligible_role, roleSessions, payload.execution_settings || runtimeSettings);
  if (!decision.allowed) return;

  const routed = {
    ...payload,
    request_count: decision.requestCount,
    target_role: payload.candidate.eligible_role,
    new_session: decision.newSession,
    target_url: decision.newSession ? null : decision.url,
    soft_warning: decision.softWarning,
    delivered: false
  };
  active.set(tabId, routed);
  void persistExecutionCheckpoint(tabId);
  void prepareActive(tabId);
}

function scheduleDeliveryRetry(tabId, delayMs) {
  setTimeout(() => {
    const current = active.get(tabId);
    if (current && !current.delivered && tabId === dispatcherTabId) deliver(tabId);
  }, delayMs);
}

function deliver(tabId) {
  const payload = active.get(tabId);
  if (!payload || payload.delivered || tabId !== dispatcherTabId) return;
  chrome.tabs.sendMessage(tabId, { type: "WYERP_ROLE_CANDIDATE", ...payload })
    .then(() => scheduleDeliveryRetry(tabId, 2500))
    .catch(error => {
      void reportExtensionEvent("warning", "candidate_delivery_failed", {
        tab_id: tabId,
        detection_id: payload.candidate?.detection_id || null
      }, error);
      scheduleDeliveryRetry(tabId, 500);
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void ready.then(() => {
  const tabId = sender.tab?.id;

  if (msg?.type === "WYERP_EXTENSION_LOG_EVENT") {
    void reportExtensionEvent(
      ["info", "warning", "error", "critical"].includes(String(msg.level || "")) ? String(msg.level) : "warning",
      String(msg.event || "overlay_event").slice(0, 160),
      { source: msg.source || "overlay", ...(msg.details || {}) },
      msg.error_message ? new Error(String(msg.error_message).slice(0, 1200)) : null
    ).then(result => sendResponse?.(result));
    return true;
  }

  if (msg?.type === "WYERP_GET_GLOBAL_STATUS") {
    // Existing status branch remains below.
    if (!GLOBAL_STATUS_TOKEN) {
      sendResponse?.({ ok: false, reason: "global_status_token_missing" });
      return true;
    }
    fetch(
      GLOBAL_STATUS_BASE_URL + "/global-status?token=" + encodeURIComponent(GLOBAL_STATUS_TOKEN),
      { cache: "no-store" }
    )
      .then(async response => {
        const status = await response.json().catch(error => {
          void reportExtensionEvent("warning", "global_status_json_invalid", { http_status: response.status }, error);
          return null;
        });
        sendResponse?.({ ok: response.ok, status, http_status: response.status });
      })
      .catch(error => {
        void reportExtensionEvent("warning", "global_status_unreachable", {}, error);
        sendResponse?.({
          ok: false,
          reason: "global_status_unreachable",
          error: String(error?.message || error).slice(0, 200)
        });
      });
    return true;
  }

  if (msg?.type === "WYERP_EXTENSION_OUTDATED" && tabId) {
    const currentVersion = String(chrome.runtime.getManifest().version || "");
    const latestVersion = String(msg.latest_version || "");
    const pageUrl = String(msg.page_url || "");
    void chrome.storage.local.set({
      wyerpExtensionWarning: {
        kind: "extension_runtime_outdated",
        tab_id: tabId,
        current_version: currentVersion,
        latest_version: latestVersion || null,
        page_url: pageUrl.startsWith("https://chatgpt.com/") ? pageUrl : null,
        detected_at: Number(msg.detected_at || Date.now())
      }
    }).then(() => {
      sendResponse?.({
        ok: true,
        action: "hold_for_manual_extension_reload",
        current_version: currentVersion,
        latest_version: latestVersion || null
      });
    }).catch(error => {
      void reportExtensionEvent("error", "extension_warning_persist_failed", { current_version: currentVersion, latest_version: latestVersion || null }, error);
      sendResponse?.({ ok: false, reason: "extension_warning_persist_failed" });
    });
    return true;
  }

  if (msg?.type === "WYERP_REGISTER_DISPATCHER" && tabId) {
    if (dispatcherTabId == null || dispatcherTabId === tabId) dispatcherTabId = tabId;
    if (dispatcherTabId === tabId && !active.has(tabId)) {
      const checkpoint = executionCheckpoints[String(tabId)];
      if (validCheckpoint(checkpoint)) {
        active.set(tabId, checkpoint);
        if (!checkpoint.delivered || checkpoint.last_error) {
          checkpoint.delivered = false;
          checkpoint.recovery_after_timeout = true;
          void persistExecutionCheckpoint(tabId);
          setTimeout(() => void prepareActive(tabId), 500);
        }
      }
    }
    sendResponse?.({ ok: true, dispatcher: dispatcherTabId === tabId, dispatcher_tab_id: dispatcherTabId, dispatcher_epoch: dispatcherEpoch });
    return true;
  }

  if (msg?.type === "WYERP_ROUTE_ROLE_CHAT" && msg.candidate && tabId) {
    if (tabId !== dispatcherTabId) {
      sendResponse?.({ ok: false, reason: "not_dispatcher" });
      return true;
    }
    const detectionId = msg.candidate.detection_id;
    const current = active.get(tabId);
    const duplicateActive = current?.candidate?.detection_id === detectionId;
    const duplicateQueued = queueFor(tabId).some(item => item?.candidate?.detection_id === detectionId);
    if (!duplicateActive && !duplicateQueued) {
      runtimeSettings = { ...runtimeSettings, ...(msg.execution_settings || {}) };
      queueFor(tabId).push({ candidate: msg.candidate, lease_client_id: msg.lease_client_id || null, execution_settings: runtimeSettings });
    }
    processNext(tabId);
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === "WYERP_ROLE_CANDIDATE_STARTED" && tabId) {
    const current = active.get(tabId);
    if (
      tabId === dispatcherTabId &&
      current?.candidate?.detection_id &&
      current.candidate.detection_id === msg.detection_id
    ) {
      current.delivered = true;
      current.started_at = Date.now();
      void persistExecutionCheckpoint(tabId);
      sendResponse?.({ ok: true });
    } else {
      sendResponse?.({ ok: false, reason: "candidate_not_active" });
    }
    return true;
  }

  if (msg?.type === "WYERP_ROLE_SESSION_BOUND" && msg.role && msg.url && tabId) {
    if (tabId !== dispatcherTabId || !CHAT_ROLES.includes(msg.role)) return true;
    roleSessions[msg.role] = {
      url: msg.url,
      count: Math.max(1, Math.min(Math.max(1, Number(msg.max_requests_per_chat || runtimeSettings.max_requests_per_chat || MAX_REQUESTS_PER_SESSION)), Number(msg.count || 1)))
    };
    wakeHealth.role_switches[msg.role] = 0;
    wakeHealth.circuit_open = false;
    void persist();
    void persistHealth();
    void clearExecutionCheckpoint(tabId);
    setTimeout(() => processNext(tabId), 3000);
    sendResponse?.({ ok: true });
    return true;
  }

  if (msg?.type === "WYERP_ROLE_EXECUTION_BLOCKED" && tabId) {
    if (tabId !== dispatcherTabId || !CHAT_ROLES.includes(msg.role)) return true;
    const current = active.get(tabId);
    recordAnomaly(msg.role, msg.reason || "unknown");

    const replaceable = new Set([
      "retry_recovery_exhausted",
      "processing_delayed_recovery_exhausted",
      "execution_error_recovery_exhausted",
      "ui_stability_timeout",
      "execution_error_no_retry"
    ]);

    if (shouldOpenCircuit(msg.role)) {
      wakeHealth.circuit_open = true;
      void persistHealth();
      sendResponse?.({ ok: true, action: "circuit_open" });
      return true;
    }

    if (current && replaceable.has(msg.reason)) {
      wakeHealth.role_switches[msg.role] = Number(wakeHealth.role_switches[msg.role] || 0) + 1;
      delete roleSessions[msg.role];
      void persist();
      void persistHealth();

      current.request_count = 1;
      current.new_session = true;
      current.recovery_after_timeout = true;
      current.delivered = false;
      current.soft_warning = false;
      current.last_error = msg.reason || "unknown";
      current.last_error_at = Date.now();
      void persistExecutionCheckpoint(tabId);

      current.target_url = null;
      setTimeout(() => {
        if (active.get(tabId) !== current || tabId !== dispatcherTabId) return;
        void prepareActive(tabId);
      }, 3000);

      sendResponse?.({ ok: true, action: "replace_role_session" });
      return true;
    }

    void persistHealth();
    sendResponse?.({ ok: true, action: "hold" });
    return true;
  }

  if (msg?.type === "WYERP_GLOBAL_EXECUTION_BLOCKED" && tabId) {
    const current = active.get(tabId);
    const role = current?.target_role || current?.candidate?.eligible_role || null;
    if (current && role && CHAT_ROLES.includes(role)) {
      recordAnomaly(role, msg.reason || "execution_error_recovery_exhausted");
      current.recovery_after_timeout = true;
      current.delivered = false;
      current.last_error = msg.reason || "execution_error_recovery_exhausted";
      current.last_error_at = Date.now();
      void persistHealth();
      void persistExecutionCheckpoint(tabId);
      setTimeout(() => void prepareActive(tabId), 1000);
      sendResponse?.({ ok: true, action: "resume_checkpoint" });
    } else {
      sendResponse?.({ ok: true, action: "no_active_checkpoint" });
    }
    return true;
  }
  }).catch(error => {
    void reportExtensionEvent("critical", "background_message_handler_failed", { message_type: msg?.type || null, tab_id: sender.tab?.id || null }, error);
    sendResponse?.({ ok: false, reason: "background_init_failed" });
  });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void ready.then(() => {
  if (tabId !== dispatcherTabId || changeInfo.status !== "complete") return;
  const payload = active.get(tabId);
  if (!payload || payload.delivered) return;
  if (!String(tab.url || "").startsWith("https://chatgpt.com/")) return;
  setTimeout(() => { void prepareActive(tabId); }, 800);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void ready.then(() => {
  queues.delete(tabId);
  void clearExecutionCheckpoint(tabId);
  if (dispatcherTabId === tabId) dispatcherTabId = null;
  });
});
