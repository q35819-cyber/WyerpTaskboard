import crypto from "node:crypto";
import { TaskStore } from "./task-store.mjs";
import { RequirementStore } from "./requirement-store.mjs";
import { ScanStore } from "./scan-store.mjs";
import { CandidateEvaluator } from "./candidate-evaluator.mjs";
import { WakeBridge } from "./wake-bridge.mjs";
import { ChatBrowserWake } from "./chat-browser-wake.mjs";
import { AiExecutionSettingsStore } from "./ai-execution-settings.mjs";

export class TaskScanner {
  constructor(rootDir, { clock = () => Date.now(), taskStore = null, requirementStore = null, scanStore = null, wakeBridge = null, chatBrowserWake = null, aiExecutionSettings = null } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.taskStore = taskStore;
    this.requirementStore = requirementStore;
    this.scanStore = scanStore;
    this.wakeBridge = wakeBridge;
    this.chatBrowserWake = chatBrowserWake;
    this.aiExecutionSettings = aiExecutionSettings;
  }

  async init() {
    this.taskStore ||= await new TaskStore(this.rootDir).init();
    this.requirementStore ||= await new RequirementStore(this.rootDir).init();
    this.scanStore ||= await new ScanStore(this.rootDir, { clock: this.clock }).init();
    this.wakeBridge ||= await new WakeBridge(this.rootDir, { clock: this.clock }).init();
    this.chatBrowserWake ||= await new ChatBrowserWake(this.rootDir, { clock: this.clock }).init();
    this.aiExecutionSettings ||= await new AiExecutionSettingsStore(this.rootDir).init();
    this.evaluator = new CandidateEvaluator(this.rootDir, {
      taskStore: this.taskStore,
      requirementStore: this.requirementStore,
      clock: this.clock,
    });
    return this;
  }


  // Called only by an already-awake role after releasing its previous task.
  // Returns a candidate; the caller still must pass guard/preclaim/claim.
  async nextForRole({ projectId, actorType, actorId, sessionId,
    completedTaskId = "", excludeTaskIds = [] } = {}) {
    if (!projectId || !["developer_ai", "test_ai", "controller_ai"].includes(actorType)
      || !actorId || !sessionId || !Array.isArray(excludeTaskIds)
      || excludeTaskIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new TypeError("projectId, actorType, actorId, sessionId and valid excludeTaskIds are required");
    }
    if (!this.evaluator) await this.init();
    const result = await this.evaluator.evaluateProject(projectId);
    const excluded = new Set([completedTaskId, ...excludeTaskIds].filter(Boolean));
    const rank = (candidate) => actorType === "test_ai"
      ? (candidate.status === "待复测" ? 0 : 1)
      : actorType === "controller_ai" ? 0
        : candidate.status === "测试失败待修复" ? 0
          : candidate.status === "待开发" ? 1 : 2;
    const candidates = result.candidates.filter((candidate) =>
      actorType === "controller_ai" ? candidate.status === "待交付"
        : candidate.eligible_role === actorType && candidate.status !== "待交付")
      .sort((a, b) => Number(b.eligible) - Number(a.eligible)
        || rank(a) - rank(b)
        || ({ P0: 0, P1: 1, P2: 2 }[a.priority] ?? 9)
          - ({ P0: 0, P1: 1, P2: 2 }[b.priority] ?? 9)
        || a.task_id.localeCompare(b.task_id));
    const skipped = candidates.filter((candidate) => !candidate.eligible).map((candidate) => ({
      task_id: candidate.task_id,
      reason: candidate.blockers.join("；") || "not_eligible"
    }));
    for (const candidate of candidates) {
      if (excluded.has(candidate.task_id)) {
        skipped.push({ task_id: candidate.task_id, reason: "previous_task_or_claim_409" });
        continue;
      }
      if (!candidate.eligible) continue;
      const stop = await this.taskStore.stopState(projectId, candidate.task_id);
      if (stop.stopRequested) {
        skipped.push({ task_id: candidate.task_id, reason: "stop_requested" });
        continue;
      }
      let checked;
      try { checked = await this.evaluator.recheck(candidate); }
      catch (error) {
        skipped.push({ task_id: candidate.task_id, reason: error.code || "recheck_failed" });
        continue;
      }
      if (!checked.ok) {
        skipped.push({ task_id: candidate.task_id, reason: "candidate_stale_409",
          mismatches: checked.mismatches || [] });
        continue;
      }
      return {
        state: "next_available", project_id: projectId, role: actorType,
        task_id: candidate.task_id, candidate, skipped,
        next_action: "guard_preclaim_claim", auto_wake: false
      };
    }
    return {
      state: "none", project_id: projectId, role: actorType,
      reason: candidates.length ? "all_candidates_blocked" : "no_role_candidates",
      skipped, auto_wake: false
    };
  }

