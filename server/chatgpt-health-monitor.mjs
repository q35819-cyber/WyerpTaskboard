import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { WindowsMcpClient, textContent } from "./windows-mcp-client.mjs";
import { ChatBrowserWake } from "./chat-browser-wake.mjs";
import { ScanStore } from "./scan-store.mjs";
import { AutomationControlStore } from "./automation-control.mjs";
import { ChatgptMcpExecutor } from "./chatgpt-mcp-executor.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);

function iso(ms) { return new Date(ms).toISOString(); }
function ageSeconds(now, ms) {
  const value = Number(ms || 0);
  return value > 0 ? Math.max(0, Math.round((now - value) / 1000)) : null;
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function imagePart(result) {
  const item = (result?.content || []).find(value => value?.type === "image" && typeof value.data === "string" && value.data.length > 0);
  if (!item) return null;
  const mimeType = String(item.mimeType || item.mime_type || "image/png").toLowerCase();
  const extension = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : mimeType.includes("webp") ? "webp" : "png";
  const buffer = Buffer.from(item.data, "base64");
  return buffer.length ? { buffer, mimeType, extension } : null;
}

function normalizeMcpText(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(item => String(item || "")).join("\n");
    } catch { /* LOG-IGNORE: optional JSON normalization fallback */ }
  }
  return raw;
}

function desktopWindowState(value) {
  const desktop = normalizeMcpText(value);
  const focusedMatch = desktop.match(/Focused Window:\s*\n\s*Name[^\n]*\n[-\s]+\n([^\n]+)/i);
  const focusedWindow = focusedMatch?.[1]?.trim().split(/\s{2,}/)[0] || null;
  const blocks = [...desktop.matchAll(
    /(?:^|\n)\s*[├└]── window "([^"]*Google Chrome)"([\s\S]*?)(?=\n\s*[├└]── window "|$)/gi
  )];
  const chatgptBlock = blocks.find(match =>
    /(?:文档|document)\s+"[^"]*"[^\n]*\[value:"https:\/\/chatgpt\.com\//i.test(match[2] || "")
  ) || null;
  const chatgptWindow = chatgptBlock?.[1] || null;
  const chatgptDesktop = chatgptBlock ? String(chatgptBlock[0] || "") : "";
  return {
    desktop,
    focusedWindow,
    chatgptWindow,
    chatgptDesktop,
    chatgptFocused: Boolean(chatgptWindow && focusedWindow && chatgptWindow === focusedWindow)
  };
}

async function defaultChromeProbe() {
  if (process.platform !== "win32") return { open: null, source: "unsupported_platform" };
  try {
    const { stdout } = await execFileAsync("tasklist.exe", [
      "/FI", "IMAGENAME eq chrome.exe", "/FO", "CSV", "/NH"
    ], { windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024 });
    return { open: /"chrome\.exe"/i.test(String(stdout)), source: "tasklist" };
  } catch (error) {
    return { open: null, source: "tasklist_error", error: String(error?.message || error).slice(0, 300) };
  }
}

function latestRoleSessions(acked = {}) {
  const roles = { developer_ai: null, test_ai: null };
  for (const value of Object.values(acked || {})) {
    const role = value?.role;
    if (!Object.hasOwn(roles, role)) continue;
    const at = Date.parse(value?.at || "") || 0;
    const previousAt = Date.parse(roles[role]?.at || "") || 0;
    if (at >= previousAt) {
      roles[role] = {
        at: value?.at || null,
        conversation_url: value?.conversation_url || null,
        request_count: Number(value?.request_count || 0) || null
      };
    }
  }
  return roles;
}

