(() => {
  const cfg = globalThis.WYERP_CHAT_WAKE_CONFIG;
  if (!cfg?.token || !cfg?.baseUrl) return;
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.getManifest || !runtime?.sendMessage) return;
  const extensionVersion = runtime.getManifest().version;
  const previousRuntimeInstance = globalThis.__WYERP_CHAT_WAKE_CONTENT_INSTANCE__;
  if (previousRuntimeInstance?.retire) {
    try {
      previousRuntimeInstance.retire("reinjected");
    } catch {
      // LOG-IGNORE: a stale extension context may throw while retiring. The fresh runtime below
      // replaces its generation marker and the server-side dispatcher epoch still fails closed.
    }
  }
  const runtimeInstance = {
    version: extensionVersion,
    generation: crypto.randomUUID(),
    retired: false,
    retire: null
  };
  globalThis.__WYERP_CHAT_WAKE_CONTENT_INSTANCE__ = runtimeInstance;
  globalThis.__WYERP_CHAT_WAKE_CONTENT_ACTIVE__ = extensionVersion;
  let verifiedTaskboardVersion = null;
  let verifiedExtensionLatestVersion = null;
  let contentRetired = false;
  const clientKey = "wyerp_chat_wake_client";
  const clientId = sessionStorage.getItem(clientKey) || crypto.randomUUID();
  sessionStorage.setItem(clientKey, clientId);
  const ref = /^[A-Za-z0-9._:/-]{1,160}$/;

  let busy = false;
  let isDispatcher = false;
  let dispatcherEpoch = 0;
  let uiHeartbeatTimer = null;
  let currentExecutionContext = null;
  let eventSource = null;
  let reconnectTimer = null;
  let sseErrorReportedAt = 0;

  const DELAYED_RECOVERY_CONFIRM_MS = 3000;
  const DELAYED_RECOVERY_MAX_ATTEMPTS = 3;
  const DELAYED_RECOVERY_STABLE_RESET_MS = 5000;
  let delayedRecoveryTimer = null;
  let delayedRecoveryMonitorTimer = null;
  let delayedRecoveryInFlight = false;
  let delayedRecoveryAttempts = 0;
  let delayedRecoveryExhaustedReported = false;
  let delayedRecoveryConversationKey = null;
  let delayedRecoveryStableSince = null;

  const ERROR_RECOVERY_CONFIRM_MS = 1500;
  const ERROR_RECOVERY_MAX_ATTEMPTS = 3;
  const ERROR_RECOVERY_GATE_POLL_MS = 5000;
  const ERROR_RECOVERY_STABLE_RESET_MS = 10000;
  let errorRecoveryTimer = null;
  let errorRecoveryInFlight = false;
  let errorRecoveryAttempts = 0;
  let errorRecoveryExhaustedReported = false;
  let errorRecoveryConversationKey = null;
  let errorRecoveryStableSince = null;
  let errorRecoveryGateState = null;
  let errorRecoveryNextGatePollAt = 0;

  function contentErrorDetails(error) {
    return {
      error_code: error?.code ? String(error.code).slice(0, 200) : null,
      error_message: String(error?.message || error || "unknown").slice(0, 1200)
    };
  }

  async function persistContentFallback(payload) {
    try {
      const key = "wyerpExtensionFallbackLogs";
      const saved = await chrome.storage.local.get(key);
      const rows = Array.isArray(saved?.[key]) ? saved[key] : [];
      rows.push({ at: new Date().toISOString(), ...payload });
      await chrome.storage.local.set({ [key]: rows.slice(-100) });
      return true;
    } catch (fallbackError) {
      console.warn("Chat Wake content fallback log persist failed:", fallbackError?.message || fallbackError);
      return false;
    }
  }

  async function reportExtensionEvent(level, event, details = {}, error = null) {
    const payload = {
      source: "content",
      level,
      event,
      extension_version: extensionVersion,
      project_id: currentExecutionContext?.project_id || null,
      task_id: currentExecutionContext?.task_id || null,
      detection_id: currentExecutionContext?.detection_id || null,
      ...(error ? contentErrorDetails(error) : {}),
      details
    };
    try {
      const response = await fetch(
        cfg.baseUrl + "/log-event?token=" + encodeURIComponent(cfg.token),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
      if (!response.ok) {
        await persistContentFallback(payload);
        console.warn("Chat Wake content log upload failed:", event, response.status);
      }
      return { ok: response.ok, status: response.status };
    } catch (logError) {
      await persistContentFallback(payload);
      console.warn("Chat Wake content log upload error:", event, logError?.message || logError);
      return { ok: false, reason: "log_upload_failed", persisted_fallback: true };
    }
  }

  async function requestMcpAction(action, payload = {}) {
    try {
      const response = await fetch(
        cfg.baseUrl + "/mcp-action?token=" + encodeURIComponent(cfg.token),
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

  const extensionOrigin = "chrome-extension://" + String(runtime.id || "") + "/";

  function isContextInvalidated(value) {
    return /Extension context invalidated/i.test(String(value?.message || value || ""));
  }

  function isExtensionOwnedFailure(value, filename = "") {
    const message = String(value?.message || value || "");
    const stack = String(value?.stack || "");
    const source = String(filename || "");
    return source.startsWith(extensionOrigin) ||
      stack.includes(extensionOrigin) ||
      /Extension context invalidated/i.test(message);
  }

  function onContentError(event) {
    const failure = event?.error || event?.message;
    if (!isExtensionOwnedFailure(failure, event?.filename)) {
      // LOG-IGNORE: window.error also receives ChatGPT page errors (for example ResizeObserver).
      // They are not extension failures and must not pollute the extension/system error timeline.
      return;
    }
    if (isContextInvalidated(failure)) retireContentRuntime("extension_context_invalidated");
    void reportExtensionEvent("error", "uncaught_error", {
      filename: event?.filename || null,
      lineno: event?.lineno || null,
      colno: event?.colno || null
    }, failure);
  }

  function onContentUnhandledRejection(event) {
    if (!isExtensionOwnedFailure(event?.reason)) {
      // LOG-IGNORE: page-owned promise rejections are outside the extension runtime boundary.
      return;
    }
    if (isContextInvalidated(event?.reason)) retireContentRuntime("extension_context_invalidated");
    void reportExtensionEvent("error", "unhandled_rejection", {}, event?.reason);
  }

  globalThis.addEventListener?.("error", onContentError);
  globalThis.addEventListener?.("unhandledrejection", onContentUnhandledRejection);

  function validCandidate(x) {
    const hasOwnerBinding = Boolean(x?.eligible_actor_id || x?.eligible_session_id);
    const ownerBindingValid = !hasOwnerBinding || [
      x?.eligible_actor_id, x?.eligible_session_id
    ].every(v => ref.test(String(v || "")));
    return Boolean(
      x &&
      [x.project_id, x.task_id, x.detection_id, x.eligible_role].every(v => ref.test(String(v || ""))) &&
      ["developer_ai", "test_ai"].includes(String(x.eligible_role)) &&
      ownerBindingValid
    );
  }

  function composer() {
    return document.querySelector("#prompt-textarea") ||
      document.querySelector('div[contenteditable="true"][data-virtualkeyboard="true"]') ||
      document.querySelector('div[contenteditable="true"]');
  }

  function composerText(el) {
    return String(el?.value ?? el?.innerText ?? el?.textContent ?? "").trim();
  }

  function conversationUrl() {
    return /^\/c\/[A-Za-z0-9-]+/.test(location.pathname) ? location.href : null;
  }

  function newChatControl() {
    const direct = document.querySelector('[data-testid="create-new-chat-button"]');
    if (direct) return direct.closest("a,button") || direct;
    return [...document.querySelectorAll("a,button")].find(element => {
      const label = String(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.innerText ||
        element.textContent ||
        ""
      ).trim();
      return /^(new chat|新聊天|新建聊天|开始新聊天)$/i.test(label);
    }) || null;
  }

  function loginRequired() {
    if (/^\/auth\b/i.test(location.pathname)) return true;
    return [...document.querySelectorAll("a,button")].some(element => {
      const label = String(
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.innerText ||
        element.textContent ||
        ""
      ).trim();
      return /^(log in|sign in|登录|登陆)$/i.test(label);
    });
  }

  function readChatState() {
    const el = composer();
    const login = loginRequired();
    const ui = uiExecutionState();
    const uiState = login ? "login_required" : ui.state;
    const currentConversation = conversationUrl();
    const composerEmpty = Boolean(el) && !composerText(el);
    return {
      ok: true,
      extension_version: extensionVersion,
      href: location.href,
      conversation_url: currentConversation,
      is_new_chat: location.origin === "https://chatgpt.com" && !currentConversation,
      ui_state: uiState,
      composer_present: Boolean(el),
      composer_empty: composerEmpty,
      content_busy: busy,
      new_chat_available: Boolean(newChatControl()),
      switch_safe: uiState === "stable" && Boolean(el) && composerEmpty && !busy
    };
  }

  async function sendUiHeartbeat(extra = {}) {
    if (contentRetired || !isDispatcher || !dispatcherEpoch) return;
    const state = readChatState();
    try {
      await fetch(cfg.baseUrl + "/ui-heartbeat?token=" + encodeURIComponent(cfg.token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          dispatcher_epoch: dispatcherEpoch,
          extension_version: extensionVersion,
          ui_state: state.ui_state,
          conversation_url: state.conversation_url,
          is_new_chat: state.is_new_chat,
          composer_present: state.composer_present,
          composer_empty: state.composer_empty,
          content_busy: state.content_busy,
          switch_safe: state.switch_safe,
          activity_project_id: currentExecutionContext?.project_id || null,
          activity_task_id: currentExecutionContext?.task_id || null,
          activity_detection_id: currentExecutionContext?.detection_id || null,
          activity_role: currentExecutionContext?.role || null,
          activity_phase: currentExecutionContext?.phase || (busy ? "busy" : "idle"),
          recovery_action: extra.recovery_action,
          recovery_status: extra.recovery_status,
          recovery_attempt: extra.recovery_attempt,
          recovery_reason: extra.recovery_reason
        })
      });
    } catch (error) {
      void reportExtensionEvent("warning", "ui_heartbeat_failed", { dispatcher_epoch: dispatcherEpoch || null }, error);
    }
  }

  function startUiHeartbeat() {
    if (uiHeartbeatTimer) clearInterval(uiHeartbeatTimer);
    void sendUiHeartbeat();
    uiHeartbeatTimer = setInterval(() => { void sendUiHeartbeat(); }, 15000);
  }

  async function ack(detectionId, ackClientId = clientId, metadata = {}) {
    try {
      await fetch(cfg.baseUrl + "/ack?token=" + encodeURIComponent(cfg.token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          detection_id: detectionId,
          client_id: ackClientId,
          role: metadata.role || null,
          conversation_url: metadata.conversation_url || null,
          request_count: metadata.request_count || null,
          dispatcher_epoch: dispatcherEpoch || null
        })
      });
    } catch (error) {
      void reportExtensionEvent("error", "candidate_ack_failed", { detection_id: detectionId }, error);
    }
  }

  async function waitForComposer(timeoutMs = 12000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const el = composer();
      if (el) return el;
      await new Promise(r => setTimeout(r, 250));
    }
    return null;
  }

  async function waitForConversationUrl(timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (/^\/c\/[A-Za-z0-9-]+/.test(location.pathname)) return location.href;
      await new Promise(r => setTimeout(r, 300));
    }
    return location.href;
  }

  async function waitForExecutionStarted(detectionId, timeoutMs = 10 * 60 * 1000) {
    const started = Date.now();
    while (!contentRetired && Date.now() - started < timeoutMs) {
      let status = null;
      try {
        const response = await fetch(
          cfg.baseUrl +
            "/candidate-status?token=" +
            encodeURIComponent(cfg.token) +
            "&detection_id=" +
            encodeURIComponent(detectionId)
        );
        if (response.ok) status = await response.json();
      } catch (error) {
        void reportExtensionEvent("warning", "candidate_status_poll_failed", { detection_id: detectionId }, error);
      }

      if (status?.consumed && status?.consumed_at && status?.claim_event_id) {
        return { ok: true, status };
      }
      if (status?.stale) {
        return { ok: false, status, reason: status.stale_reason || "stale" };
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    return { ok: false, status: null, reason: contentRetired ? "content_runtime_retired" : "claim_timeout" };
  }

  function normalizedStatusText(el, maxLength = 500) {
    return String(el?.innerText || el?.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function latestAssistantTurn() {
    const messages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const latest = messages.at(-1);
    if (latest) return latest.closest('article,[data-testid^="conversation-turn-"]') || latest;

    const turns = [...document.querySelectorAll('article[data-testid^="conversation-turn-"]')];
    return turns.at(-1) || null;
  }

  function statusVisualHint(el, root) {
    let current = el;
    for (let depth = 0; current && depth < 3; depth += 1) {
      const marker = [
        current.getAttribute?.("role"),
        current.getAttribute?.("data-testid"),
        typeof current.className === "string" ? current.className : current.getAttribute?.("class")
      ].filter(Boolean).join(" ");
      if (/status|alert|processing|secondary|muted/i.test(marker)) return true;
      if (current.querySelector?.(":scope > svg")) return true;
      if (current === root) break;
      current = current.parentElement;
    }
    return false;
  }

  function activeAssistantStatusText(patterns) {
    if (!stopButton()) return "";
    const root = latestAssistantTurn();
    if (!root) return "";

    const candidates = [root, ...root.querySelectorAll("div,span,p")];
    for (const el of candidates) {
      if (el.closest?.("pre,code")) continue;
      const value = normalizedStatusText(el, 240);
      if (!value || value.length > 220 || !patterns.some(pattern => pattern.test(value))) continue;
      if (!statusVisualHint(el, root)) continue;
      return value;
    }
    return "";
  }

  function topLevelSystemErrorText(patterns) {
    const selectors = [
      '[data-sonner-toast]',
      '[data-testid*="toast"]',
      '[data-testid*="notification"]',
      '[data-state="open"]',
      '[role="dialog"]',
      '[class*="toast"]',
      '[class*="Toast"]'
    ];
    const conversationSelector = 'article[data-testid^="conversation-turn-"],[data-message-author-role],#prompt-textarea,[contenteditable="true"],pre,code';
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.closest?.(conversationSelector)) continue;
        const value = normalizedStatusText(el, 320);
        if (!value || value.length > 300) continue;
        if (patterns.some(pattern => pattern.test(value))) return value;
      }
    }
    return "";
  }

  function uiExecutionState() {
    const delayedPatterns = [
      /我们的系统正在进一步处理此请求，处理完毕后将给出回复/,
      /system is still processing/i,
      /taking longer than expected/i
    ];
    const errorPatterns = [
      /请求超时/,
      /操作超时/,
      /生成回复时出错/,
      /网络错误/,
      /发生错误/,
      /chatgpt stream recovery polling timed out/i,
      /stream recovery polling timed out/i,
      /request timed out/i,
      /timed out/i,
      /something went wrong/i,
      /network error/i,
      /error generating/i,
      /failed to generate/i
    ];

    const statusSelectors = [
      '[role="alert"]',
      '[role="status"]',
      '[aria-live="polite"]',
      '[aria-live="assertive"]',
      '[data-testid*="error"]',
      '[data-testid*="status"]',
      '[data-testid*="processing"]'
    ];
    const texts = [];
    for (const selector of statusSelectors) {
      for (const el of document.querySelectorAll(selector)) {
        const value = normalizedStatusText(el);
        if (value) texts.push(value);
      }
    }
    const joined = texts.join("\n");
    const activeStatus = activeAssistantStatusText([...errorPatterns, ...delayedPatterns]);
    const topLevelError = topLevelSystemErrorText(errorPatterns);

    if (topLevelError) {
      return { state: "execution_error", detail: topLevelError };
    }
    if (errorPatterns.some(pattern => pattern.test(joined))) {
      return { state: "execution_error", detail: joined.slice(0, 500) };
    }
    if (activeStatus && errorPatterns.some(pattern => pattern.test(activeStatus))) {
      return { state: "execution_error", detail: activeStatus };
    }
    if (delayedPatterns.some(pattern => pattern.test(joined))) {
      return { state: "processing_delayed", detail: joined.slice(0, 500) };
    }
    if (activeStatus && delayedPatterns.some(pattern => pattern.test(activeStatus))) {
      return { state: "processing_delayed", detail: activeStatus };
    }

    if (stopButton()) return { state: "generating", detail: null };
    return { state: "stable", detail: null };
  }

  function stopButton() {
    return document.querySelector('button[data-testid="stop-button"]') ||
      [...document.querySelectorAll("button")].find(button =>
        /stop generating|停止生成|停止响应|停止/i.test(
          String(button.getAttribute("aria-label") || button.innerText || "")
        )
      ) || null;
  }

  async function recoverDelayedProcessing(attempt) {
    return requestMcpAction("stop_and_continue", {
      conversation_url: conversationUrl() || location.href,
      attempt
    });
  }

  function resetDelayedRecoveryEpisode() {
    if (delayedRecoveryTimer) clearTimeout(delayedRecoveryTimer);
    delayedRecoveryTimer = null;
    delayedRecoveryAttempts = 0;
    delayedRecoveryExhaustedReported = false;
    delayedRecoveryStableSince = null;
    delayedRecoveryConversationKey = null;
  }

  async function reportDelayedRecovery(status, attempt, reason = null) {
    await sendUiHeartbeat({
      recovery_action: "stop_and_continue",
      recovery_status: status,
      recovery_attempt: attempt,
      recovery_reason: reason
    });
  }

  async function runDelayedRecoveryAttempt() {
    if (delayedRecoveryInFlight || delayedRecoveryAttempts >= DELAYED_RECOVERY_MAX_ATTEMPTS) return false;
    delayedRecoveryInFlight = true;
    const attempt = delayedRecoveryAttempts + 1;
    let recovered = false;
    let reason = null;
    try {
      const result = await recoverDelayedProcessing(attempt);
      if (!result?.executed && !result?.attempted) {
        await reportDelayedRecovery("approval_required", delayedRecoveryAttempts, result?.state || result?.reason || "approval_required");
        return false;
      }
      delayedRecoveryAttempts = attempt;
      recovered = Boolean(result?.executed);
      if (!recovered) reason = result?.reason || result?.state || "mcp_recovery_failed";
    } catch (error) {
      delayedRecoveryAttempts = attempt;
      reason = "recovery_exception";
    } finally {
      await reportDelayedRecovery(recovered ? "succeeded" : "failed", attempt, reason);
      delayedRecoveryInFlight = false;
    }
    return recovered;
  }

  function monitorDelayedProcessing() {
    if (!isDispatcher || !dispatcherEpoch) return;
    const state = readChatState();
    const conversationKey = state.conversation_url || state.href || "unknown";

    if (delayedRecoveryInFlight) return;

    if (delayedRecoveryConversationKey && conversationKey !== delayedRecoveryConversationKey) {
      resetDelayedRecoveryEpisode();
    }

    if (state.ui_state === "stable") {
      delayedRecoveryStableSince ||= Date.now();
      if (Date.now() - delayedRecoveryStableSince >= DELAYED_RECOVERY_STABLE_RESET_MS) {
        resetDelayedRecoveryEpisode();
      }
      return;
    }
    delayedRecoveryStableSince = null;

    if (state.ui_state !== "processing_delayed") {
      if (delayedRecoveryTimer) clearTimeout(delayedRecoveryTimer);
      delayedRecoveryTimer = null;
      return;
    }

    delayedRecoveryConversationKey ||= conversationKey;
    if (delayedRecoveryInFlight || delayedRecoveryTimer) return;

    if (delayedRecoveryAttempts >= DELAYED_RECOVERY_MAX_ATTEMPTS) {
      if (!delayedRecoveryExhaustedReported) {
        delayedRecoveryExhaustedReported = true;
        void reportDelayedRecovery("exhausted", delayedRecoveryAttempts, "max_attempts_reached");
      }
      return;
    }

    const expectedConversation = conversationKey;
    delayedRecoveryTimer = setTimeout(() => {
      delayedRecoveryTimer = null;
      if (!isDispatcher || !dispatcherEpoch || delayedRecoveryInFlight) return;
      const confirmed = readChatState();
      const confirmedConversation = confirmed.conversation_url || confirmed.href || "unknown";
      if (
        confirmed.ui_state !== "processing_delayed" ||
        confirmedConversation !== expectedConversation
      ) return;
      void runDelayedRecoveryAttempt();
    }, DELAYED_RECOVERY_CONFIRM_MS);
  }

  function startDelayedRecoveryMonitor() {
    if (delayedRecoveryMonitorTimer) clearInterval(delayedRecoveryMonitorTimer);
    monitorDelayedProcessing();
    monitorExecutionError();
    delayedRecoveryMonitorTimer = setInterval(() => {
      monitorDelayedProcessing();
      monitorExecutionError();
    }, 1000);
  }

  function stopDelayedRecoveryMonitor() {
    if (delayedRecoveryMonitorTimer) clearInterval(delayedRecoveryMonitorTimer);
    delayedRecoveryMonitorTimer = null;
    if (delayedRecoveryTimer) clearTimeout(delayedRecoveryTimer);
    delayedRecoveryTimer = null;
    if (errorRecoveryTimer) clearTimeout(errorRecoveryTimer);
    errorRecoveryTimer = null;
  }

  function resetErrorRecoveryEpisode() {
    if (errorRecoveryTimer) clearTimeout(errorRecoveryTimer);
    errorRecoveryTimer = null;
    errorRecoveryInFlight = false;
    errorRecoveryAttempts = 0;
    errorRecoveryExhaustedReported = false;
    errorRecoveryConversationKey = null;
    errorRecoveryStableSince = null;
    errorRecoveryGateState = null;
    errorRecoveryNextGatePollAt = 0;
  }

  async function reportErrorRecovery(status, attempt, reason = null) {
    await sendUiHeartbeat({
      recovery_action: "retry_or_continue",
      recovery_status: status,
      recovery_attempt: attempt,
      recovery_reason: reason
    });
  }

  async function recoverExecutionError(attempt) {
    return requestMcpAction("retry_or_continue", {
      conversation_url: conversationUrl() || location.href,
      attempt
    });
  }

  async function runErrorRecoveryAttempt() {
    if (errorRecoveryInFlight || errorRecoveryAttempts >= ERROR_RECOVERY_MAX_ATTEMPTS) return false;
    if (Date.now() < errorRecoveryNextGatePollAt) return false;
    errorRecoveryInFlight = true;
    const attempt = errorRecoveryAttempts + 1;
    let recovered = false;
    let actuallyAttempted = false;
    let reason = null;
    try {
      const result = await recoverExecutionError(attempt);
      actuallyAttempted = Boolean(result?.executed || result?.attempted);
      if (!actuallyAttempted) {
        const gateState = result?.state || result?.reason || "approval_required";
        if (gateState !== errorRecoveryGateState) {
          errorRecoveryGateState = gateState;
          await reportErrorRecovery(gateState, errorRecoveryAttempts, gateState);
        }
        errorRecoveryNextGatePollAt = Date.now() + ERROR_RECOVERY_GATE_POLL_MS;
        return false;
      }
      errorRecoveryGateState = null;
      errorRecoveryNextGatePollAt = 0;
      errorRecoveryAttempts = attempt;
      recovered = Boolean(result?.executed);
      if (!recovered) reason = result?.reason || result?.state || "mcp_recovery_failed";
      await reportErrorRecovery(recovered ? "succeeded" : "failed", attempt, reason);
    } catch {
      actuallyAttempted = true;
      errorRecoveryGateState = null;
      errorRecoveryNextGatePollAt = 0;
      errorRecoveryAttempts = attempt;
      reason = "recovery_exception";
      await reportErrorRecovery("failed", attempt, reason);
    } finally {
      errorRecoveryInFlight = false;
    }
    return recovered;
  }

  function monitorExecutionError() {
    if (!isDispatcher || !dispatcherEpoch) return;
    const state = readChatState();
    const conversationKey = state.conversation_url || state.href || "unknown";

    if (errorRecoveryConversationKey && conversationKey !== errorRecoveryConversationKey) {
      resetErrorRecoveryEpisode();
    }

    if (state.ui_state !== "execution_error") {
      if (errorRecoveryTimer) clearTimeout(errorRecoveryTimer);
      errorRecoveryTimer = null;
      if (state.ui_state === "stable") {
        errorRecoveryStableSince ||= Date.now();
        if (Date.now() - errorRecoveryStableSince >= ERROR_RECOVERY_STABLE_RESET_MS) {
          resetErrorRecoveryEpisode();
        }
      } else {
        errorRecoveryStableSince = null;
      }
      return;
    }

    errorRecoveryStableSince = null;
    errorRecoveryConversationKey ||= conversationKey;
    if (errorRecoveryInFlight || errorRecoveryTimer) return;
    if (Date.now() < errorRecoveryNextGatePollAt) return;
    if (errorRecoveryAttempts >= ERROR_RECOVERY_MAX_ATTEMPTS) {
      if (!errorRecoveryExhaustedReported) {
        errorRecoveryExhaustedReported = true;
        void reportErrorRecovery("exhausted", errorRecoveryAttempts, "max_attempts_reached");
        void chrome.runtime.sendMessage({
          type: "WYERP_GLOBAL_EXECUTION_BLOCKED",
          reason: "execution_error_recovery_exhausted",
          conversation_url: state.conversation_url || null
        }).catch(error => {
          void reportExtensionEvent("error", "global_execution_blocked_message_failed", { reason: "execution_error_recovery_exhausted" }, error);
        });
      }
      return;
    }
    const expectedConversation = conversationKey;
    errorRecoveryTimer = setTimeout(() => {
      errorRecoveryTimer = null;
      const confirmed = readChatState();
      const confirmedConversation = confirmed.conversation_url || confirmed.href || "unknown";
      if (confirmed.ui_state !== "execution_error" || confirmedConversation !== expectedConversation) return;
      void runErrorRecoveryAttempt();
    }, ERROR_RECOVERY_CONFIRM_MS);
  }

  async function waitForUiStable(timeoutMs = 10 * 60 * 1000, stableMs = 5000, maxRecoveries = 3) {
    const started = Date.now();
    let stableSince = null;
    let lastState = null;
    let delayedRecoveries = 0;
    let retryRecoveries = 0;

    while (!contentRetired && Date.now() - started < timeoutMs) {
      const current = uiExecutionState();
      lastState = current;

      if (current.state === "processing_delayed") {
        stableSince = null;
        delayedRecoveries = delayedRecoveryAttempts;
        if (
          maxRecoveries <= 0 ||
          (delayedRecoveryAttempts >= Math.min(maxRecoveries, DELAYED_RECOVERY_MAX_ATTEMPTS) &&
            !delayedRecoveryInFlight &&
            !delayedRecoveryTimer)
        ) {
          return { ok: false, reason: "processing_delayed_recovery_exhausted", ui: current };
        }
        monitorDelayedProcessing();
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      if (current.state === "execution_error") {
        stableSince = null;
        retryRecoveries = errorRecoveryAttempts;
        if (
          maxRecoveries <= 0 ||
          (errorRecoveryAttempts >= Math.min(maxRecoveries, ERROR_RECOVERY_MAX_ATTEMPTS) &&
            !errorRecoveryInFlight &&
            !errorRecoveryTimer)
        ) {
          return { ok: false, reason: "retry_recovery_exhausted", ui: current };
        }
        monitorExecutionError();
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      if (current.state === "stable") {
        stableSince ||= Date.now();
        if (Date.now() - stableSince >= stableMs) {
          return {
            ok: true,
            ui: current,
            delayed_recoveries: delayedRecoveries,
            retry_recoveries: retryRecoveries
          };
        }
      } else {
        stableSince = null;
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { ok: false, reason: contentRetired ? "content_runtime_retired" : "ui_stability_timeout", ui: lastState };
  }
  async function routeCandidate(candidate) {
    if (!isDispatcher) return;
    if (!(await verifyBridgeVersion())) return;
    const executionSettings = await loadExecutionSettings();
    if (!executionSettings) return;
    try {
      const routed = await chrome.runtime.sendMessage({
        type: "WYERP_ROUTE_ROLE_CHAT",
        candidate,
        lease_client_id: clientId,
        execution_settings: executionSettings
      });
      if (!routed?.ok) deactivateDispatcher();
    } catch {
      deactivateDispatcher();
    }
  }

  async function sendAssigned(msg) {
    const candidate = msg.candidate;
    if (busy || !validCandidate(candidate)) return;
    busy = true;
    currentExecutionContext = {
      project_id: candidate.project_id,
      task_id: candidate.task_id,
      detection_id: candidate.detection_id,
      role: candidate.eligible_role,
      phase: "preparing"
    };
    void sendUiHeartbeat();

    try {
      await new Promise(r => setTimeout(r, 2000));

      const initialState = readChatState();
      if (!initialState.switch_safe) return;

      const settings = msg.execution_settings || {};
      const maxRequests = Math.max(1, Number(settings.max_requests_per_chat || 20));
      const count = Math.max(1, Math.min(maxRequests, Number(msg.request_count || 1)));
      const role = String(msg.target_role || candidate.eligible_role);
      const result = await requestMcpAction("send_candidate", {
        candidate,
        role,
        request_count: count,
        execution_settings: settings,
        extension_version: extensionVersion,
        extension_latest_version: String(verifiedExtensionLatestVersion || "unknown"),
        taskboard_version: String(verifiedTaskboardVersion || "unknown"),
        recovery_after_timeout: Boolean(msg.recovery_after_timeout),
        conversation_url: conversationUrl() || location.href
      });
      if (!result?.executed) {
        currentExecutionContext.phase = "waiting_approval";
        void sendUiHeartbeat();
        return;
      }
      currentExecutionContext.phase = "prompt_sent";
      void sendUiHeartbeat();
      await chrome.runtime.sendMessage({
        type: "WYERP_ROLE_CANDIDATE_STARTED",
        detection_id: candidate.detection_id
      }).catch(error => {
        void reportExtensionEvent("error", "candidate_started_message_failed", { detection_id: candidate.detection_id }, error);
      });
      await new Promise(r => setTimeout(r, 1500));

      const url = await waitForConversationUrl();
      await ack(candidate.detection_id, msg.lease_client_id || clientId, {
        role,
        conversation_url: url,
        request_count: count
      });
      currentExecutionContext.role = role;
      currentExecutionContext.phase = "waiting_claim";
      void sendUiHeartbeat();

      const execution = await waitForExecutionStarted(candidate.detection_id);

      if (execution.ok) {
        currentExecutionContext.phase = "executing";
        void sendUiHeartbeat();
        const uiStable = await waitForUiStable(10 * 60 * 1000, 5000, Math.max(0, Number(settings.timeout_retry_limit ?? 3)));
        if (uiStable.ok) {
          currentExecutionContext.phase = "completed";
          void sendUiHeartbeat();
          await chrome.runtime.sendMessage({
            type: "WYERP_ROLE_SESSION_BOUND",
            role,
            url,
            count,
            claim_event_id: execution.status.claim_event_id
          }).catch(error => {
            void reportExtensionEvent("error", "role_session_bound_message_failed", { detection_id: candidate.detection_id, role }, error);
          });
        } else {
          currentExecutionContext.phase = "blocked";
          void sendUiHeartbeat();
          await chrome.runtime.sendMessage({
            type: "WYERP_ROLE_EXECUTION_BLOCKED",
            role,
            detection_id: candidate.detection_id,
            reason: uiStable.reason,
            ui_state: uiStable.ui?.state || null
          }).catch(error => {
            void reportExtensionEvent("error", "role_execution_blocked_message_failed", { detection_id: candidate.detection_id, role, reason: uiStable.reason }, error);
          });
        }
      } else {
        currentExecutionContext.phase = "blocked";
        void sendUiHeartbeat();
        await chrome.runtime.sendMessage({
          type: "WYERP_ROLE_EXECUTION_BLOCKED",
          role,
          detection_id: candidate.detection_id,
          reason: execution.reason
        }).catch(error => {
          void reportExtensionEvent("error", "role_execution_start_timeout_message_failed", { detection_id: candidate.detection_id, role, reason: execution.reason }, error);
        });
      }
    } finally {
      busy = false;
      void sendUiHeartbeat();
    }
  }

  async function loadExecutionSettings() {
    try {
      const response = await fetch(cfg.baseUrl + "/settings?token=" + encodeURIComponent(cfg.token));
      const body = await response.json().catch(error => {
        void reportExtensionEvent("warning", "execution_settings_json_invalid", { http_status: response.status }, error);
        return null;
      });
      if (!response.ok) {
        void reportExtensionEvent("warning", "execution_settings_http_failed", { http_status: response.status });
        return null;
      }
      return body?.settings || null;
    } catch (error) {
      void reportExtensionEvent("error", "execution_settings_load_failed", {}, error);
      return null;
    }
  }

  async function reportExtensionOutdated() {
    if (!verifiedExtensionLatestVersion || verifiedExtensionLatestVersion === extensionVersion) return false;
    await chrome.runtime.sendMessage({
      type: "WYERP_EXTENSION_OUTDATED",
      current_version: extensionVersion,
      latest_version: verifiedExtensionLatestVersion,
      page_url: location.href,
      detected_at: Date.now()
    }).catch(error => {
      void reportExtensionEvent("error", "extension_outdated_message_failed", { current_version: extensionVersion, latest_version: verifiedExtensionLatestVersion }, error);
    });
    return true;
  }

  async function verifyBridgeVersion() {
    try {
      const response = await fetch(
        cfg.baseUrl +
          "/version?token=" +
          encodeURIComponent(cfg.token) +
          "&extension_version=" +
          encodeURIComponent(extensionVersion)
      );
      const body = await response.json().catch(error => {
        void reportExtensionEvent("warning", "bridge_version_json_invalid", { http_status: response.status }, error);
        return null;
      });
      const compatible = Boolean(
        response.ok &&
        body?.compatible === true &&
        (body?.taskboard_version || body?.app_version)
      );
      verifiedTaskboardVersion = body?.taskboard_version
        ? String(body.taskboard_version)
        : (body?.app_version ? String(body.app_version) : null);
      verifiedExtensionLatestVersion = body?.extension_latest_version
        ? String(body.extension_latest_version)
        : (body?.expected_extension_version ? String(body.expected_extension_version) : null);
      if (!response.ok) {
        void reportExtensionEvent("warning", "bridge_version_http_failed", {
          http_status: response.status,
          extension_version: extensionVersion,
          expected_extension_version: verifiedExtensionLatestVersion
        });
      }
      if (verifiedExtensionLatestVersion && verifiedExtensionLatestVersion !== extensionVersion) {
        await reportExtensionOutdated();
        return false;
      }
      return compatible;
    } catch (error) {
      void reportExtensionEvent("error", "bridge_version_check_failed", {}, error);
      return false;
    }
  }

  function deactivateDispatcher() {
    isDispatcher = false;
    eventSource?.close();
    eventSource = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (uiHeartbeatTimer) clearInterval(uiHeartbeatTimer);
    uiHeartbeatTimer = null;
    stopDelayedRecoveryMonitor();
  }

  function retireContentRuntime(reason = "retired") {
    if (contentRetired) return;
    contentRetired = true;
    deactivateDispatcher();
    resetDelayedRecoveryEpisode();
    resetErrorRecoveryEpisode();
    globalThis.removeEventListener?.("error", onContentError);
    globalThis.removeEventListener?.("unhandledrejection", onContentUnhandledRejection);
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // LOG-IGNORE: an invalidated extension context cannot remove its listener, but it also
      // cannot receive new extension messages. The new generation is installed independently.
    }
    runtimeInstance.retired = true;
    runtimeInstance.retire_reason = reason;
    if (globalThis.__WYERP_CHAT_WAKE_CONTENT_INSTANCE__ === runtimeInstance) {
      delete globalThis.__WYERP_CHAT_WAKE_CONTENT_INSTANCE__;
    }
    if (globalThis.__WYERP_CHAT_WAKE_CONTENT_ACTIVE__ === extensionVersion) {
      delete globalThis.__WYERP_CHAT_WAKE_CONTENT_ACTIVE__;
    }
  }

  runtimeInstance.retire = retireContentRuntime;

  function connect() {
    if (!isDispatcher || !dispatcherEpoch) return;
    if (eventSource) eventSource.close();

    const url =
      cfg.baseUrl +
      "/stream?token=" +
      encodeURIComponent(cfg.token) +
      "&client_id=" +
      encodeURIComponent(clientId) +
      "&extension_version=" +
      encodeURIComponent(extensionVersion) +
      "&dispatcher_epoch=" +
      encodeURIComponent(dispatcherEpoch);

    eventSource = new EventSource(url);
    startUiHeartbeat();
    startDelayedRecoveryMonitor();
    eventSource.addEventListener("candidate", event => {
      try {
        void routeCandidate(JSON.parse(event.data));
      } catch (error) {
        void reportExtensionEvent("error", "candidate_event_parse_failed", { data_length: String(event?.data || "").length }, error);
      }
    });
    eventSource.addEventListener("superseded", () => {
      deactivateDispatcher();
    });
    eventSource.onerror = () => {
      const now = Date.now();
      if (now - sseErrorReportedAt >= 60_000) {
        sseErrorReportedAt = now;
        void reportExtensionEvent("warning", "sse_connection_error", { dispatcher_epoch: dispatcherEpoch || null, retry_delay_ms: 30000 });
      }
      eventSource?.close();
      eventSource = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 30000);
    };
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (msg?.type === "WYERP_RETIRE_STALE_CONTENT") {
      const expectedVersion = String(msg.expected_extension_version || "");
      if (expectedVersion && expectedVersion !== extensionVersion) {
        sendResponse({ ok: true, retired: true, extension_version: extensionVersion, expected_extension_version: expectedVersion });
        retireContentRuntime("version_mismatch");
      } else {
        sendResponse({ ok: true, retired: false, extension_version: extensionVersion });
      }
      return true;
    }
    if (contentRetired || globalThis.__WYERP_CHAT_WAKE_CONTENT_INSTANCE__ !== runtimeInstance) return;
    if (msg?.type === "WYERP_READ_CHAT_STATE_V2") {
      sendResponse({ ok: true, ...readChatState(), extension_version: extensionVersion });
      return true;
    }
    if (msg?.type === "WYERP_READ_CHAT_STATE") {
      sendResponse(readChatState());
      return true;
    }
    if (msg?.type !== "WYERP_ROLE_CANDIDATE" || !validCandidate(msg.candidate)) return;
    void sendAssigned(msg);
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);

  verifyBridgeVersion()
    .then(compatible => {
      if (!compatible) return;
      return chrome.runtime.sendMessage({ type: "WYERP_REGISTER_DISPATCHER" });
    })
    .then(result => {
      if (!result) return;
      isDispatcher = Boolean(result?.dispatcher);
      dispatcherEpoch = Number(result?.dispatcher_epoch || 0);
      if (isDispatcher && dispatcherEpoch > 0) startUiHeartbeat();
    })
    .catch(error => {
      void reportExtensionEvent("critical", "content_bootstrap_failed", {}, error);
    });
})();
