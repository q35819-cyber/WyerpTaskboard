import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ScanStore } from "./scan-store.mjs";
import { ChatBrowserWake } from "./chat-browser-wake.mjs";
import { ChatgptHealthMonitor } from "./chatgpt-health-monitor.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const execFileAsync = promisify(execFile);

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export class TaskboardRuntimeStatus {
  constructor(rootDir, {
    clock = () => Date.now(),
    healthSchedulerProbe = null,
    taskStore = null
  } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.healthSchedulerProbe = healthSchedulerProbe;
    this.taskStore = taskStore;
  }

  async activeTasks() {
    const active = { developer: [], test: [] };
    if (!this.taskStore?.projects?.list || !this.taskStore?.snapshot) return active;
    const developerStatuses = new Set(["开发中", "修复中", "交付中"]);
    const testStatuses = new Set(["独测中", "复测中"]);
    for (const project of this.taskStore.projects.list()) {
      try {
        const snapshot = await this.taskStore.snapshot(project.id);
        for (const task of snapshot.tasks || []) {
          const summary = {
            project_id: project.id,
            task_id: task.id,
            name: task.parent || task.boundary || task.id,
            status: task.status,
            assignee: task.assignee || null,
            session_id: task.sessionId || null,
            updated_at: task.updatedAt || null
          };
          if (developerStatuses.has(task.status) && task.plannedRole === "开发AI") active.developer.push(summary);
          if (testStatuses.has(task.status) && task.plannedRole === "独立测试AI") active.test.push(summary);
        }
      } catch {
        // Runtime status is observational. One unavailable project must not hide other runtime truth.
      }
    }
    return active;
  }

  async probeHealthScheduler() {
    const recorded = await readJson(
      path.join(this.rootDir, "data", "runtime", "chatgpt-health", "scheduler.json"),
      { version: 1, installed: false, state: "not_recorded", task_name: "WyerpTaskboard-ChatGPT-MCP-Health" }
    );
    if (this.healthSchedulerProbe) return { ...recorded, ...(await this.healthSchedulerProbe()) };
    if (process.platform !== "win32") return recorded;
    const script = path.join(this.rootDir, "scripts", "chatgpt-health-schedule-status.ps1");
    try {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script
      ], { windowsHide: true, timeout: 12000, maxBuffer: 64 * 1024 });
      return { ...recorded, ...JSON.parse(String(stdout).trim()), probe_error: null };
    } catch (error) {
      return { ...recorded, live_probe: false, probe_error: String(error?.message || error).slice(0, 500) };
    }
  }

  async snapshot({ liveProbes = true } = {}) {
    const now = this.clock();
    const [
      pkg,
      manifest,
      wakeCfg,
      healthCfg,
      npmTest,
      healthStatus
    ] = await Promise.all([
      readJson(path.join(this.rootDir, "package.json"), {}),
      readJson(path.join(this.rootDir, "browser-extension", "chat-wake", "manifest.json"), {}),
      readJson(path.join(this.rootDir, "config", "chat-browser-wake.json"), {}),
      readJson(path.join(this.rootDir, "config", "chatgpt-health.json"), {}),
      readJson(path.join(this.rootDir, "data", "runtime", "validation", "npm-test.json"), {
        version: 1, state: "never_run", failedFiles: null, failures: []
      }),
      new ChatgptHealthMonitor(this.rootDir, { clock: this.clock }).init().then(m => m.status())
    ]);

    const scanStore = await new ScanStore(this.rootDir, { clock: this.clock }).init();
    const wake = await new ChatBrowserWake(this.rootDir, { clock: this.clock }).init();
    const [taskScanScheduler, healthScheduler, wakeState] = await Promise.all([
      liveProbes
        ? scanStore.schedulerStatus()
        : readJson(
            path.join(this.rootDir, "data", "runtime", "task-scan", "scheduler.json"),
            { version: 1, installed: false, state: "not_recorded", task_name: "WyerpTaskboard-TaskScan" }
          ),
      liveProbes
        ? this.probeHealthScheduler()
        : readJson(
            path.join(this.rootDir, "data", "runtime", "chatgpt-health", "scheduler.json"),
            { version: 1, installed: false, state: "not_recorded", task_name: "WyerpTaskboard-ChatGPT-MCP-Health" }
          ),
      wake.readState()
    ]);

    const dispatcher = wakeState.dispatcher || null;
    const lastSeenMs = Number(dispatcher?.last_seen_at_ms || 0);
    const staleMs = Math.max(30_000, Number(healthCfg.dispatcher_stale_seconds || 90) * 1000);
    const ageMs = lastSeenMs > 0 ? Math.max(0, now - lastSeenMs) : null;
    const versions = {
      package: String(pkg.version || "") || null,
      extension: String(manifest.version || "") || null,
      expected_extension: String(wakeCfg.expected_extension_version || "") || null,
      extension_runtime: String(dispatcher?.extension_version || "") || null
    };
    versions.taskboard_contract_ok = Boolean(versions.package);
    versions.extension_contract_ok = Boolean(
      versions.extension &&
      versions.extension === versions.expected_extension
    );
    versions.extension_runtime_ok = Boolean(
      versions.extension_runtime &&
      versions.extension_runtime === versions.extension
    );
    versions.contract_ok = Boolean(
      versions.taskboard_contract_ok &&
      versions.extension_contract_ok &&
      versions.extension_runtime_ok
    );

    const activeTasks = await this.activeTasks();
    const registryActivityCandidates = [
      ...activeTasks.developer.map((task) => ({ ...task, role: "developer_ai" })),
      ...activeTasks.test.map((task) => ({ ...task, role: "test_ai" }))
    ].sort((a, b) => {
      const aTime = Date.parse(String(a.updated_at || "")) || 0;
      const bTime = Date.parse(String(b.updated_at || "")) || 0;
      return bTime - aTime || String(a.task_id || "").localeCompare(String(b.task_id || ""));
    });
    const dispatcherTaskId = String(dispatcher?.activity_task_id || "");
    const dispatcherProjectId = String(dispatcher?.activity_project_id || "");
    const registryActivity = registryActivityCandidates.find((task) =>
      task.task_id === dispatcherTaskId && (!dispatcherProjectId || task.project_id === dispatcherProjectId)
    ) || registryActivityCandidates[0] || null;
    const dispatcherPhase = String(dispatcher?.activity_phase || "");
    const activity = {
      project_id: registryActivity?.project_id || dispatcher?.activity_project_id || null,
      task_id: registryActivity?.task_id || dispatcher?.activity_task_id || null,
      detection_id: dispatcher?.activity_detection_id || null,
      role: registryActivity?.role || dispatcher?.activity_role || dispatcher?.role || null,
      phase: dispatcherPhase && dispatcherPhase !== "idle"
        ? dispatcherPhase
        : (registryActivity ? "executing" : (dispatcher?.ui_state === "generating" ? "executing" : "idle")),
      ui_state: dispatcher?.ui_state || null,
      updated_at: registryActivity?.updated_at || dispatcher?.activity_updated_at || dispatcher?.last_ui_seen_at || null
    };
    const visualDesktop = healthStatus?.mcp?.desktop || null;
    const visualChecked = Boolean(healthStatus?.mcp?.invoked);
    const visualAvailable = Boolean(visualChecked && healthStatus?.mcp?.ready && visualDesktop);
    let crossCheck = "pending";
    if (visualAvailable && dispatcher?.ui_state) {
      const visualGenerating = Boolean(visualDesktop.generating_visible);
      const browserGenerating = dispatcher.ui_state === "generating";
      const visualError = Boolean(visualDesktop.error_visible);
      const browserError = dispatcher.ui_state === "execution_error";
      crossCheck = (visualGenerating === browserGenerating && visualError === browserError) ? "agree" : "observe";
    }
    const anomalies = [...new Set([
      ...(Array.isArray(healthStatus?.reasons) ? healthStatus.reasons : []),
      ...(!versions.contract_ok ? ["version_contract_not_current"] : [])
    ])];
    const automationControl = await readJson(
      path.join(this.rootDir, "data", "runtime", "automation-control", "state.json"),
      { version: 1, running: false, unattended: false, user_takeover: false, pending_action: null, last_pause_reason: "manual_start_required" }
    );
    const systemEventLog = await new SystemEventLog(this.rootDir, { clock: this.clock }).init();
    const recentErrors = await systemEventLog.recent({ limit: 20, level: "error" });
    const recentCritical = await systemEventLog.recent({ limit: 20, level: "critical" });
    const recentSystemEvents = [...recentCritical, ...recentErrors]
      .sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))
      .slice(0, 20);
    const npmTestPackageVersion = String(npmTest.package_version || npmTest.packageVersion || "");
    const unattendedAvailable = Boolean(
      npmTest.state === "passed" &&
      Number(npmTest.failedFiles ?? 0) === 0 &&
      npmTestPackageVersion &&
      npmTestPackageVersion === versions.package
    );

    return {
      version: 1,
      captured_at: new Date(now).toISOString(),
      versions,
      activity,
      active_tasks: activeTasks,
      channels: {
        browser_extension: {
          fresh: ageMs != null && ageMs <= staleMs,
          ui_state: dispatcher?.ui_state || null,
          last_seen_at: dispatcher?.last_ui_seen_at || dispatcher?.last_seen_at || null
        },
        visual_snapshot: {
          checked: visualChecked,
          available: visualAvailable,
          checked_at: healthStatus?.checked_at || null,
          desktop: visualDesktop
        },
        cross_check: crossCheck
      },
      anomalies,
      bridge: {
        enabled: Boolean(wakeCfg.enabled),
        mode: "browser_extension_chat_only",
        dispatcher: dispatcher ? {
          role: dispatcher.role || null,
          epoch: Number(dispatcher.dispatcher_epoch || 0) || null,
          last_seen_at: dispatcher.last_seen_at || null,
          age_seconds: ageMs == null ? null : Math.round(ageMs / 1000),
          fresh: ageMs != null && ageMs <= staleMs
        } : null,
        ack_count: Object.keys(wakeState.acked || {}).length
      },
      schedulers: {
        task_scan: taskScanScheduler,
        chatgpt_mcp_health: healthScheduler
      },
      chatgpt_health: healthStatus,
      validation: {
        npm_test: {
          state: npmTest.state || "unknown",
          started_at: npmTest.started_at || null,
          finished_at: npmTest.finished_at || null,
          files: npmTest.files ?? null,
          failed_files: npmTest.failedFiles ?? null,
          duration_ms: npmTest.durationMs ?? null,
          package_version: npmTestPackageVersion || null,
          current_package_version: versions.package,
          version_match: Boolean(npmTestPackageVersion && npmTestPackageVersion === versions.package),
          failures: Array.isArray(npmTest.failures) ? npmTest.failures.slice(0, 10) : []
        }
      },
      mcp: {
        last_probe: healthStatus?.mcp || null,
        transport: "stdio",
        lifecycle: "spawn_on_demand",
        policy: healthCfg.dual_channel_visual_check === true ? "dual_channel_periodic_or_anomaly" : "anomaly_or_explicit_ui_only",
        last_invoked: Boolean(healthStatus?.mcp?.invoked),
        last_mode: healthStatus?.mode || null
      },
      automation_control: {
        running: Boolean(automationControl.running),
        unattended: Boolean(automationControl.unattended),
        unattended_available: unattendedAvailable,
        unattended_effective: Boolean(automationControl.running && automationControl.unattended && unattendedAvailable && !automationControl.user_takeover),
        user_takeover: Boolean(automationControl.user_takeover),
        interaction_paused: Boolean(automationControl.interaction_paused || automationControl.user_takeover),
        takeover_scope: automationControl.takeover_scope || null,
        background_work_preserved: Boolean(automationControl.user_takeover),
        pending_action: automationControl.pending_action || null,
        in_flight_action: automationControl.in_flight_action || null,
        last_completed_action: automationControl.last_completed_action || null,
        last_decision: automationControl.last_decision || null,
        last_pause_reason: automationControl.last_pause_reason || null,
        approval_mode: automationControl.unattended && unattendedAvailable ? "unattended" : "manual_approval"
      },
      system_log: {
        path_pattern: "data/runtime/system-events/YYYY-MM-DD.jsonl",
        recent_error_count: recentSystemEvents.length,
        recent_errors: recentSystemEvents
      },
      policy: {
        session_switch: "read_before_act",
        new_chat_action: "click_existing_chatgpt_new_chat_control",
        user_takeover_scope: "interactive_input_only",
        user_takeover_preserves_background_code_and_tests: true,
        forbidden_shortcuts: ["ctrl+t", "ctrl+n", "ctrl+shift+n"],
        forbid_new_chat_tab_as_session_switch: true
      }
    };
  }
}