  async scanOnce({ trigger = "manual" } = {}) {
    if (!this.evaluator) await this.init();
    this.aiExecutionSettings ||= await new AiExecutionSettingsStore(this.rootDir).init();
    const lock = await this.scanStore.acquireRunLock();
    if (!lock.acquired) return { state: "skipped", reason: lock.reason };
    const started = this.clock();
    const statusAtStart = await this.scanStore.status();
    const consumedRearmAt = statusAtStart.rearm_pending ? statusAtStart.rearm_requested_at || null : null;
    const detectedAt = new Date(started).toISOString();
    const runId = "scan_" + crypto.randomUUID();
    const projectResults = [];
    try {
      await this.scanStore.writeStatus({ state: "running", run_id: runId, scan_started_at: detectedAt });
      for (const project of this.taskStore.projects.list()) {
        try {
          projectResults.push(await this.evaluator.evaluateProject(project.id));
        } catch (error) {
          projectResults.push({
            project_id: project.id,
            status: "source_unavailable",
            detected_at: new Date(this.clock()).toISOString(),
            candidates: [],
            error: { code: error.code || "SCAN_PROJECT_FAILED", message: error.message },
          });
        }
      }
      const persisted = await this.scanStore.upsertScan({ runId, detectedAt, projectResults });
      const activeCandidates = await this.scanStore.list();
      const highestEligible = activeCandidates.find((item) => item.eligible) || null;
      let wakeBridge = { state: "disabled", instant_trigger: "disabled_unverified" };
      try {
        wakeBridge = await this.wakeBridge.notifyCandidate(highestEligible);
        if (wakeBridge.state === "sent" || wakeBridge.state === "error") {
          await this.scanStore.appendEvent({
            type: "wake_bridge_" + wakeBridge.state,
            detection_id: wakeBridge.detection_id || null,
            provider: wakeBridge.provider || null,
            error: wakeBridge.error?.message || null,
          });
        }
      } catch (error) {
        wakeBridge = {
          state: "error",
          instant_trigger: "github_bridge_error_fallback",
          error: { code: error.code || "WAKE_BRIDGE_FAILED", message: error.message },
        };
        await this.scanStore.appendEvent({
          type: "wake_bridge_error",
          detection_id: highestEligible?.detection_id || null,
          error: error.message,
        });
      }

      const finished = this.clock();
      const executionSettings = await this.aiExecutionSettings.get();
      const busyScanIntervalMs = Number(executionSettings.scan_interval_minutes || 10) * 60 * 1000;
      const idleScanIntervalMs = Math.max(1_000, Number(executionSettings.idle_scan_interval_seconds || 10) * 1000);
      const watch = projectResults.reduce((acc, item) => {
        if (item.status !== "ok" || !item.watch) return acc;
        acc.testTasks += Number(item.watch.test_tasks || 0);
        acc.developerTasks += Number(item.watch.developer_tasks || 0);
        acc.activeTestTasks += Number(item.watch.active_test_tasks || 0);
        acc.activeDeveloperTasks += Number(item.watch.active_developer_tasks || 0);
        acc.pendingRequirements += Number(item.watch.pending_requirements || 0);
        return acc;
      }, { testTasks: 0, developerTasks: 0, activeTestTasks: 0, activeDeveloperTasks: 0, pendingRequirements: 0 });
      const activeWorkCount = watch.activeTestTasks + watch.activeDeveloperTasks;
      const schedulerMode = activeWorkCount > 0 ? "busy_watch" : "idle_hunt";
      const nextIntervalMs = schedulerMode === "busy_watch" ? busyScanIntervalMs : idleScanIntervalMs;
      const latestStatus = await this.scanStore.status();
      const rearmArrivedDuringScan = Boolean(
        latestStatus.rearm_pending &&
        latestStatus.rearm_requested_at &&
        latestStatus.rearm_requested_at !== consumedRearmAt
      );
      const chatWakeState = await this.chatBrowserWake.readState();
      const ackEntries = Object.entries(chatWakeState.acked || {});
      const chatWake = { ...this.chatBrowserWake.publicStatus(), verified: ackEntries.length > 0, ack_count: ackEntries.length, last_ack_at: ackEntries.map(([,v]) => v?.at).filter(Boolean).sort().at(-1) || null };
      const summary = {
        state: "completed",
        run_id: runId,
        last_scan_at: new Date(finished).toISOString(),
        duration_ms: Math.max(0, finished - started),
        project_count: projectResults.length,
        project_errors: projectResults.filter((x) => x.status !== "ok").length,
        active_candidates: persisted.active,
        created_candidates: persisted.created,
        refreshed_candidates: persisted.refreshed,
        trigger,
        scheduler_mode: schedulerMode,
        scheduler_reason: schedulerMode === "busy_watch" ? "active_task_in_progress" : "no_active_task_hunt_next_work",
        watch_counts: watch,
        scan_interval_minutes: Number(executionSettings.scan_interval_minutes || 10),
        idle_scan_interval_seconds: Number(executionSettings.idle_scan_interval_seconds || 10),
        next_due_at: new Date(finished + nextIntervalMs).toISOString(),
        rearm_pending: rearmArrivedDuringScan,
        rearm_consumed_at: consumedRearmAt ? detectedAt : statusAtStart.rearm_consumed_at || null,
        last_rearm_source: consumedRearmAt ? statusAtStart.rearm_reason || trigger : statusAtStart.last_rearm_source || null,
        armed_at: new Date(finished).toISOString(),
        suspended_at: null,
        instant_trigger: chatWake.verified ? "enabled_verified" : (wakeBridge.instant_trigger || "disabled_unverified"),
        chatgpt_consumer: chatWake.verified ? "browser_extension_event_trigger" : (wakeBridge.instant_trigger === "enabled_verified" ? "event_trigger_verified" : "hourly_or_manual_fallback"),
        chat_browser_wake: chatWake,
        wake_bridge: wakeBridge,
      };
      await this.scanStore.writeStatus(summary);
      await this.scanStore.appendEvent({ type: "scan_completed", ...summary });
      return { ...summary, projects: projectResults };
    } catch (error) {
      await this.scanStore.writeStatus({
        state: "failed",
        run_id: runId,
        last_scan_at: new Date(this.clock()).toISOString(),
        error: { code: error.code || "SCAN_FAILED", message: error.message },
      });
      await this.scanStore.appendEvent({ type: "scan_failed", run_id: runId, error: error.message });
      throw error;
    } finally {
      await this.scanStore.releaseRunLock(lock.token);
    }
  }
}
