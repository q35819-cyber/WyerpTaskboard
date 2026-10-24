import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { URL } from "node:url";
import { TaskboardError } from "./core/errors.mjs";
import { TaskStore } from "./task-store.mjs";
import { ErpPassGate } from "./erp-pass-gate.mjs";
import { AuthManager } from "./auth.mjs";
import { RequirementStore } from "./requirement-store.mjs";
import { ScanStore } from "./scan-store.mjs";
import { ChatBrowserWake } from "./chat-browser-wake.mjs";
import { AiExecutionSettingsStore } from "./ai-execution-settings.mjs";
import { ServiceController } from "./service-control.mjs";
import { WindowsMcpClient } from "./windows-mcp-client.mjs";
import { TaskboardRuntimeStatus } from "./runtime-status.mjs";
import { AutomationControlStore } from "./automation-control.mjs";
import { ChatgptMcpExecutor } from "./chatgpt-mcp-executor.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

function safeServiceStatus(state) {
  return {
    state: state?.state || "unknown",
    port: state?.port || state?.instance?.port || 47831,
    pid: state?.instance?.pid || null,
    startedAt: state?.instance?.startedAt || null,
    identityOk: Boolean(state?.identity?.ok),
    listenerPids: Array.isArray(state?.listenerPids) ? state.listenerPids : []
  };
}

function launchDetachedServiceAction(rootDir, action) {
  const cli = path.join(rootDir, "cli", "service.mjs");
  const child = spawn(process.execPath, [cli, action], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WYERP_TASKBOARD_ROOT: rootDir,
      WYERP_SERVICE_ACTION_DELAY_MS: "700"
    }
  });
  child.unref();
  return child.pid;
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? [part, ""] : [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
  }));
}
function isLoopbackAddress(address) {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
}
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new TaskboardError("请求体过大", { code: "BODY_TOO_LARGE", status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new TaskboardError("JSON格式错误", { code: "INVALID_JSON", status: 400 }); }
}
function send(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return false;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  res.end(text);
  return true;
}
async function sendStatic(res, rootDir, pathname) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/plan-index.mjs": ["plan-index.mjs", "text/javascript; charset=utf-8"],
    "/board-state.mjs": ["board-state.mjs", "text/javascript; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"]
  };
  const entry = files[pathname];
  if (!entry) return false;
  let data;
  try { data = await fs.readFile(path.join(rootDir, "web", entry[0])); }
  catch (error) {
    if (error.code === "ENOENT") throw new TaskboardError("Web界面尚未安装完整", { code: "WEB_ASSET_MISSING", status: 503 });
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": entry[1],
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  });
  res.end(data);
  return true;
}
function routeMatch(pathname, pattern) {
  const pp = pathname.split("/").filter(Boolean);
  const pt = pattern.split("/").filter(Boolean);
  if (pp.length !== pt.length) return null;
  const params = {};
  for (let i = 0; i < pt.length; i++) {
    if (pt[i].startsWith(":")) params[pt[i].slice(1)] = decodeURIComponent(pp[i]);
    else if (pt[i] !== pp[i]) return null;
  }
  return params;
}
function actorOptions(identity, body) {
  return {
    actorType: identity.mode === "session" ? "user" : (body.actorType || "system"),
    actorId: body.actorId || identity.actorId,
    sessionWindowName: body.sessionWindowName || "",
    sessionId: body.sessionId || "",
    note: body.note || ""
  };
}
function requireOperation(body) {
  if (!body.operationId) throw new TaskboardError("operationId不能为空", { code: "INVALID_OPERATION_ID", status: 400 });
}
function requireExpectedRevision(body) {
  if (!body.expectedRevision) throw new TaskboardError("expectedRevision不能为空", { code: "EXPECTED_REVISION_REQUIRED", status: 428 });
}
function requireUserSession(identity) {
  if (identity.mode !== "session") {
    throw new TaskboardError("该治理动作必须由用户在浏览器会话中明确执行", {
      code: "USER_SESSION_REQUIRED", status: 403
    });
  }
}
// Cooperative delegation: the AI forwards a CURRENT, explicit user utterance.
// A bearer credential does not cryptographically prove the author of a chat
// message; record its narrow provenance for auditing, never claim signed proof.
function takeoverAuthorizationEvidence(identity, body, params) {
  if (identity.mode === "session") return { authorizationSource: "browser_user_session" };
  const proof = body.chatAuthorization;
  const quote = String(proof?.quote || "").trim();
  const scope = String(proof?.scope || "");
  const actorId = String(body.actorId || "").trim();
  const sessionId = String(body.sessionId || "").trim();
  const approved = /(?:允许|同意|授权|可以|直接|执行|请).{0,30}(?:异常)?接管|(?:异常)?接管.{0,20}(?:允许|同意|授权|可以|执行)|(?:^|[，,。；;\s])(?:有需要|必要时|需要时).{0,20}(?:异常)?接管.{0,20}(?:你自行处理|自行处理|你来处理|你处理)|^异常接管[！!。.]?$/.test(quote);
  const rejected = /不允许|不同意|不授权|不可以|不需要|没必要|没有必要|不必|无需|不用|没有允许|未允许|不接管|不准|不想|请勿|不要|不得|禁止|不能|拒绝|暂不|先不|别接管|取消接管/.test(quote);
  if (identity.mode !== "bearer" || proof?.source !== "direct_user_message" ||
      proof?.projectId !== params.projectId || !["task", "project"].includes(scope) ||
      (scope === "task" && proof?.taskId !== params.taskId) ||
      quote.length < 3 || quote.length > 160 || !approved || rejected ||
      !actorId || !sessionId || !["developer_ai", "test_ai"].includes(body.actorType)) {
    throw new TaskboardError("对话授权必须有当前用户明确原话、对应任务范围和AI会话身份；普通bearer不能直接授权", {
      code: "USER_SESSION_REQUIRED", status: 403
    });
  }
  return {
    authorizationSource: "chat_user_instruction_cooperative",
    authorizationScope: scope,
    authorizationQuote: quote,
    authorizationForwardedBy: actorId,
    authorizationForwardingSessionId: sessionId,
    authorizationMessageRef: String(proof.messageRef || "").slice(0, 120)
  };
}
async function contextAndTask(taskStore, projectId, taskId) {
  const context = await taskStore.projects.context(projectId);
  const pair = await taskStore.getTask(projectId, taskId);
  return { context, ...pair };
}
function claimTarget(workflow, task, requested) {
  if (requested) {
    workflow.assertTransition(task.status, requested);
    return requested;
  }
  const map = {
    "待准备": "开发中",
    "待开发": "开发中",
    "测试失败待修复": "修复中",
    "待独测": "独测中",
    "待复测": "复测中",
    "待交付": "交付中"
  };
  const target = map[task.status];
  if (!target) throw new TaskboardError("当前状态不能直接认领执行", {
    code: "CLAIM_NOT_ALLOWED", status: 409, details: { status: task.status }
  });
  workflow.assertTransition(task.status, target);
  return target;
}
function requireCurrentExecutionSession(task, body, { actorType, allowedStatuses }) {
  if (!allowedStatuses.includes(task.status)) {
    throw new TaskboardError("当前阶段不能执行该原子交接动作", {
      code: "EXECUTION_COMPLETION_STAGE_INVALID",
      status: 409,
      details: { status: task.status, allowedStatuses }
    });
  }
  if (!body.sessionId || !task.sessionId || body.sessionId !== task.sessionId) {
    throw new TaskboardError("原子交接必须由当前执行Session完成", {
      code: "EXECUTION_COMPLETION_IDENTITY_MISMATCH",
      status: 409,
      details: { currentSessionId: task.sessionId || null, suppliedSessionId: body.sessionId || null, actorType }
    });
  }
}
function developerCompletionTarget(status) {
  return ({
    "开发中": { status: "待独测", plannedRole: "独立测试AI" },
    "修复中": { status: "待复测", plannedRole: "独立测试AI" }
  })[status] || null;
}
function lastResumeTarget(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const target = events[i]?.metadata?.resumeTarget;
    if (target) return target;
  }
  return null;
}