export class ChatgptHealthMonitor {
  constructor(rootDir, {
    clock = () => Date.now(),
    mcpClientFactory = null,
    chatgptMcpExecutorFactory = null,
    wakeFactory = null,
    chromeProbe = null,
    scanStoreFactory = null,
    systemEventLog = null,
    sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.configPath = path.join(rootDir, "config", "chatgpt-health.json");
    this.dir = path.join(rootDir, "data", "runtime", "chatgpt-health");
    this.statusPath = path.join(this.dir, "status.json");
    this.eventsPath = path.join(this.dir, "events.jsonl");
    this.screenshotDir = path.join(this.dir, "screenshots");
    this.mcpClientFactory = mcpClientFactory || (async () => {
      const automationControl = await new AutomationControlStore(rootDir).init({ resetLifecycle: false });
      return new WindowsMcpClient(rootDir, { automationControl }).init();
    });
    this.chatgptMcpExecutorFactory = chatgptMcpExecutorFactory || (async () => {
      const automationControl = await new AutomationControlStore(rootDir).init({ resetLifecycle: false });
      return new ChatgptMcpExecutor(rootDir, { automationControl }).init();
    });
    this.wakeFactory = wakeFactory || (async () => new ChatBrowserWake(rootDir, { clock }).init());
    this.chromeProbe = chromeProbe || defaultChromeProbe;
    this.scanStoreFactory = scanStoreFactory || (async () => new ScanStore(rootDir).init());
    this.systemEventLog = systemEventLog;
    this.sleep = sleep;
  }

  async init() {
    this.config = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    if (this.config?.version !== 1) throw new Error("unsupported chatgpt-health config version");
    await fs.mkdir(this.dir, { recursive: true });
    await fs.mkdir(this.screenshotDir, { recursive: true });
    this.systemEventLog ||= await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    await this.cleanupAnomalyScreenshots(this.clock());
    return this;
  }

  screenshotRetentionMs() {
    const hours = Math.max(1, Math.min(168, Number(this.config?.anomaly_screenshot_retention_hours || 24)));
    return hours * 60 * 60 * 1000;
  }

  async cleanupAnomalyScreenshots(now = this.clock()) {
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const cutoff = now - this.screenshotRetentionMs();
    let removed = 0;
    for (const entry of await fs.readdir(this.screenshotDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(this.screenshotDir, entry.name);
      const stat = await fs.stat(file).catch((error) => {
        if (error?.code === "ENOENT") return null; // LOG-IGNORE: screenshot may disappear between readdir and stat.
        throw error;
      });
      if (!stat || stat.mtimeMs >= cutoff) continue;
      await fs.rm(file, { force: true });
      removed += 1;
    }
    return { removed, retention_hours: this.screenshotRetentionMs() / 3_600_000 };
  }

  async persistAnomalyScreenshot(result, triggerReasons, now = this.clock()) {
    const image = imagePart(result);
    const retentionHours = this.screenshotRetentionMs() / 3_600_000;
    if (!image) return { saved: false, reason: "image_content_missing", retention_hours: retentionHours };
    await fs.mkdir(this.screenshotDir, { recursive: true });
    const fileName = `anomaly-${now}.${image.extension}`;
    const file = path.join(this.screenshotDir, fileName);
    await fs.writeFile(file, image.buffer);
    return {
      saved: true,
      path: path.relative(this.rootDir, file).replaceAll("\\", "/"),
      mime_type: image.mimeType,
      bytes: image.buffer.length,
      captured_at: iso(now),
      retention_hours: retentionHours,
      trigger_reasons: [...triggerReasons]
    };
  }

  async status() {
    try { return JSON.parse(await fs.readFile(this.statusPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return { version: 1, state: "never_run", healthy: false, checked_at: null };
    }
  }

  async appendEvent(event) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.eventsPath, JSON.stringify(event) + "\n", "utf8");
    const name = String(event.type || "chatgpt_health_event");
    const reasons = Array.isArray(event.reasons) ? event.reasons : Array.isArray(event.post_reasons) ? event.post_reasons : [];
    const level = event.succeeded === false || /error|failed|exhausted/i.test(name + " " + reasons.join(" ")) ? "error" :
      reasons.length || event.to === "degraded" ? "warning" : "info";
    await this.systemEventLog?.append({
      at: event.at || iso(this.clock()),
      level,
      component: "chatgpt-health",
      event: name,
      result: event.succeeded == null ? event.to || null : (event.succeeded ? "succeeded" : "failed"),
      error_source: event.succeeded === false ? "chatgpt_health_recovery" : null,
      details: event
    });
  }

  async collectLightweight(now) {
    const wake = await this.wakeFactory();
    const [wakeState, pkg, manifest, candidatesState, chrome] = await Promise.all([
      wake.readState(),
      readJson(path.join(this.rootDir, "package.json"), {}),
      readJson(path.join(this.rootDir, "browser-extension", "chat-wake", "manifest.json"), {}),
      readJson(path.join(this.rootDir, "data", "runtime", "task-scan", "candidates.json"), { candidates: {} }),
      this.chromeProbe()
    ]);

    const dispatcherStaleMs = Math.max(30_000, Number(this.config.dispatcher_stale_seconds || 90) * 1000);
    const uiHeartbeatStaleMs = Math.max(15_000, Number(this.config.ui_heartbeat_stale_seconds || 45) * 1000);
    const generatingStaleMs = Math.max(60_000, Number(this.config.generating_stale_seconds || 600) * 1000);
    const abnormalUiMs = Math.max(10_000, Number(this.config.abnormal_ui_seconds || 30) * 1000);
    const composerMissingMs = Math.max(15_000, Number(this.config.composer_missing_seconds || 60) * 1000);
    const candidateStallMs = Math.max(30_000, Number(this.config.candidate_stall_seconds || 90) * 1000);
    const ackStallMs = Math.max(15_000, Number(this.config.candidate_ack_stall_seconds || 60) * 1000);

    const dispatcher = wakeState.dispatcher || null;
    const dispatcherAgeMs = dispatcher?.last_seen_at_ms ? Math.max(0, now - Number(dispatcher.last_seen_at_ms)) : null;
    const uiAgeMs = dispatcher?.last_ui_seen_at_ms ? Math.max(0, now - Number(dispatcher.last_ui_seen_at_ms)) : null;
    const uiStateAgeMs = dispatcher?.ui_state_since_at_ms ? Math.max(0, now - Number(dispatcher.ui_state_since_at_ms)) : null;
    const composerMissingAgeMs = dispatcher?.composer_missing_since_at_ms
      ? Math.max(0, now - Number(dispatcher.composer_missing_since_at_ms))
      : null;

    const versions = {
      taskboard_package: String(pkg.version || "") || null,
      extension_manifest: String(manifest.version || "") || null,
      extension_expected: String(wake.config?.expected_extension_version || "") || null,
      extension_runtime: String(dispatcher?.extension_version || "") || null
    };
    versions.taskboard_contract_ok = Boolean(versions.taskboard_package);
    versions.extension_contract_ok = Boolean(
      versions.extension_manifest &&
      versions.extension_manifest === versions.extension_expected
    );
    versions.extension_runtime_ok = Boolean(
      versions.extension_runtime &&
      versions.extension_runtime === versions.extension_manifest
    );
    versions.contract_ok = Boolean(
      versions.taskboard_contract_ok &&
      versions.extension_contract_ok &&
      versions.extension_runtime_ok
    );

    const bridge = {
      configured: Boolean(wake.config?.enabled),
      expected_extension_version: versions.extension_expected,
      extension_runtime_version: versions.extension_runtime,
      dispatcher_fresh: dispatcherAgeMs != null && dispatcherAgeMs <= dispatcherStaleMs,
      dispatcher_last_seen_at: dispatcher?.last_seen_at || null,
      dispatcher_age_seconds: dispatcherAgeMs == null ? null : Math.round(dispatcherAgeMs / 1000),
      dispatcher_role: dispatcher?.role || null,
      ui_heartbeat_fresh: uiAgeMs != null && uiAgeMs <= uiHeartbeatStaleMs,
      ui_last_seen_at: dispatcher?.last_ui_seen_at || null,
      ui_age_seconds: uiAgeMs == null ? null : Math.round(uiAgeMs / 1000),
      ui_state: dispatcher?.ui_state || null,
      ui_state_since_at: dispatcher?.ui_state_since_at || null,
      ui_state_age_seconds: uiStateAgeMs == null ? null : Math.round(uiStateAgeMs / 1000),
      composer_present: dispatcher?.composer_present ?? null,
      switch_safe: dispatcher?.switch_safe ?? null,
      content_busy: dispatcher?.content_busy ?? null,
      conversation_url: dispatcher?.conversation_url || null,
      is_new_chat: dispatcher?.is_new_chat ?? null,
      recovery: dispatcher?.recovery ? {
        at: dispatcher.recovery.at || null,
        action: dispatcher.recovery.action || null,
        status: dispatcher.recovery.status || null,
        attempt: Number(dispatcher.recovery.attempt || 0) || null,
        reason: dispatcher.recovery.reason || null,
        conversation_url: dispatcher.recovery.conversation_url || null
      } : null
    };

    const activeCandidates = Object.values(candidatesState.candidates || {}).filter(item =>
      item?.eligible &&
      !item?.consumed_at &&
      !item?.stale_at &&
      Date.parse(item?.expires_at || "") > now
    );
    const candidateStalls = [];
    for (const item of activeCandidates) {
      const detectionId = item.detection_id;
      if (!detectionId || wakeState.acked?.[detectionId]) continue;
      const candidateAgeMs = Math.max(0, now - (Date.parse(item.first_detected_at || item.detected_at || "") || now));
      const lease = wakeState.leases?.[detectionId] || null;
      const leaseActive = lease && Number(lease.expires_at_ms || 0) > now;
      if (!leaseActive && candidateAgeMs >= candidateStallMs) {
        candidateStalls.push({
          detection_id: detectionId,
          task_id: item.task_id || null,
          role: item.eligible_role || null,
          kind: "unleased",
          age_seconds: Math.round(candidateAgeMs / 1000)
        });
        continue;
      }
      if (leaseActive) {
        const leaseAgeMs = Math.max(0, now - (Date.parse(lease.leased_at || "") || now));
        if (leaseAgeMs >= ackStallMs) {
          candidateStalls.push({
            detection_id: detectionId,
            task_id: item.task_id || null,
            role: item.eligible_role || null,
            kind: "ack_pending",
            age_seconds: Math.round(leaseAgeMs / 1000)
          });
        }
      }
    }

    const reasons = [];
    if (!versions.taskboard_contract_ok) reasons.push("taskboard_version_unavailable");
    if (!versions.extension_contract_ok) reasons.push("extension_contract_mismatch");
    if (!versions.extension_runtime_ok) {
      reasons.push(versions.extension_runtime ? "extension_runtime_outdated" : "extension_runtime_missing");
    }
    if (chrome.open === false) reasons.push("chrome_process_missing");
    if (!bridge.configured) reasons.push("chat_wake_disabled");
    if (!bridge.dispatcher_fresh) reasons.push("chatgpt_dispatcher_stale");
    if (!bridge.ui_heartbeat_fresh) reasons.push("chatgpt_ui_heartbeat_stale");

    if (bridge.ui_heartbeat_fresh) {
      if (bridge.ui_state === "login_required") reasons.push("chatgpt_login_required");
      if (bridge.ui_state === "execution_error") reasons.push("chatgpt_execution_error");
      if (bridge.ui_state === "processing_delayed" && uiStateAgeMs != null && uiStateAgeMs >= abnormalUiMs) {
        reasons.push("chatgpt_processing_delayed");
      }
      if (bridge.ui_state === "generating" && uiStateAgeMs != null && uiStateAgeMs >= generatingStaleMs) {
        reasons.push("chatgpt_generating_stalled");
      }
      if (dispatcher?.composer_present === false && composerMissingAgeMs != null && composerMissingAgeMs >= composerMissingMs) {
        reasons.push("chatgpt_composer_missing");
      }
    }
    if (candidateStalls.some(item => item.kind === "unleased")) reasons.push("candidate_unleased_stalled");
    if (candidateStalls.some(item => item.kind === "ack_pending")) reasons.push("candidate_ack_stalled");

    return {
      versions,
      chrome,
      bridge,
      candidates: {
        active_count: activeCandidates.length,
        stalled: candidateStalls
      },
      role_sessions: latestRoleSessions(wakeState.acked || {}),
      reasons: [...new Set(reasons)]
    };
  }

  async diagnoseWithMcp(triggerReasons) {
    const mcp = {
      invoked: true,
      required: true,
      trigger_reasons: [...triggerReasons],
      ready: false,
      server: null,
      protocol_version: null,
      tool_count: 0,
      desktop: null
    };
    try {
      const client = await this.mcpClientFactory();
      const info = await client.status();
      mcp.ready = true;
      mcp.server = info.server || null;
      mcp.protocol_version = info.protocolVersion || null;
      mcp.tool_count = Number(info.toolCount || 0);

      const snapshot = await client.callTool("Snapshot", {
        use_vision: true,
        use_dom: false,
        use_annotation: false,
        use_ui_tree: true
      });
      const windowState = desktopWindowState(textContent(snapshot));
      const desktop = windowState.desktop;
      const chatgptDesktop = windowState.chatgptDesktop;
      mcp.desktop = {
        chrome_visible: /Google Chrome/i.test(desktop),
        chatgpt_visible: Boolean(windowState.chatgptWindow),
        chatgpt_window_name: windowState.chatgptWindow,
        focused_window_name: windowState.focusedWindow,
        chatgpt_focused: windowState.chatgptFocused,
        generating_visible: /处理中|stop generating|停止生成|停止响应/i.test(chatgptDesktop),
        error_visible: /network error|something went wrong|生成回复时出错|网络错误|发生错误/i.test(chatgptDesktop),
        vision_enabled: true,
        captured_at: iso(this.clock())
      };
      const anomalyReasons = triggerReasons.filter(reason => reason !== "periodic_visual_cross_check");
      if (anomalyReasons.length > 0 && this.config.save_anomaly_screenshots !== false) {
        try {
          const screenshot = await client.callTool("Screenshot", {});
          mcp.screenshot_evidence = await this.persistAnomalyScreenshot(screenshot, anomalyReasons, this.clock());
        } catch (error) {
          mcp.screenshot_evidence = {
            saved: false,
            reason: "screenshot_capture_failed",
            error: String(error?.message || error).slice(0, 300),
            retention_hours: this.screenshotRetentionMs() / 3_600_000
          };
        }
      }
    } catch (error) {
      mcp.error = String(error?.message || error).slice(0, 500);
    }
    return mcp;
  }

  async recoverWithMcp(triggerReasons, mcp, previous, lightweight) {
    const startedMs = this.clock();
    const result = {
      enabled: this.config.auto_recovery_enabled !== false,
      attempted: false,
      succeeded: false,
      action: null,
      started_at: iso(startedMs),
      completed_at: null,
      trigger_reasons: [...triggerReasons],
      task_scan_rearmed: false,
      post_reasons: null
    };
    if (!result.enabled) {
      result.action = "disabled";
      return result;
    }

    const cooldownMs = Math.max(15_000, Number(this.config.auto_recovery_cooldown_seconds || 60) * 1000);
    const previousAt = Date.parse(previous?.recovery?.started_at || "");
    if (Number.isFinite(previousAt) && startedMs - previousAt >= 0 && startedMs - previousAt < cooldownMs) {
      result.action = "cooldown";
      return result;
    }
    if (!mcp?.ready) {
      result.action = "mcp_unavailable";
      return result;
    }

    if (triggerReasons.includes("extension_contract_mismatch")) {
      result.action = "extension_contract_requires_fix";
      return result;
    }
    if (triggerReasons.some(reason =>
      reason === "extension_runtime_outdated" ||
      reason === "extension_runtime_missing"
    )) {
      result.action = "extension_reload_required";
      return result;
    }

    const lastResortReasons = new Set([
      "chatgpt_processing_delayed",
      "chatgpt_generating_stalled",
      "chatgpt_execution_error"
    ]);
    if (!triggerReasons.some(reason => lastResortReasons.has(reason))) {
      result.action = "diagnostic_only_no_refresh";
      return result;
    }

    const browserRecovery = lightweight?.bridge?.recovery || null;
    const evidenceMaxAgeMs = Math.max(
      30_000,
      Number(this.config.refresh_recovery_evidence_max_age_seconds || 300) * 1000
    );
    const recoveryAt = Date.parse(browserRecovery?.at || "");
    const recoveryFresh = Number.isFinite(recoveryAt) && startedMs - recoveryAt >= 0 && startedMs - recoveryAt <= evidenceMaxAgeMs;
    const exhaustedReasons = new Set([
      "retry_recovery_exhausted",
      "processing_delayed_recovery_exhausted",
      "execution_error_recovery_exhausted"
    ]);
    const recoveryExhausted = Boolean(
      browserRecovery &&
      browserRecovery.status === "exhausted" &&
      exhaustedReasons.has(String(browserRecovery.reason || "")) &&
      recoveryFresh
    );
    if (!recoveryExhausted) {
      result.action = "wait_browser_recovery";
      result.browser_recovery = browserRecovery;
      return result;
    }

    const canInterruptGeneration = triggerReasons.some(reason =>
      reason === "chatgpt_generating_stalled" ||
      reason === "chatgpt_processing_delayed" ||
      reason === "chatgpt_execution_error"
    );
    if (mcp.desktop?.generating_visible && !canInterruptGeneration) {
      result.action = "wait_active_generation";
      return result;
    }

    const windowName = mcp.desktop?.chatgpt_window_name || null;
    if (!windowName) {
      result.action = "chatgpt_window_not_found";
      return result;
    }

    result.action = "refresh_existing_chatgpt";
    try {
      const executor = await this.chatgptMcpExecutorFactory();
      const execution = await executor.execute({
        action: "refresh_last_resort",
        recovery_exhausted: true,
        conversation_url: lightweight?.bridge?.conversation_url || browserRecovery?.conversation_url || null,
        window_title: windowName,
        attempt: Number(browserRecovery?.attempt || 0) || 0
      });
      result.attempted = Boolean(execution?.executed);
      result.mcp_execution = execution || null;
      if (!execution?.executed) {
        result.action = "refresh_approval_required";
        result.completed_at = iso(this.clock());
        return result;
      }

      if (triggerReasons.some(reason => reason === "candidate_unleased_stalled" || reason === "candidate_ack_stalled")) {
        const scanStore = await this.scanStoreFactory();
        const rearm = await scanStore.requestRearm("chatgpt_health_recovery", {
          reasons: triggerReasons.filter(reason => reason.startsWith("candidate_"))
        });
        result.task_scan_rearmed = Boolean(rearm?.rearm_pending || rearm?.scheduler_trigger?.started);
      }

      const waitMs = Math.max(500, Number(this.config.auto_recovery_wait_seconds || 4) * 1000);
      await this.sleep(waitMs);
      const post = await this.collectLightweight(this.clock());
      result.post_reasons = [...post.reasons];
      result.succeeded = !post.reasons.some(reason => lastResortReasons.has(reason));
      result.completed_at = iso(this.clock());
      result.post_lightweight = post;
    } catch (error) {
      result.error = String(error?.message || error).slice(0, 500);
      result.completed_at = iso(this.clock());
    }
    return result;
  }

  async check() {
    if (!this.config) await this.init();
    const now = this.clock();
    const checkedAt = iso(now);
    const previous = await this.status();
    const lightweight = await this.collectLightweight(now);
    const triggerReasons = [...lightweight.reasons];

    let mcp;
    let recovery = null;
    let effectiveLightweight = lightweight;
    const dualChannelVisualCheck = this.config.dual_channel_visual_check === true;
    if (triggerReasons.length > 0 || dualChannelVisualCheck) {
      const diagnosticReasons = triggerReasons.length > 0 ? triggerReasons : ["periodic_visual_cross_check"];
      mcp = await this.diagnoseWithMcp(diagnosticReasons);
      if (!mcp.ready) {
        triggerReasons.push("windows_mcp_unavailable");
      } else if (triggerReasons.length > 0) {
        recovery = await this.recoverWithMcp(triggerReasons, mcp, previous, lightweight);
        if (recovery?.post_lightweight) {
          effectiveLightweight = recovery.post_lightweight;
          delete recovery.post_lightweight;
        }
      }
    } else {
      mcp = {
        invoked: false,
        required: false,
        trigger_reasons: [],
        ready: null,
        server: null,
        protocol_version: null,
        tool_count: null,
        desktop: null
      };
    }

    const visualReasons = [];
    if (
      mcp.ready === true &&
      mcp.desktop?.chatgpt_visible &&
      mcp.desktop?.error_visible &&
      effectiveLightweight.bridge?.ui_state !== "execution_error"
    ) {
      visualReasons.push("visual_execution_error");
    }
    const reasons = mcp.ready === false
      ? [...new Set([...effectiveLightweight.reasons, ...visualReasons, "windows_mcp_unavailable"])]
      : [...new Set([...effectiveLightweight.reasons, ...visualReasons])];
    const healthy = reasons.length === 0;
    const next = {
      version: 1,
      state: healthy ? "healthy" : "degraded",
      healthy,
      checked_at: checkedAt,
      interval_minutes: Math.max(1, Number(this.config.interval_minutes || 1)),
      mode: mcp.invoked ? "mcp_diagnostic" : "lightweight_only",
      reasons,
      lightweight: effectiveLightweight,
      mcp,
      recovery,
      chrome: effectiveLightweight.chrome,
      chatgpt_bridge: effectiveLightweight.bridge
    };

    await atomicWriteJson(this.statusPath, next);
    if (
      previous.state !== next.state ||
      JSON.stringify(previous.reasons || []) !== JSON.stringify(next.reasons || []) ||
      Boolean(previous.mcp?.invoked) !== Boolean(next.mcp?.invoked)
    ) {
      await this.appendEvent({
        at: checkedAt,
        type: "chatgpt_health_state_changed",
        from: previous.state || null,
        to: next.state,
        mode: next.mode,
        mcp_invoked: Boolean(next.mcp?.invoked),
        reasons
      });
    }
    if (recovery?.attempted) {
      await this.appendEvent({
        at: recovery.completed_at || checkedAt,
        type: "chatgpt_health_recovery",
        action: recovery.action,
        succeeded: recovery.succeeded,
        task_scan_rearmed: recovery.task_scan_rearmed,
        trigger_reasons: recovery.trigger_reasons,
        post_reasons: recovery.post_reasons || []
      });
    }
    return next;
  }
}