export async function createTaskboardServer({ rootDir, host = "127.0.0.1", port = 47831, chatgptMcpExecutorFactory = null, erpPassGateOptions = {} } = {}) {
  const appPackage = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const appVersion = String(appPackage.version || "").trim();
  if (!appVersion) throw new Error("taskboard package version missing");
  const systemEventLog = await new SystemEventLog(rootDir).init();
  const taskStore = await new TaskStore(rootDir).init();
  const erpPassGate = await new ErpPassGate({ rootDir, taskStore, systemEventLog, ...erpPassGateOptions }).init();
  const requirementStore = await new RequirementStore(rootDir, { taskStore }).init();
  const scanStore = await new ScanStore(rootDir, { systemEventLog }).init();
  const chatBrowserWake = await new ChatBrowserWake(rootDir, { systemEventLog }).init();
  const aiExecutionSettings = await new AiExecutionSettingsStore(rootDir, { systemEventLog }).init();
  const automationControl = await new AutomationControlStore(rootDir, { systemEventLog }).init();
  const auth = await new AuthManager(rootDir).init();
  let server;
  const serviceControllerForRequest = () => new ServiceController(rootDir, { host, port: server?.address()?.port || port });
  const windowsMcpForRequest = async () => new WindowsMcpClient(rootDir, { automationControl, systemEventLog }).init();
  const chatgptMcpExecutorForRequest = async () => chatgptMcpExecutorFactory
    ? chatgptMcpExecutorFactory({ rootDir, automationControl })
    : new ChatgptMcpExecutor(rootDir, { automationControl, systemEventLog }).init();
  const runtimeStatusForRequest = () => new TaskboardRuntimeStatus(rootDir, { taskStore });
  await taskStore.recoverPendingTransactions();

  server = http.createServer(async (req, res) => {
    const requestPath = String(req.url || "").split("?")[0].slice(0, 500);
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) throw new TaskboardError("仅允许本机loopback访问", { code: "LOOPBACK_ONLY", status: 403 });
      const actualPort = server.address()?.port || port;
      const allowedHosts = new Set(["127.0.0.1:" + actualPort, "localhost:" + actualPort]);
      const hostHeader = String(req.headers.host || "").toLowerCase();
      if (!allowedHosts.has(hostHeader)) throw new TaskboardError("Host不允许", { code: "HOST_REJECTED", status: 403 });
      const url = new URL(req.url, "http://" + hostHeader);
      const origin = req.headers.origin;
      const isAutomationControlRoute = url.pathname.startsWith("/api/automation-control/");
      if (isAutomationControlRoute) {
        const token = url.searchParams.get("token") || "";
        const controlTokenOk = automationControl.verifyToken(token);
        const wakeTokenOk = chatBrowserWake.verifyConfiguredToken(token);
        const controlOriginAllowed = !origin || origin === "https://chatgpt.com" || /^chrome-extension:\/\/[a-p]{32}$/i.test(origin);
        if (!controlOriginAllowed) throw new TaskboardError("自动化总控Origin不允许", { code: "AUTOMATION_CONTROL_ORIGIN_REJECTED", status: 403 });
        const controlHeaders = origin ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        } : {};
        if (req.method === "OPTIONS") { res.writeHead(204, controlHeaders); return res.end(); }

        if (url.pathname === "/api/automation-control/request") {
          if (!controlTokenOk && !wakeTokenOk) throw new TaskboardError("自动化动作请求token无效", { code: "AUTOMATION_CONTROL_UNAUTHORIZED", status: 401 });
          if (req.method !== "POST") throw new TaskboardError("自动化动作请求只允许POST", { code: "METHOD_NOT_ALLOWED", status: 405 });
          const body = await readJson(req);
          return send(res, 200, await automationControl.requestAction(body), controlHeaders);
        }

        if (!controlTokenOk) throw new TaskboardError("自动化总控token无效", { code: "AUTOMATION_CONTROL_UNAUTHORIZED", status: 401 });
        if (req.method === "GET" && url.pathname === "/api/automation-control/state") {
          return send(res, 200, await automationControl.publicState(), controlHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/automation-control/summary") {
          return send(res, 200, {
            control: await automationControl.publicState(),
            runtime: await runtimeStatusForRequest().snapshot({ liveProbes: false })
          }, controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/log-event") {
          const body = await readJson(req, 32 * 1024);
          const level = ["info", "warning", "error", "critical"].includes(String(body.level || "")) ? String(body.level) : "info";
          const eventName = /^[A-Za-z0-9._:-]{1,160}$/.test(String(body.event || "")) ? String(body.event) : "overlay_event";
          await systemEventLog.append({
            level,
            component: "global-overlay",
            event: eventName,
            operation: body.operation || null,
            stage: body.stage || null,
            result: body.result || null,
            error_source: body.error_source || null,
            error_code: body.error_code || null,
            error_message: body.error_message || null,
            details: body.details || null
          });
          return send(res, 202, { ok: true }, controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/manual-start-proof") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.issueManualStartProof({ injected: body.injected !== false, input_type: body.input_type }), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/start") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.start({ proof_id: body.proof_id, require_manual_proof: true }), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/pause") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.pause(body.reason || "user_pause"), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/unattended") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.setUnattended(body.enabled === true), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/decision") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.decide(String(body.approval_id || ""), body.decision), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/input-event") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.observeInput({ injected: body.injected === true, input_type: body.input_type }), controlHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/automation-control/user-takeover") {
          const body = await readJson(req);
          return send(res, 200, await automationControl.userTakeover(body.reason || "human_input"), controlHeaders);
        }
        throw new TaskboardError("自动化总控路由不存在", { code: "AUTOMATION_CONTROL_NOT_FOUND", status: 404 });
      }
      const isChatWakeRoute = url.pathname.startsWith("/api/chat-wake/");
      if (isChatWakeRoute) {
        const wakeOrigin = origin && /^chrome-extension:\/\/[a-p]{32}$/i.test(origin)
          ? origin
          : "https://chatgpt.com";
        const wakeHeaders = {
          "Access-Control-Allow-Origin": wakeOrigin,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Vary": "Origin"
        };
        if (origin && origin !== "https://chatgpt.com" && !/^chrome-extension:\/\/[a-p]{32}$/i.test(origin)) {
          throw new TaskboardError("Chat Wake Origin不允许", { code: "CHAT_WAKE_ORIGIN_REJECTED", status: 403 });
        }
        // CORS preflight carries no useful application authorization semantics.
        // Answer it before token/enabled checks so extension diagnostics do not
        // generate a self-amplifying stream of 401/CORS errors.
        if (req.method === "OPTIONS") { res.writeHead(204, wakeHeaders); return res.end(); }

        const token = url.searchParams.get("token") || "";
        const configuredTokenOk = chatBrowserWake.verifyConfiguredToken(token);
        const wakeEnabledTokenOk = chatBrowserWake.verifyToken(token);
        if (
          !wakeEnabledTokenOk &&
          configuredTokenOk &&
          req.method === "GET" &&
          url.pathname === "/api/chat-wake/version"
        ) {
          const extensionVersion = url.searchParams.get("extension_version") || "";
          const expectedVersion = String(chatBrowserWake.config?.expected_extension_version || "");
          const extensionCurrent = chatBrowserWake.verifyExtensionVersion(extensionVersion);
          return send(res, 200, {
            compatible: false,
            state: "chat_wake_disabled",
            wake_enabled: false,
            version_policy: "independent",
            extension_version: extensionVersion || null,
            extension_current: extensionCurrent,
            extension_latest_version: expectedVersion || null,
            expected_extension_version: expectedVersion || null,
            taskboard_version: appVersion,
            app_version: appVersion
          }, wakeHeaders);
        }
        const configuredLoggingRoute =
          req.method === "POST" &&
          url.pathname === "/api/chat-wake/log-event" &&
          configuredTokenOk;
        if (!wakeEnabledTokenOk && !configuredLoggingRoute) {
          if (req.method === "GET" && url.pathname === "/api/chat-wake/stream" && configuredTokenOk) {
            res.writeHead(200, {
              ...wakeHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "Connection": "close",
              "X-Accel-Buffering": "no"
            });
            res.write("event: superseded\n");
            res.write("data: " + JSON.stringify({ state: "chat_wake_disabled" }) + "\n\n");
            res.end();
            await systemEventLog.append({
              level: "info",
              component: "chat-wake-server",
              event: "disabled_stream_retired",
              result: "closed",
              details: {
                client_id: url.searchParams.get("client_id") || null,
                extension_version: url.searchParams.get("extension_version") || null
              }
            });
            return;
          }
          throw new TaskboardError("Chat Wake token无效", { code: "CHAT_WAKE_UNAUTHORIZED", status: 401 });
        }
        if (req.method === "POST" && url.pathname === "/api/chat-wake/log-event") {
          const body = await readJson(req, 32 * 1024);
          const level = ["info", "warning", "error", "critical"].includes(String(body.level || "")) ? String(body.level) : "info";
          const source = ["background", "content", "overlay"].includes(String(body.source || "")) ? String(body.source) : "unknown";
          const eventName = /^[A-Za-z0-9._:-]{1,160}$/.test(String(body.event || "")) ? String(body.event) : "extension_event";
          await systemEventLog.append({
            level,
            component: "chat-wake-" + source,
            event: eventName,
            trace_id: body.trace_id || null,
            project_id: body.project_id || null,
            task_id: body.task_id || null,
            detection_id: body.detection_id || null,
            operation: body.operation || null,
            stage: body.stage || null,
            result: body.result || null,
            error_source: body.error_source || null,
            error_code: body.error_code || null,
            error_message: body.error_message || null,
            extension_version: body.extension_version || null,
            details: body.details || null
          });
          return send(res, 202, { ok: true }, wakeHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/chat-wake/version") {
          const extensionVersion = url.searchParams.get("extension_version") || "";
          const expectedVersion = String(chatBrowserWake.config?.expected_extension_version || "");
          const extensionCurrent = chatBrowserWake.verifyExtensionVersion(extensionVersion);
          return send(res, extensionCurrent ? 200 : 409, {
            compatible: extensionCurrent,
            version_policy: "independent",
            extension_version: extensionVersion || null,
            extension_latest_version: expectedVersion || null,
            taskboard_version: appVersion,
            app_version: extensionVersion || appVersion,
            app_version_legacy_alias: true,
            expected_extension_version: expectedVersion || null,
            extension_current: extensionCurrent
          }, wakeHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/chat-wake/settings") {
          const settings = await aiExecutionSettings.get();
          return send(res, 200, { settings: aiExecutionSettings.forChatWake(settings) }, wakeHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/chat-wake/global-status") {
          return send(res, 200, await runtimeStatusForRequest().snapshot({ liveProbes: false }), wakeHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/chat-wake/ack") {
          const body = await readJson(req);
          const result = await chatBrowserWake.ack(body.detection_id, body.client_id, { role: body.role, conversation_url: body.conversation_url, request_count: body.request_count, dispatcher_epoch: body.dispatcher_epoch });
          return send(res, result.state === "acked" ? 200 : 409, result, wakeHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/chat-wake/ui-heartbeat") {
          const body = await readJson(req);
          const result = await chatBrowserWake.uiHeartbeat(body.client_id, {
            dispatcher_epoch: body.dispatcher_epoch,
            extension_version: body.extension_version,
            ui_state: body.ui_state,
            conversation_url: body.conversation_url,
            is_new_chat: body.is_new_chat,
            composer_present: body.composer_present,
            composer_empty: body.composer_empty,
            content_busy: body.content_busy,
            switch_safe: body.switch_safe,
            activity_project_id: body.activity_project_id,
            activity_task_id: body.activity_task_id,
            activity_detection_id: body.activity_detection_id,
            activity_role: body.activity_role,
            activity_phase: body.activity_phase,
            recovery_action: body.recovery_action,
            recovery_status: body.recovery_status,
            recovery_attempt: body.recovery_attempt,
            recovery_reason: body.recovery_reason
          });
          return send(res, result.state === "heartbeat" ? 200 : 409, result, wakeHeaders);
        }
        if (req.method === "POST" && url.pathname === "/api/chat-wake/mcp-action") {
          const body = await readJson(req);
          const executor = await chatgptMcpExecutorForRequest();
          return send(res, 200, await executor.execute(body), wakeHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/chat-wake/candidate-status") {
          const detectionId = url.searchParams.get("detection_id") || "";
          if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(detectionId)) {
            throw new TaskboardError("detection_id无效", { code: "CHAT_WAKE_INVALID_DETECTION", status: 400 });
          }
          const state = await scanStore.readState();
          const item = state.candidates?.[detectionId] || null;
          return send(res, 200, {
            found: Boolean(item),
            detection_id: detectionId,
            consumed: Boolean(item?.consumed_at),
            consumed_at: item?.consumed_at || null,
            claim_event_id: item?.claim_event_id || null,
            stale: Boolean(item?.stale_at),
            stale_reason: item?.stale_reason || null
          }, wakeHeaders);
        }
        if (req.method === "GET" && url.pathname === "/api/chat-wake/stream") {
          const clientId = url.searchParams.get("client_id") || "";
          const extensionVersion = url.searchParams.get("extension_version") || "";
          const dispatcherEpoch = url.searchParams.get("dispatcher_epoch") || "";
          if (!chatBrowserWake.verifyExtensionVersion(extensionVersion)) {
            res.writeHead(200, {
              ...wakeHeaders,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-store",
              "Connection": "close",
              "X-Accel-Buffering": "no"
            });
            const latest = String(chatBrowserWake.config?.expected_extension_version || "") || null;
            res.write("event: superseded\n");
            res.write("data: " + JSON.stringify({ state: "extension_outdated", actual: extensionVersion || null, latest }) + "\n\n");
            res.end();
            await systemEventLog.append({
              level: "warning",
              component: "chat-wake-server",
              event: "outdated_stream_retired",
              result: "closed",
              extension_version: extensionVersion || null,
              details: { client_id: clientId || null, actual: extensionVersion || null, latest }
            });
            return;
          }
          res.writeHead(200, { ...wakeHeaders, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
          let closed = false;
          let lastDetectionId = null;
          const push = async () => {
            if (closed) return;
            const candidates = await scanStore.list();
            const preferredRole = url.searchParams.get("role") || null;
            const result = await chatBrowserWake.claim(candidates, clientId, preferredRole, dispatcherEpoch);
            if (result.state === "superseded" || result.state === "invalid_dispatcher") {
              closed = true;
              res.write("event: superseded\n");
              res.write("data: " + JSON.stringify({ state: result.state }) + "\n\n");
              res.end();
              return;
            }
            if (result.state === "candidate" && result.candidate?.detection_id !== lastDetectionId) {
              lastDetectionId = result.candidate.detection_id;
              res.write("event: candidate\n");
              res.write("data: " + JSON.stringify(result.candidate) + "\n\n");
            } else res.write(": heartbeat\n\n");
          };
          await push();
          if (closed) return;
          const timer = setInterval(() => {
            push().catch(error => {
              void systemEventLog.error("chat-wake-sse", "push_failed", error, { client_id: clientId, dispatcher_epoch: dispatcherEpoch });
              closed = true;
              clearInterval(timer);
              if (!res.writableEnded) res.end();
            });
          }, 2000);
          req.on("close", () => { closed = true; clearInterval(timer); });
          return;
        }
        throw new TaskboardError("Chat Wake路由不存在", { code: "CHAT_WAKE_NOT_FOUND", status: 404 });
      }
      const allowedOrigins = new Set(["http://127.0.0.1:" + actualPort, "http://localhost:" + actualPort]);
      if (origin && !allowedOrigins.has(origin)) throw new TaskboardError("Origin不允许", { code: "ORIGIN_REJECTED", status: 403 });
      if (req.method === "GET" && await sendStatic(res, rootDir, url.pathname)) return;
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204, { "Cache-Control": "no-store" });
        return res.end();
      }
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(res, 200, { ok: true, service: "WyerpTaskboard", version: appVersion });
      }
      if (req.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(req);
        if (!auth.verifyAdminSecret(body.secret || "")) throw new TaskboardError("管理员密钥错误", { code: "UNAUTHORIZED", status: 401 });
        const session = auth.createSession();
        return send(res, 200, { ok: true, csrfToken: session.csrf }, {
          "Set-Cookie": "wyerp_taskboard_session=" + encodeURIComponent(session.id) + "; HttpOnly; SameSite=Strict; Path=/"
        });
      }

      if (req.method === "POST" && url.pathname === "/api/erp-release/pass/verify") {
        if (!erpPassGate.verifyEnabled) throw new TaskboardError("ERP可信PASS验证服务尚未配置", { code: "ERP_PASS_GATE_DISABLED", status: 503 });
        const header = String(req.headers.authorization || "");
        if (!header.startsWith("Bearer ") || !erpPassGate.authorized(header.slice(7))) throw new TaskboardError("ERP可信PASS验证身份未授权", { code: "ERP_PASS_VERIFY_UNAUTHORIZED", status: 401 });
        const body = await readJson(req, 4096);
        try { return send(res, 200, await erpPassGate.verify(body)); }
        catch (error) {
          if (error.code) throw new TaskboardError("ERP独测PASS验证未通过", { code: error.code, status: error.status || 409 });
          throw error;
        }
      }
      const cookies = parseCookies(req.headers.cookie);
      const bearerHeader = String(req.headers.authorization || "");
      const bearer = bearerHeader.startsWith("Bearer ") ? bearerHeader.slice(7) : null;
      const identity = auth.authenticate({ sessionId: cookies.wyerp_taskboard_session, bearer });
      const isWrite = !["GET", "HEAD", "OPTIONS"].includes(req.method);
      if (isWrite && identity.mode === "session") {
        if (!origin) throw new TaskboardError("浏览器写请求必须携带Origin", { code: "ORIGIN_REQUIRED", status: 403 });
        if (req.headers["x-csrf-token"] !== identity.csrf) throw new TaskboardError("CSRF校验失败", { code: "CSRF_REJECTED", status: 403 });
      }

      if (req.method === "POST" && url.pathname === "/api/erp-release/pass/retry") {
        requireUserSession(identity);
        const body = await readJson(req, 2048);
        if (typeof body.evidence_id !== "string" || !/^evt_[a-f0-9]{24}$/.test(body.evidence_id)) throw new TaskboardError("证据编号无效", { code: "INVALID_EVIDENCE_ID", status: 400 });
        const accepted = await erpPassGate.retryBlocked(body.evidence_id);
        if (!accepted) throw new TaskboardError("该记录不是允许人工重试的发送前阻断状态", { code: "DISPATCH_RETRY_FORBIDDEN", status: 409 });
        return send(res, 200, { accepted: true, state: erpPassGate.ledger.entries[body.evidence_id]?.state });
      }
      if (req.method === "GET" && url.pathname === "/api/auth/session") {
        return send(res, 200, { ok: true, actorId: identity.actorId, csrfToken: identity.csrf || null, mode: identity.mode });
      }      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        if (identity.session) auth.deleteSession(identity.session.id);
        return send(res, 200, { ok: true }, {
          "Set-Cookie": "wyerp_taskboard_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/"
        });
      }

      if (req.method === "GET" && url.pathname === "/api/ai-execution/settings") {
        return send(res, 200, { settings: await aiExecutionSettings.get() });
      }
      if (req.method === "PUT" && url.pathname === "/api/ai-execution/settings") {
        requireUserSession(identity);
        const body = await readJson(req);
        const result = await aiExecutionSettings.save(body.settings || body);
        scanStore.schedulerProbeCache = null;
        return send(res, 200, result);
      }

      if (req.method === "GET" && url.pathname === "/api/runtime/status") {
        return send(res, 200, await runtimeStatusForRequest().snapshot());
      }
      if (req.method === "GET" && url.pathname === "/api/runtime/events") {
        const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") || 200)));
        const component = url.searchParams.get("component") || null;
        const level = url.searchParams.get("level") || null;
        return send(res, 200, { items: await systemEventLog.recent({ limit, component, level }) });
      }

      if (req.method === "GET" && url.pathname === "/api/windows-mcp/status") {
        try {
          const client = await windowsMcpForRequest();
          return send(res, 200, { supported: true, state: "ready", ...(await client.status()) });
        } catch (error) {
          return send(res, 200, {
            supported: true,
            state: "unavailable",
            enabled: false,
            error: { code: error.code || "WINDOWS_MCP_UNAVAILABLE", message: error.message }
          });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/windows-mcp/tools") {
        const client = await windowsMcpForRequest();
        const result = await client.listTools();
        return send(res, 200, {
          supported: true,
          protocolVersion: result.protocolVersion,
          server: result.server,
          tools: result.tools
        });
      }
      if (req.method === "POST" && url.pathname === "/api/windows-mcp/smoke") {
        requireUserSession(identity);
        const client = await windowsMcpForRequest();
        return send(res, 200, await client.smokeCursorControl());
      }

      const projectServiceStatus = routeMatch(url.pathname, "/api/projects/:projectId/service/status");
      if (req.method === "GET" && projectServiceStatus) {
        if (projectServiceStatus.projectId !== "wyerp-taskboard") {
          return send(res, 200, { supported: false, projectId: projectServiceStatus.projectId, state: "unsupported" });
        }
        try {
          const status = await serviceControllerForRequest().status();
          return send(res, 200, { supported: true, projectId: projectServiceStatus.projectId, ...safeServiceStatus(status) });
        } catch {
          return send(res, 200, {
            supported: true,
            projectId: projectServiceStatus.projectId,
            state: "identity_unknown",
            port: server.address()?.port || port,
            pid: null,
            startedAt: null,
            identityOk: false,
            listenerPids: []
          });
        }
      }

      const projectServiceRestart = routeMatch(url.pathname, "/api/projects/:projectId/service/start-or-restart");
      if (req.method === "POST" && projectServiceRestart) {
        requireUserSession(identity);
        if (projectServiceRestart.projectId !== "wyerp-taskboard") {
          throw new TaskboardError("该项目尚未配置服务控制", { code: "PROJECT_SERVICE_UNSUPPORTED", status: 409 });
        }
        const before = await serviceControllerForRequest().status();
        if (["port_conflict", "identity_mismatch", "identity_unknown"].includes(before.state)) {
          throw new TaskboardError("项目服务身份不明确，拒绝启动/重启", {
            code: "PROJECT_SERVICE_IDENTITY_CONFLICT", status: 409, details: safeServiceStatus(before)
          });
        }
        launchDetachedServiceAction(rootDir, "start-or-restart");
        return send(res, 202, {
          accepted: true,
          projectId: projectServiceRestart.projectId,
          action: before.state === "running" ? "restart" : "start",
          previousState: before.state
        });
      }

      const projectServiceStop = routeMatch(url.pathname, "/api/projects/:projectId/service/stop");
      if (req.method === "POST" && projectServiceStop) {
        requireUserSession(identity);
        if (projectServiceStop.projectId !== "wyerp-taskboard") {
          throw new TaskboardError("该项目尚未配置服务控制", { code: "PROJECT_SERVICE_UNSUPPORTED", status: 409 });
        }
        const before = await serviceControllerForRequest().status();
        if (["port_conflict", "identity_mismatch", "identity_unknown"].includes(before.state)) {
          throw new TaskboardError("项目服务身份不明确，拒绝关闭", {
            code: "PROJECT_SERVICE_IDENTITY_CONFLICT", status: 409, details: safeServiceStatus(before)
          });
        }
        launchDetachedServiceAction(rootDir, "stop");
        return send(res, 202, {
          accepted: true,
          projectId: projectServiceStop.projectId,
          action: "stop",
          previousState: before.state
        });
      }

      if (req.method === "GET" && url.pathname === "/api/task-scan/status") {
        const candidates = await scanStore.list();
        const eligible = candidates.filter((item) => item.eligible);
        const developerCandidates = candidates.filter((item) => item.planned_role === "开发AI" && ["待开发", "测试失败待修复", "待准备", "待交付"].includes(item.status));
        const highest = candidates[0] || null;
        const scheduler = await scanStore.schedulerStatus();
        const scan = await scanStore.status();
        const executionSettings = await aiExecutionSettings.get();
        const recentScanEvents = await scanStore.recentEvents(100);
        const lastConsumption = [...recentScanEvents].reverse().find((item) => item.type === "candidate_consumed") || null;
        const configuredIntervalMinutes = Number(executionSettings.scan_interval_minutes || 10);
        const schedulerIntervalMinutes = Number(scheduler.interval_minutes || configuredIntervalMinutes);
        const intervalMs = configuredIntervalMinutes * 60 * 1000;
        const scanIntervalMinutes = Number(scan.scan_interval_minutes || 0);
        const scanDeadlineMatchesCurrentSettings = Boolean(
          scan.next_due_at &&
          scanIntervalMinutes > 0 &&
          scanIntervalMinutes === configuredIntervalMinutes
        );
        const nextExpectedAt = scan.scheduler_mode === "idle_suspended"
          ? null
          : (scanDeadlineMatchesCurrentSettings
            ? scan.next_due_at
            : (scan.last_scan_at
              ? new Date(Date.parse(scan.last_scan_at) + intervalMs).toISOString()
              : scheduler.next_run_at || null));
        return send(res, 200, {
          scheduler,
          scan,
          executionSettings,
          schedulerSync: {
            in_sync: !scheduler.installed || schedulerIntervalMinutes === configuredIntervalMinutes,
            configured_interval_minutes: configuredIntervalMinutes,
            scheduler_interval_minutes: schedulerIntervalMinutes
          },
          nextExpectedAt,
          lastConsumption,
          candidateCount: candidates.length,
          eligibleCount: eligible.length,
          developerCandidates: developerCandidates.map((item) => ({
            detectionId: item.detection_id,
            projectId: item.project_id,
            taskId: item.task_id,
            priority: item.priority,
            status: item.status,
            eligible: item.eligible,
            reason: item.reason,
            blockers: item.blockers || [],
            readDependencies: item.read_dependencies || [],
            writeTargets: item.write_targets || []
          })),
          highestCandidate: highest ? {
            detectionId: highest.detection_id,
            projectId: highest.project_id,
            taskId: highest.task_id,
            status: highest.status,
            eligible: highest.eligible,
            eligibleRole: highest.eligible_role,
            reason: highest.reason
          } : null
        });
      }
      if (req.method === "GET" && url.pathname === "/api/projects") {
        const projects = [];
        for (const project of taskStore.projects.list()) {
          projects.push({
            id: project.id, name: project.name, root: project.root,
            taskRegistry: project.taskRegistry, adapter: project.adapter,
            workflowProfile: project.workflowProfile,
            registryFormatVersion: project.registryFormatVersion,
            onboardingStatus: project.onboardingStatus || null,
            adaptationError: project.adaptationError || null,
            health: await taskStore.projects.health(project.id)
          });
        }
        return send(res, 200, { projects });
      }
      if (req.method === "POST" && url.pathname === "/api/projects") {
        if (identity.mode !== "session") throw new TaskboardError("添加项目只能由已登录的本机管理员页面执行", {
          code: "BROWSER_ADMIN_REQUIRED", status: 403
        });
        const body = await readJson(req);
        const result = await taskStore.projects.addProject({
          root: body.root,
          id: body.id,
          name: body.name,
          taskRegistry: body.taskRegistry
        });
        return send(res, 201, result);
      }

      const removeProjectParams = routeMatch(url.pathname, "/api/projects/:projectId");
      if (req.method === "DELETE" && removeProjectParams) {
        if (identity.mode !== "session") throw new TaskboardError("移除项目只能由已登录的本机管理员页面执行", {
          code: "BROWSER_ADMIN_REQUIRED", status: 403
        });
        const body = await readJson(req);
        requireOperation(body);
        const projectId = removeProjectParams.projectId;
        const snapshot = await taskStore.snapshot(projectId);
        const workflow = taskStore.projects.workflow(projectId);
        const activeTaskIds = snapshot.tasks
          .filter((task) => workflow.isExecutionStatus(task.status))
          .map((task) => task.id);
        const activeResourceIds = [];
        for (const task of snapshot.tasks) {
          const resourceState = await taskStore.testResourceState(projectId, task.id);
          for (const resource of resourceState.active) {
            activeResourceIds.push(`${task.id}:${resource.resourceId}`);
          }
        }
        if (activeTaskIds.length || activeResourceIds.length) {
          throw new TaskboardError("项目仍有执行中任务或未清理测试资源，不能移除", {
            code: "PROJECT_REMOVE_BLOCKED",
            status: 409,
            details: { projectId, activeTaskIds, activeResourceIds }
          });
        }
        const result = await taskStore.projects.removeProject(projectId);
        await systemEventLog.append({
          component: "project-registry",
          event: "project_removed",
          operation: body.operationId,
          result: "removed",
          details: { project_id: projectId, project_name: result.removedProject.name }
        });
        return send(res, 200, { ...result, operationId: body.operationId });
      }

      let adaptationParams = routeMatch(url.pathname, "/api/projects/:projectId/adapt");
      if (req.method === "POST" && adaptationParams) {
        requireUserSession(identity);
        const body = await readJson(req);
        requireOperation(body);
        const result = await taskStore.projects.adaptProject(adaptationParams.projectId);
        return send(res, 200, { ...result, operationId: body.operationId });
      }

      let requirementParams = routeMatch(url.pathname, "/api/projects/:projectId/requirements");
      if (req.method === "GET" && requirementParams) {
        taskStore.projects.get(requirementParams.projectId);
        const pendingOnly = url.searchParams.get("pending") === "1";
        return send(res, 200, pendingOnly
          ? await requirementStore.pending(requirementParams.projectId)
          : { items: await requirementStore.list(requirementParams.projectId) });
      }
      if (req.method === "POST" && requirementParams) {
        requireUserSession(identity);
        taskStore.projects.get(requirementParams.projectId);
        const body = await readJson(req);
        requireOperation(body);
        const result = await requirementStore.create(requirementParams.projectId, {
          operationId: body.operationId,
          text: body.text,
          actorId: identity.actorId
        });
        return send(res, 201, result);
      }

      requirementParams = routeMatch(url.pathname, "/api/projects/:projectId/requirements/:requirementId/reply");
      if (req.method === "POST" && requirementParams) {
        taskStore.projects.get(requirementParams.projectId);
        const body = await readJson(req);
        requireOperation(body);
        const actorType = identity.mode === "session" ? "user" : (body.actorType || "developer_ai");
        const result = await requirementStore.reply(requirementParams.projectId, requirementParams.requirementId, {
          operationId: body.operationId,
          actorType,
          actorId: identity.actorId || body.actorId || "taskctl",
          note: body.note,
          replyToMessageId: body.replyToMessageId || null,
          sessionId: body.sessionId || "",
          sessionWindowName: body.sessionWindowName || ""
        });
        return send(res, 200, result);
      }

      requirementParams = routeMatch(url.pathname, "/api/projects/:projectId/requirements/:requirementId/status");
      if (req.method === "POST" && requirementParams) {
        taskStore.projects.get(requirementParams.projectId);
        const body = await readJson(req);
        requireOperation(body);
        if (identity.mode === "session" && body.status !== "已取消") {
          throw new TaskboardError("用户浏览器只能取消需求；拆解状态由AI回写", {
            code: "REQUIREMENT_STATUS_ACTOR_INVALID", status: 403
          });
        }
        const result = await requirementStore.setStatus(requirementParams.projectId, requirementParams.requirementId, {
          operationId: body.operationId,
          status: body.status,
          actorType: identity.mode === "session" ? "user" : (body.actorType || "developer_ai"),
          actorId: identity.actorId || body.actorId || "taskctl",
          note: body.note || "",
          planPaths: body.planPaths || [],
          taskIds: body.taskIds || [],
          keyFiles: body.keyFiles || [],
          sessionId: body.sessionId || "",
          sessionWindowName: body.sessionWindowName || ""
        });
        return send(res, 200, result);
      }

      let workflowParams = routeMatch(url.pathname, "/api/projects/:projectId/workflow");
      if (req.method === "GET" && workflowParams) {
        const workflow = taskStore.projects.workflow(workflowParams.projectId);
        return send(res, 200, {
          id: workflow.id,
          priorities: workflow.priorities,
          tracks: workflow.tracks,
          statuses: workflow.statuses,
          roles: workflow.roles,
          boardColumns: workflow.boardColumns
        });
      }
      let params = routeMatch(url.pathname, "/api/projects/:projectId/tasks");
      if (req.method === "GET" && params) return send(res, 200, await taskStore.snapshot(params.projectId));
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        requireExpectedRevision(body);
        if (!body.task || typeof body.task !== "object") throw new TaskboardError("task不能为空", { code: "INVALID_TASK", status: 400 });
        const result = await taskStore.createTask(params.projectId, body.task, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          ...actorOptions(identity, body),
          metadata: body.metadata || null
        });
        return send(res, 201, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/plans/:planIndex");
      if (req.method === "GET" && params) {
        return send(res, 200, await taskStore.readTaskPlan(params.projectId, params.taskId, params.planIndex));
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/documents/:documentIndex");
      if (req.method === "GET" && params) {
        return send(res, 200, await taskStore.readTaskDocument(params.projectId, params.taskId, params.documentIndex));
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/history");
      if (req.method === "GET" && params) {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
        return send(res, 200, { events: await taskStore.taskHistory(params.projectId, params.taskId, { limit }) });
      }
      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/guard");
      if (req.method === "GET" && params) {
        const pair = await taskStore.getTask(params.projectId, params.taskId);
        const actorContext = {
          actorType: url.searchParams.get("actorType") || "developer_ai",
          actorId: url.searchParams.get("actorId") || identity.actorId || "taskctl",
          sessionId: url.searchParams.get("sessionId") || ""
        };
        const userMessages = await taskStore.userMessageState(params.projectId, params.taskId, actorContext);
        const preclaimReport = await taskStore.preclaimReportState(params.projectId, params.taskId, actorContext, pair.task);
        return send(res, 200, {
          taskId: params.taskId, status: pair.task.status,
          registryRevision: pair.snapshot.registryRevision,
          preclaimReport,
          ...(await taskStore.stopState(params.projectId, params.taskId)),
          takeover: await taskStore.takeoverState(params.projectId, params.taskId),
          autoCloseAuthorization: await taskStore.autoCloseAuthorizationState(params.projectId, params.taskId),
          userMessages,
          requirements: await requirementStore.pending(params.projectId)
        });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId");
      if (req.method === "GET" && params) {
        const pair = await taskStore.getTask(params.projectId, params.taskId);
        return send(res, 200, {
          ...pair.task, registryRevision: pair.snapshot.registryRevision,
          stop: await taskStore.stopState(params.projectId, params.taskId),
          takeover: await taskStore.takeoverState(params.projectId, params.taskId),
          autoCloseAuthorization: await taskStore.autoCloseAuthorizationState(params.projectId, params.taskId),
          presentation: await taskStore.presentation(params.projectId, params.taskId),
          testResources: await taskStore.testResourceState(params.projectId, params.taskId),
          userMessages: await taskStore.userMessageState(params.projectId, params.taskId, {
            actorType: identity.mode === "session" ? "user" : "developer_ai",
            actorId: identity.actorId,
            sessionId: ""
          })
        });
      }
      if (req.method === "PATCH" && params) {
        const body = await readJson(req);
        requireOperation(body);
        if (!body.patch || typeof body.patch !== "object") throw new TaskboardError("patch不能为空", { code: "INVALID_PATCH", status: 400 });
        const result = await taskStore.updateTask(params.projectId, params.taskId, body.patch, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: body.eventType || "task_update",
          ...actorOptions(identity, body),
          metadata: body.metadata || null
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/ack-user-messages");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const actorContext = {
          actorType: body.actorType || (identity.mode === "session" ? "user" : "developer_ai"),
          actorId: body.actorId || identity.actorId || "taskctl",
          sessionId: body.sessionId || ""
        };
        if (actorContext.actorType === "user") {
          throw new TaskboardError("用户无需确认已读自己的留言", { code: "USER_MESSAGE_ACK_ACTOR_INVALID", status: 400 });
        }
        const state = await taskStore.userMessageState(params.projectId, params.taskId, actorContext);
        const requestedIds = Array.isArray(body.eventIds) && body.eventIds.length
          ? body.eventIds.map(String)
          : state.unreadMessages.map((item) => item.eventId);
        const unreadIds = new Set(state.unreadMessages.map((item) => item.eventId));
        const eventIds = requestedIds.filter((eventId) => unreadIds.has(eventId));
        if (!eventIds.length) return send(res, 200, { acknowledged: [], alreadyRead: true, userMessages: state });
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "user_message_ack",
          ...actorOptions(identity, { ...body, actorType: actorContext.actorType, actorId: actorContext.actorId, sessionId: actorContext.sessionId }),
          note: body.note || "已阅读用户留言",
          metadata: { ...(body.metadata || {}), scope: state.scope, eventIds }
        });
        return send(res, 200, {
          ...result,
          acknowledged: eventIds,
          userMessages: await taskStore.userMessageState(params.projectId, params.taskId, actorContext)
        });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/reply-user-message");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const note = String(body.note || "").trim();
        if (!note) throw new TaskboardError("AI回复内容不能为空", { code: "USER_MESSAGE_REPLY_EMPTY", status: 400 });
        const messageEventId = String(body.messageEventId || "").trim();
        if (!messageEventId) throw new TaskboardError("必须指定要回复的用户留言eventId", { code: "USER_MESSAGE_REPLY_TARGET_REQUIRED", status: 400 });
        const history = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 1000 });
        const target = history.find((event) => event.event_id === messageEventId && event.actor_type === "user" && event.event_type === "user_review");
        if (!target) throw new TaskboardError("找不到对应的用户留言", {
          code: "USER_MESSAGE_REPLY_TARGET_INVALID", status: 404, details: { messageEventId }
        });
        const replyActorType = body.actorType || "developer_ai";
        if (replyActorType === "user") throw new TaskboardError("用户不能通过AI回复接口回复自己", {
          code: "USER_MESSAGE_REPLY_ACTOR_INVALID", status: 400
        });
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "user_message_reply",
          ...actorOptions(identity, { ...body, actorType: replyActorType }),
          note,
          metadata: { ...(body.metadata || {}), replyToEventId: messageEventId }
        });
        return send(res, 200, {
          ...result,
          userMessages: await taskStore.userMessageState(params.projectId, params.taskId, {
            actorType: replyActorType,
            actorId: body.actorId || identity.actorId || "taskctl",
            sessionId: body.sessionId || ""
          })
        });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/preclaim-report");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        if (identity.mode === "session") {
          throw new TaskboardError("认领前汇报只能由AI执行身份登记", {
            code: "PRECLAIM_REPORT_ACTOR_INVALID", status: 403
          });
        }
        const actorType = body.actorType || "developer_ai";
        if (!["developer_ai", "test_ai"].includes(actorType)) {
          throw new TaskboardError("认领前汇报actorType必须为developer_ai或test_ai", {
            code: "PRECLAIM_REPORT_ACTOR_INVALID", status: 400, details: { actorType }
          });
        }
        const actorId = String(body.actorId || identity.actorId || "").trim();
        const sessionId = String(body.sessionId || "").trim();
        const note = String(body.note || "").trim();
        if (!actorId || !sessionId) {
          throw new TaskboardError("认领前汇报必须提供稳定actorId和sessionId", {
            code: "PRECLAIM_REPORT_IDENTITY_REQUIRED", status: 400
          });
        }
        if (!note) {
          throw new TaskboardError("认领前汇报内容不能为空", {
            code: "PRECLAIM_REPORT_NOTE_REQUIRED", status: 400
          });
        }
        const { task } = await taskStore.getTask(params.projectId, params.taskId);
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "preclaim_report",
          ...actorOptions(identity, {
            ...body,
            actorType,
            actorId,
            sessionId
          }),
          note,
          metadata: {
            ...(body.metadata || {}),
            taskStatus: task.status,
            taskUpdatedAt: String(task.updatedAt || ""),
            plannedRole: task.plannedRole || ""
          }
        });
        return send(res, 200, {
          ...result,
          preclaimReport: await taskStore.preclaimReportState(params.projectId, params.taskId, {
            actorType, actorId, sessionId
          }, task)
        });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/events");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        if (!body.eventType) throw new TaskboardError("eventType不能为空", { code: "INVALID_EVENT_TYPE", status: 400 });
        if (params.projectId === "erp-x20" && body.eventType === "code_published") {
          const { task } = await contextAndTask(taskStore, params.projectId, params.taskId);
          const m = body.metadata || {};
          if (body.actorType !== "developer_ai" || !body.actorId || !body.sessionId ||
              !/^[a-f0-9]{40}$/.test(m.commitSha || "") ||
              !/^(feature|fix|hotfix|codex|integration)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(m.headBranch || "") ||
              m.headBranch.includes("..") || m.headBranch.includes("//") ||
              m.pushed !== true) {
            throw new TaskboardError("ERP代码推送证据必须绑定开发身份、会话、固定提交与分支", {
              code: "ERP_CODE_PUBLISHED_BINDING_REQUIRED", status: 409
            });
          }
          requireCurrentExecutionSession(task, body, {
            actorType: "developer_ai", allowedStatuses: ["开发中", "修复中"]
          });
          const claims = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 1000 });
          const activeClaim = [...claims].reverse().find(e => e.event_type === "claim" &&
            e.actor_type === "developer_ai" && e.session_id === task.sessionId);
          if (!activeClaim || activeClaim.actor_id !== body.actorId) {
            throw new TaskboardError("ERP提交证据必须由当前开发认领者本人登记", {
              code: "ERP_CODE_PUBLISH_ACTOR_MISMATCH", status: 409
            });
          }
        }
        const invalidatesTest = body.eventType === "code_change" || body.metadata?.invalidatesTestEvidence === true;
        if (invalidatesTest) {
          const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
          if (task.status === "交付中") {
            const actorType = body.actorType || "developer_ai";
            if (actorType !== "developer_ai") throw new TaskboardError("交付变更只能由developer_ai记录", { code: "DELIVERY_CHANGE_ROLE_REQUIRED", status: 409 });
            requireCurrentExecutionSession(task, body, { actorType, allowedStatuses: ["交付中"] });
            context.workflow.assertTransition(task.status, "待复测");
            const result = await taskStore.updateTask(params.projectId, params.taskId, {
              status: "待复测", plannedRole: "独立测试AI", assignee: "", sessionWindowName: "", sessionId: ""
            }, {
              expectedRevision: snapshot.registryRevision, operationId: body.operationId, eventType: body.eventType,
              ...actorOptions(identity, { ...body, actorType }),
              metadata: { ...(body.metadata || {}), testEvidenceInvalidated: true, invalidatedFromStatus: task.status, handoffTarget: "待复测", releasedAssignee: task.assignee || null, releasedSessionId: task.sessionId || null }
            });
            return send(res, 200, result);
          }
        }
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId, eventType: body.eventType,
          ...actorOptions(identity, body), metadata: body.metadata || null
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/complete-execution");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body); requireExpectedRevision(body);
        const { context, task } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const actorType = body.actorType || "developer_ai";
        if (actorType !== "developer_ai") {
          throw new TaskboardError("开发交接只能由developer_ai完成", {
            code: "DEVELOPER_COMPLETION_ROLE_REQUIRED", status: 409, details: { actorType }
          });
        }
        requireCurrentExecutionSession(task, body, {
          actorType,
          allowedStatuses: ["开发中", "修复中"]
        });
        // ERP candidate_merge evidence must preserve the actual developer
        // who held this execution Session, never a generic CLI actor.
        if (params.projectId === "erp-x20") {
          const history = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 1000 });
          const developerClaim = [...history].reverse().find(event =>
            event.event_type === "claim" && event.actor_type === "developer_ai" &&
            event.session_id === task.sessionId);
          if (!body.actorId || body.actorId === "taskctl" ||
              !developerClaim || developerClaim.actor_id !== body.actorId) {
            throw new TaskboardError("ERP开发交接身份必须与当前正式认领者相同", {
              code: "DEVELOPER_COMPLETION_IDENTITY_MISMATCH", status: 409
            });
          }
        }
        const target = developerCompletionTarget(task.status);
        context.workflow.assertTransition(task.status, target.status);
        const result = await taskStore.updateTask(params.projectId, params.taskId, {
          status: target.status,
          plannedRole: target.plannedRole,
          assignee: "",
          sessionWindowName: "",
          sessionId: ""
        }, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: "handoff",
          ...actorOptions(identity, { ...body, actorType }),
          metadata: {
            ...(body.metadata || {}),
            atomicLifecycle: true,
            completedFromStatus: task.status,
            handoffTarget: target.status,
            releasedAssignee: task.assignee || null,
            releasedSessionWindowName: task.sessionWindowName || null,
            releasedSessionId: task.sessionId || null
          }
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/test-result");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body); requireExpectedRevision(body);
        const testResult = String(body.testResult || "").trim();
        if (!["pass", "fail", "blocked"].includes(testResult)) {
          throw new TaskboardError("testResult必须为pass/fail/blocked", { code: "INVALID_TEST_RESULT", status: 400 });
        }
        const reportPath = String(body.reportPath || "").trim();
        if (!reportPath) throw new TaskboardError("独立测试结果必须提供reportPath", { code: "TEST_REPORT_REQUIRED", status: 400 });
        const { context, task } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const actorType = body.actorType || "test_ai";
        if (actorType !== "test_ai" || !body.actorId) {
          throw new TaskboardError("独立测试结果必须由显式test_ai身份提交", {
            code: "TEST_RESULT_ROLE_REQUIRED", status: 409, details: { actorType }
          });
        }
        requireCurrentExecutionSession(task, body, {
          actorType,
          allowedStatuses: ["独测中", "复测中"]
        });
        const target = context.workflow.resolveIndependentTestOutcome(task.status, testResult, { deliveryDisposition: body.deliveryDisposition, deliveryActions: body.deliveryActions, autoCloseAuthorized: (await taskStore.autoCloseAuthorizationState(params.projectId, params.taskId)).authorized });
        if (params.projectId === "erp-x20" && testResult === "pass" && target.deliveryActions.includes("candidate_merge")) {
          try {
            await erpPassGate.validateSubmission(reportPath, body.metadata);
          } catch (error) {
            throw new TaskboardError("ERP独测可记录通过，但进入Release待交付必须提供固定SHA、分支、无阻断门禁与可信报告SHA256", {
              code: "ERP_PASS_EVIDENCE_REQUIRED", status: 409, details: { reason: error.code || "evidence_unavailable" }
            });
          }
        }
        context.workflow.assertTransition(task.status, target.status);
        const result = await taskStore.updateTask(params.projectId, params.taskId, {
          status: target.status,
          plannedRole: target.plannedRole,
          assignee: "",
          sessionWindowName: "",
          sessionId: ""
        }, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: "test_result",
          ...actorOptions(identity, { ...body, actorType }),
          metadata: {
            ...(body.metadata || {}),
            atomicLifecycle: true,
            testResult,
            deliveryDisposition: target.deliveryDisposition,
            deliveryActions: target.deliveryActions,
            reportPath,
            testedFromStatus: task.status,
            handoffTarget: target.status,
            releasedAssignee: task.assignee || null,
            releasedSessionWindowName: task.sessionWindowName || null,
            releasedSessionId: task.sessionId || null
          }
        });
        if (params.projectId === "erp-x20" && testResult === "pass") {
          try {
            const events = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 1000 });
            const verifiedEvent = events.find((event) => event.event_id === result.eventId);
            if (await erpPassGate.enqueue(params.projectId, verifiedEvent)) {
              queueMicrotask(() => { void erpPassGate.drain().catch((error) => systemEventLog.error("erp-pass-dispatch", "drain_failed", error)); });
            }
          } catch (error) {
            await systemEventLog.error("erp-pass-dispatch", "enqueue_failed", error);
          }
        }
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/release");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body); requireExpectedRevision(body);
        const { context, task } = await contextAndTask(taskStore, params.projectId, params.taskId);
        if (context.workflow.isExecutionStatus(task.status)) {
          throw new TaskboardError("执行中任务不能直接释放；请先完成状态流转或停止确认", {
            code: "RELEASE_EXECUTION_STAGE_INVALID", status: 409, details: { status: task.status }
          });
        }
        if (task.sessionId && !body.sessionId) {
          throw new TaskboardError("释放已有占用必须提供当前sessionId", {
            code: "RELEASE_IDENTITY_REQUIRED", status: 400, details: { currentSessionId: task.sessionId }
          });
        }
        if (task.sessionId && task.sessionId !== body.sessionId) {
          throw new TaskboardError("释放身份与当前任务会话不一致", {
            code: "RELEASE_IDENTITY_MISMATCH", status: 409,
            details: { currentSessionId: task.sessionId, suppliedSessionId: body.sessionId }
          });
        }
        const result = await taskStore.updateTask(params.projectId, params.taskId, {
          assignee: "",
          sessionWindowName: "",
          sessionId: ""
        }, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: "release",
          ...actorOptions(identity, body),
          metadata: {
            ...(body.metadata || {}),
            releasedAssignee: task.assignee || null,
            releasedSessionWindowName: task.sessionWindowName || null,
            releasedSessionId: task.sessionId || null
          }
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/claim");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body); requireExpectedRevision(body);
        const { context, task } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const actorType = body.actorType || "developer_ai";
        if (context.workflow.isExecutionStatus(task.status) || task.assignee || task.sessionId) {
          throw new TaskboardError("任务已被其它执行者占用，禁止重复认领；请先确认原执行者已完成、释放或完成受控接管", {
            code: "TASK_ALREADY_OCCUPIED", status: 409,
            details: {
              status: task.status,
              assignee: task.assignee || null,
              sessionId: task.sessionId || null,
              sessionWindowName: task.sessionWindowName || null
            }
          });
        }
        const actorId = body.actorId || identity.actorId || "taskctl";
        const userMessages = await taskStore.userMessageState(params.projectId, params.taskId, {
          actorType,
          actorId,
          sessionId: body.sessionId || ""
        });
        if (userMessages.requiresAcknowledgement) {
          throw new TaskboardError("存在未读用户留言，必须先阅读并确认已读后才能认领", {
            code: "USER_MESSAGE_ACK_REQUIRED", status: 409,
            details: { unreadMessages: userMessages.unreadMessages }
          });
        }
        const pendingRequirements = await requirementStore.pending(params.projectId);
        if (pendingRequirements.pendingCount > 0) {
          throw new TaskboardError("存在待AI拆解的新需求，必须先处理需求入口后才能认领其它任务", {
            code: "REQUIREMENT_INTAKE_PENDING", status: 409,
            details: { requirements: pendingRequirements.items.filter((item) => item.status === "待AI拆解") }
          });
        }
        const isIndependentStage = ["待独测", "待复测"].includes(task.status);
        if (isIndependentStage && actorType !== "test_ai") {
          throw new TaskboardError("待独测/待复测只能由显式test_ai认领", {
            code: "TEST_ROLE_REQUIRED", status: 409, details: { status: task.status, actorType }
          });
        }
        if (actorType === "test_ai") {
          if (!isIndependentStage) {
            throw new TaskboardError("test_ai只能认领待独测或待复测任务", {
              code: "TEST_CLAIM_STAGE_INVALID", status: 409, details: { status: task.status }
            });
          }
          if (!body.actorId || !body.sessionId) {
            throw new TaskboardError("独立测试认领必须提供稳定actorId和sessionId", {
              code: "TEST_IDENTITY_REQUIRED", status: 400
            });
          }
          const history = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 1000 });
          const conflict = history.find((event) => event.actor_type === "developer_ai"
            && event.event_type === "code_change"
            && (event.actor_id === actorId || event.session_id === body.sessionId));
          if (conflict || (task.sessionId && task.sessionId === body.sessionId)) {
            throw new TaskboardError("当前独测身份与历史实现/修复身份冲突，拒绝冒充独立测试", {
              code: "INDEPENDENT_TEST_CONFLICT", status: 409,
              details: { conflictOperationId: conflict?.operation_id || null }
            });
          }
        }
        const target = claimTarget(context.workflow, task, body.targetStatus);
        if (!body.assignee || !body.sessionWindowName || !body.sessionId) {
          throw new TaskboardError("认领必须提供assignee、sessionWindowName和sessionId", { code: "CLAIM_IDENTITY_REQUIRED", status: 400 });
        }
        const preclaimReport = await taskStore.preclaimReportState(params.projectId, params.taskId, {
          actorType,
          actorId,
          sessionId: body.sessionId
        }, task);
        if (!preclaimReport.valid) {
          throw new TaskboardError("认领前必须先向用户汇报任务ID、主要内容、当前阶段/可认领依据和本轮边界，并登记当前Session的认领前汇报", {
            code: "PRECLAIM_REPORT_REQUIRED",
            status: 409,
            details: preclaimReport
          });
        }
        const result = await taskStore.updateTask(params.projectId, params.taskId, {
          status: target,
          assignee: body.assignee,
          sessionWindowName: body.sessionWindowName,
          sessionId: body.sessionId
        }, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: "claim",
          ...actorOptions(identity, { ...body, actorType: body.actorType || "developer_ai" }),
          metadata: { ...(body.metadata || {}), claimedFromStatus: task.status }
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/review");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const action = body.action || "comment";
        if (["authorize_auto_close", "revoke_auto_close"].includes(action)) {
          requireUserSession(identity);
          requireExpectedRevision(body);
          if (body.expectedRevision !== snapshot.registryRevision) throw new TaskboardError("任务表版本已变化，请刷新后重试", { code: "REGISTRY_REVISION_MISMATCH", status: 409 });
          const eventType = action === "authorize_auto_close" ? "auto_close_authorized" : "auto_close_revoked";
          const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
            operationId: body.operationId, eventType,
            ...actorOptions(identity, { ...body, actorType: "user" }),
            note: body.note || (action === "authorize_auto_close" ? "用户授权该低风险任务在独测/复测通过且无真实交付动作时自动完成" : "用户撤销自动完成授权"),
            metadata: { ...(body.metadata || {}), reviewAction: action, registryRevision: snapshot.registryRevision }
          });
          return send(res, 200, { ...result, autoCloseAuthorization: await taskStore.autoCloseAuthorizationState(params.projectId, params.taskId) });
        }
        if (action === "comment") {
          return send(res, 200, await taskStore.appendTaskEvent(params.projectId, params.taskId, {
            operationId: body.operationId, eventType: "user_review",
            ...actorOptions(identity, body), metadata: body.metadata || null
          }));
        }
        requireExpectedRevision(body);
        let target;
        let eventType;
        if (action === "accept") {
          if (task.status !== "待用户验收") {
            return send(res, 200, await taskStore.appendTaskEvent(params.projectId, params.taskId, {
              operationId: body.operationId, eventType: "user_review",
              ...actorOptions(identity, { ...body, note: body.note || "认可当前进度（当前阶段不能直接完成）" }),
              metadata: { ...(body.metadata || {}), reviewAction: "accept_progress_only", currentStatus: task.status }
            }));
          }
          target = "已完成";
          eventType = "user_accept";
        } else if (action === "reject") {
          target = context.workflow.reviewRejectTarget(body.reason);
          eventType = "user_reject";
        } else if (action === "hold") {
          target = "HOLD";
          eventType = "user_reject";
        } else {
          throw new TaskboardError("未知审阅动作: " + action, { code: "INVALID_REVIEW_ACTION", status: 400 });
        }
        const rejectRole = eventType === "user_reject" ? ({
          "测试失败待修复": "开发AI",
          "待准备": "开发AI",
          "待确认": "用户",
          "HOLD": "—"
        })[target] : null;
        const patch = rejectRole ? { status: target, plannedRole: rejectRole } : { status: target };
        const result = await taskStore.updateTask(params.projectId, params.taskId, patch, {
          expectedRevision: body.expectedRevision || snapshot.registryRevision,
          operationId: body.operationId,
          eventType,
          ...actorOptions(identity, body),
          metadata: { ...(body.metadata || {}), reviewAction: action, reason: body.reason || null }
        });
        return send(res, 200, result);
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/takeover/suspect");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        if (!context.workflow.isExecutionStatus(task.status)) {
          throw new TaskboardError("只有执行中任务可以标记疑似失联", {
            code: "SUSPECTED_DISCONNECT_STAGE_INVALID", status: 409, details: { status: task.status }
          });
        }
        const note = String(body.note || "").trim();
        if (!note) throw new TaskboardError("疑似失联必须填写核验依据", { code: "TAKEOVER_EVIDENCE_REQUIRED", status: 400 });
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "suspected_disconnect",
          ...actorOptions(identity, body),
          metadata: {
            ...(body.metadata || {}),
            observedAssignee: task.assignee || "",
            observedSessionId: task.sessionId || "",
            observedSessionWindowName: task.sessionWindowName || "",
            observedRegistryRevision: snapshot.registryRevision
          }
        });
        return send(res, 200, { ...result, suspectedDisconnect: true, takeoverAllowed: false });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/takeover/allow");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const authorizationEvidence = takeoverAuthorizationEvidence(identity, body, params);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        if (!context.workflow.isExecutionStatus(task.status)) {
          throw new TaskboardError("只有执行中任务可以授权异常接管", {
            code: "TAKEOVER_STAGE_INVALID", status: 409, details: { status: task.status }
          });
        }
        const state = await taskStore.takeoverState(params.projectId, params.taskId);
        if (!state.suspectedDisconnect || !state.suspicion) {
          throw new TaskboardError("必须先记录疑似失联及核验依据，才能授权异常接管", {
            code: "TAKEOVER_SUSPICION_REQUIRED", status: 409
          });
        }
        const note = String(body.note || "").trim();
        if (!note) throw new TaskboardError("允许异常接管必须填写授权依据", { code: "TAKEOVER_EVIDENCE_REQUIRED", status: 400 });
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "takeover_allowed",
          ...actorOptions(identity, body),
          metadata: {
            ...(body.metadata || {}),
            authorizedFromAssignee: task.assignee || "",
            authorizedFromSessionId: task.sessionId || "",
            authorizedFromSessionWindowName: task.sessionWindowName || "",
            authorizedRegistryRevision: snapshot.registryRevision,
            suspicionOperationId: state.suspicion.operation_id || null,
            ...authorizationEvidence
          }
        });
        return send(res, 200, { ...result, suspectedDisconnect: true, takeoverAllowed: true });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/takeover/revoke");
      if (req.method === "POST" && params) {
        requireUserSession(identity);
        const body = await readJson(req);
        requireOperation(body);
        const state = await taskStore.takeoverState(params.projectId, params.taskId);
        if (!state.takeoverAllowed) {
          throw new TaskboardError("当前没有可撤销的异常接管授权", { code: "TAKEOVER_NOT_ALLOWED", status: 409 });
        }
        const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
          operationId: body.operationId,
          eventType: "takeover_revoked",
          ...actorOptions(identity, body),
          metadata: { ...(body.metadata || {}), authorizationOperationId: state.authorization?.operation_id || null }
        });
        return send(res, 200, { ...result, takeoverAllowed: false });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/takeover");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        requireExpectedRevision(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        if (!context.workflow.isExecutionStatus(task.status)) {
          throw new TaskboardError("只有执行中任务可以异常接管", {
            code: "TAKEOVER_STAGE_INVALID", status: 409, details: { status: task.status }
          });
        }
        const state = await taskStore.takeoverState(params.projectId, params.taskId);
        if (!state.takeoverAllowed || !state.authorization) {
          throw new TaskboardError("用户尚未明确允许异常接管", { code: "TAKEOVER_NOT_ALLOWED", status: 409 });
        }
        const authz = state.authorization.metadata || {};
        if (
          (authz.authorizedFromAssignee || "") !== (task.assignee || "") ||
          (authz.authorizedFromSessionId || "") !== (task.sessionId || "") ||
          authz.authorizedRegistryRevision !== snapshot.registryRevision
        ) {
          throw new TaskboardError("异常接管授权已因任务负责人/Session/revision变化而失效", {
            code: "TAKEOVER_AUTHORIZATION_STALE", status: 409,
            details: { authorizedRegistryRevision: authz.authorizedRegistryRevision, currentRegistryRevision: snapshot.registryRevision }
          });
        }
        if (!body.assignee || !body.sessionWindowName || !body.sessionId) {
          throw new TaskboardError("异常接管必须提供assignee、sessionWindowName和sessionId", {
            code: "TAKEOVER_IDENTITY_REQUIRED", status: 400
          });
        }
        const result = await taskStore.updateTask(params.projectId, params.taskId, {
          assignee: body.assignee,
          sessionWindowName: body.sessionWindowName,
          sessionId: body.sessionId
        }, {
          expectedRevision: body.expectedRevision,
          operationId: body.operationId,
          eventType: "takeover",
          ...actorOptions(identity, body),
          metadata: {
            ...(body.metadata || {}),
            authorizationOperationId: state.authorization.operation_id || null,
            previousAssignee: task.assignee || "",
            previousSessionId: task.sessionId || "",
            previousSessionWindowName: task.sessionWindowName || ""
          }
        });
        return send(res, 200, { ...result, takeoverConsumed: true });
      }
      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/stop");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const resumeTarget = context.workflow.resumeTargetForStatus(task.status);
        if (context.workflow.isExecutionStatus(task.status)) {
          const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
            operationId: body.operationId,
            eventType: "stop_request",
            ...actorOptions(identity, body),
            metadata: { ...(body.metadata || {}), resumeTarget, requestedFromStatus: task.status }
          });
          return send(res, 202, { ...result, cooperative: true, stopRequested: true });
        }
        requireExpectedRevision(body);
        context.workflow.assertTransition(task.status, "HOLD");
        const result = await taskStore.updateTask(params.projectId, params.taskId, { status: "HOLD" }, {
          expectedRevision: body.expectedRevision || snapshot.registryRevision,
          operationId: body.operationId,
          eventType: "stop_request",
          ...actorOptions(identity, body),
          metadata: { ...(body.metadata || {}), resumeTarget, requestedFromStatus: task.status, acknowledgedImmediately: true }
        });
        return send(res, 200, { ...result, cooperative: false, stopRequested: false });
      }

      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/ack-stop");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        requireExpectedRevision(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const state = await taskStore.stopState(params.projectId, params.taskId);
        if (!state.stopRequested) {
          throw new TaskboardError("当前任务没有待确认的停止请求", { code: "STOP_ACK_NOT_REQUESTED", status: 409 });
        }
        if (!context.workflow.isExecutionStatus(task.status)) {
          throw new TaskboardError("只有执行中任务可以确认停止", {
            code: "STOP_ACK_STAGE_INVALID", status: 409, details: { status: task.status }
          });
        }
        context.workflow.assertTransition(task.status, "HOLD");
        const resumeTarget = state.request?.metadata?.resumeTarget || context.workflow.resumeTargetForStatus(task.status);
        const result = await taskStore.updateTask(params.projectId, params.taskId, { status: "HOLD" }, {
          expectedRevision: body.expectedRevision || snapshot.registryRevision,
          operationId: body.operationId,
          eventType: "stop_acknowledged",
          ...actorOptions(identity, body),
          metadata: {
            ...(body.metadata || {}),
            resumeTarget,
            requestedFromStatus: task.status,
            stopRequestOperationId: state.request?.operation_id || null
          }
        });
        return send(res, 200, { ...result, cooperative: true, stopRequested: false });
      }
      params = routeMatch(url.pathname, "/api/projects/:projectId/tasks/:taskId/resume");
      if (req.method === "POST" && params) {
        const body = await readJson(req);
        requireOperation(body);
        const { context, task, snapshot } = await contextAndTask(taskStore, params.projectId, params.taskId);
        const history = await taskStore.taskHistory(params.projectId, params.taskId, { limit: 500 });
        if (task.status !== "HOLD") {
          const state = await taskStore.stopState(params.projectId, params.taskId);
          if (!state.stopRequested) throw new TaskboardError("任务当前既非HOLD也无停止请求", { code: "RESUME_NOT_ALLOWED", status: 409 });
          const result = await taskStore.appendTaskEvent(params.projectId, params.taskId, {
            operationId: body.operationId, eventType: "resume",
            ...actorOptions(identity, body), metadata: { ...(body.metadata || {}), cancelledStopRequest: true }
          });
          return send(res, 200, result);
        }
        requireExpectedRevision(body);
        const target = body.targetStatus || lastResumeTarget(history) || "待开发";
        context.workflow.assertTransition(task.status, target);
        const result = await taskStore.updateTask(params.projectId, params.taskId, { status: target }, {
          expectedRevision: body.expectedRevision || snapshot.registryRevision,
          operationId: body.operationId,
          eventType: "resume",
          ...actorOptions(identity, body),
          metadata: { ...(body.metadata || {}), resumedToStatus: target }
        });
        return send(res, 200, result);
      }

      throw new TaskboardError("接口不存在", { code: "NOT_FOUND", status: 404 });
    } catch (error) {
      const status = error instanceof TaskboardError ? error.status : 500;
      await systemEventLog.append({
        level: status >= 500 ? "error" : "warning",
        component: "http-server",
        event: "request_failed",
        operation: String(req.method || "UNKNOWN"),
        result: "failed",
        error_source: "http_request",
        error_code: error.code || "INTERNAL_ERROR",
        error_message: error.message,
        details: {
          method: req.method || null,
          path: requestPath,
          status,
          remote_address: req.socket?.remoteAddress || null,
          taskboard_error: error instanceof TaskboardError,
          error_details: error instanceof TaskboardError ? error.details : null
        }
      });
      if (res.headersSent || res.writableEnded) {
        await systemEventLog.append({
          level: "error",
          component: "http-server",
          event: "request_failed_after_headers",
          operation: String(req.method || "UNKNOWN"),
          result: "failed",
          error_source: "http_request",
          error_code: error.code || "INTERNAL_ERROR",
          error_message: error.message,
          details: { path: requestPath, status, headers_sent: Boolean(res.headersSent), writable_ended: Boolean(res.writableEnded) }
        });
        if (!res.writableEnded) res.end();
        return;
      }
      send(res, status, {
        error: {
          code: error.code || "INTERNAL_ERROR",
          message: status >= 500 && !(error instanceof TaskboardError) ? "服务内部错误" : error.message,
          details: error instanceof TaskboardError ? error.details : null,
        }
      });
    }
  });

  return { server, taskStore, erpPassGate, requirementStore, scanStore, chatBrowserWake, automationControl, systemEventLog, auth, host, port };
}

export async function listenTaskboard(options = {}) {
  const app = await createTaskboardServer(options);
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.port, app.host, () => { app.server.off("error", reject); resolve(); });
  });

  if (app.erpPassGate.dispatchEnabled) queueMicrotask(() => { void app.erpPassGate.drain().catch((error) => app.systemEventLog.error("erp-pass-dispatch", "startup_recovery_failed", error)); });
  return app;
}
