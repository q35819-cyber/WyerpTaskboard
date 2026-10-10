import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveProjectPath } from "./core/path-safety.mjs";

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function splitRefs(value) {
  return String(value || "").split(/[；;]/).map((x) => x.replace(/`/g, "").trim()).filter(Boolean);
}
function normalizedFileRefs(value) {
  return splitRefs(value).map((item) => item.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase());
}
function hardTaskDependencyId(value) {
  const token = String(value || "").replace(/`/g, "").trim();
  const match = token.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*完成$/);
  return match ? match[1] : "";
}
function hardDependencyBlockers(task, tasksById) {
  const blockers = [];
  const seen = new Set();
  for (const ref of splitRefs(task.readDependencies)) {
    const dependencyId = hardTaskDependencyId(ref);
    if (!dependencyId || seen.has(dependencyId)) continue;
    seen.add(dependencyId);
    if (dependencyId === task.id) {
      blockers.push(`前置任务${dependencyId}不能依赖自身完成`);
      continue;
    }
    const dependency = tasksById.get(dependencyId);
    if (!dependency) {
      blockers.push(`前置任务${dependencyId}未登记`);
      continue;
    }
    if (dependency.status !== "已完成") blockers.push(`前置任务${dependencyId}未完成（当前：${dependency.status}）`);
  }
  return blockers;
}
function activeDeveloperTask(task) {
  return ["开发中", "修复中", "交付中"].includes(task.status) && Boolean(task.assignee || task.sessionId);
}
function activeTestTask(task) {
  return ["独测中", "复测中"].includes(task.status) && Boolean(task.assignee || task.sessionId);
}
const TEST_WATCH_STATUSES = new Set(["待独测", "独测中", "待复测", "复测中"]);
const DEVELOPER_WATCH_STATUSES = new Set(["待准备", "待开发", "开发中", "测试失败待修复", "修复中", "待交付", "交付中"]);
function roleFor(task) {
  if (["待开发", "测试失败待修复", "待交付"].includes(task.status)) return "developer_ai";
  if (["待独测", "待复测"].includes(task.status)) return "test_ai";
  if (task.status === "待准备" && task.plannedRole === "开发AI") return "developer_ai";
  return null;
}
function reasonFor(task, eligibleRole, blockers) {
  if (blockers.length) return blockers.join("；");
  if (eligibleRole === "developer_ai") {
    if (task.status === "测试失败待修复") return "已有缺陷等待开发修复";
    if (task.status === "待交付") return "已登记真实交付动作，等待开发AI执行交付";
    if (task.status === "待准备") return "准备条件需要开发AI补齐";
    return "开发任务已就绪";
  }
  if (eligibleRole === "test_ai") return task.status === "待复测" ? "修复已交付，等待独立复测" : "开发已交付，等待独立测试";
  if (eligibleRole === "preparation") return "前置资料/证据仍需准备";
  return "当前阶段不进入认领候选";
}

export class CandidateEvaluator {
  constructor(rootDir, { taskStore, requirementStore, clock = () => Date.now() } = {}) {
    this.rootDir = rootDir;
    this.taskStore = taskStore;
    this.requirementStore = requirementStore;
    this.clock = clock;
  }

  async projectResourceSha(context) {
    try {
      const ledgerPath = await resolveProjectPath(context.rootRealPath, context.project.resourceLedger, { mustExist: true, rejectReparse: true });
      return hash(await fs.readFile(ledgerPath));
    } catch { return ""; }
  }

  async unresolvedUserMessage(projectId, taskId) {
    try {
      const state = await this.taskStore.userMessageState(projectId, taskId, {
        actorType: "scanner", actorId: "task-scan", sessionId: "task-scan"
      });
      const latest = state.messages?.at(-1);
      if (!latest) return null;
      if ((latest.replies || []).length > 0) return null;
      return latest;
    } catch { return null; }
  }

  async evaluateProject(projectId) {
    const detectedAt = new Date(this.clock()).toISOString();
    const context = await this.taskStore.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const resourceLedgerSha = await this.projectResourceSha(context);
    const requirements = await this.requirementStore.pending(projectId).catch(() => ({ pendingCount: 0, waitingUserCount: 0 }));
    const candidates = [];
    const activeDeveloperTasks = parsed.tasks.filter(activeDeveloperTask);
    const tasksById = new Map(parsed.tasks.map((task) => [task.id, task]));

    for (const task of parsed.tasks) {
      if (task.status === "待交付") {
        const history = await this.taskStore.taskHistory(projectId, task.id, { limit: 200 });
        const latestPass = [...history].reverse().find((event) => event.event_type === "test_result" && event.metadata?.testResult === "pass");
        if (!context.workflow.isExecutableDeliveryDecision(latestPass?.metadata || {})) continue;
      }
      const eligibleRole = roleFor(task);
      if (!eligibleRole) continue;
      const blockers = [];
      blockers.push(...hardDependencyBlockers(task, tasksById));
      if (task.assignee || task.sessionId) blockers.push("已有负责人或活动会话");
      if (requirements.pendingCount > 0) blockers.push("存在待AI拆解的新需求");
      const stop = await this.taskStore.stopState(projectId, task.id).catch(() => ({ stopRequested: false }));
      if (stop.stopRequested) blockers.push("存在stop_request");
      const takeover = await this.taskStore.takeoverState(projectId, task.id).catch(() => ({ suspectedDisconnect: false, takeoverAllowed: false }));
      if (takeover.suspectedDisconnect && !takeover.takeoverAllowed) blockers.push("存在未闭合的疑似失联");
      const unresolved = await this.unresolvedUserMessage(projectId, task.id);
      if (unresolved) blockers.push("存在尚未获得AI回复的最新用户留言");
      const readDependencies = splitRefs(task.readDependencies);
      const writeTargets = splitRefs(task.writeTargets);
      if (eligibleRole === "developer_ai") {
        if (!writeTargets.length) blockers.push("未声明计划写文件，不能进入待认领");
        const candidateWrites = new Set(normalizedFileRefs(task.writeTargets));
        for (const active of activeDeveloperTasks) {
          if (active.id === task.id) continue;
          const activeWrites = normalizedFileRefs(active.writeTargets);
          if (!activeWrites.length) {
            blockers.push("开发中任务" + active.id + "未声明写文件组，无法证明无冲突");
            continue;
          }
          const conflict = activeWrites.find((item) => candidateWrites.has(item));
          if (conflict) blockers.push("计划写文件与开发中任务" + active.id + "冲突：" + conflict);
        }
      }

      const dedupeKey = hash([projectId, task.id, task.status, task.updatedAt || "", task.plannedRole || "", eligibleRole].join("|"));
      const sourceFingerprint = hash([parsed.fileSha256, resourceLedgerSha, task.updatedAt || "", task.assignee || "", task.sessionId || ""].join("|"));
      candidates.push({
        project_id: projectId,
        task_id: task.id,
        track: task.track,
        priority: task.priority,
        status: task.status,
        planned_role: task.plannedRole,
        current_assignee: task.assignee || "",
        current_session_id: task.sessionId || "",
        task_updated_at: task.updatedAt || "",
        registry_revision: parsed.registryRevision,
        registry_sha: parsed.fileSha256,
        resource_ledger_sha: resourceLedgerSha,
        read_dependencies: readDependencies,
        write_targets: writeTargets,
        checkpoint_report_refs: splitRefs(task.targets),
        eligible_role: eligibleRole,
        eligible: Boolean(blockers.length === 0),
        blockers,
        reason: reasonFor(task, eligibleRole, blockers),
        source_fingerprint: sourceFingerprint,
        dedupe_key: dedupeKey,
        detected_at: detectedAt,
        requires_runtime_recheck: ["actor_scope_user_messages", "active_webcodex_jobs", "resource_conflicts", "test_ai_independence"],
      });
    }

    return {
      project_id: projectId,
      status: "ok",
      detected_at: detectedAt,
      registry_revision: parsed.registryRevision,
      registry_sha: parsed.fileSha256,
      resource_ledger_sha: resourceLedgerSha,
      task_count: parsed.tasks.length,
      watch: {
        test_tasks: parsed.tasks.filter((task) => TEST_WATCH_STATUSES.has(task.status)).length,
        developer_tasks: parsed.tasks.filter((task) => DEVELOPER_WATCH_STATUSES.has(task.status)).length,
        active_test_tasks: parsed.tasks.filter(activeTestTask).length,
        active_developer_tasks: parsed.tasks.filter(activeDeveloperTask).length,
        pending_requirements: Number(requirements.pendingCount || 0),
      },
      candidates,
    };
  }

  async recheck(candidate) {
    const context = await this.taskStore.projects.context(candidate.project_id);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const task = parsed.tasks.find((x) => x.id === candidate.task_id);
    if (!task) return { ok: false, stale: true, reason: "task_missing" };
    const currentRole = roleFor(task);
    const mismatches = [];
    const dependencyBlockers = hardDependencyBlockers(task, new Map(parsed.tasks.map((item) => [item.id, item])));
    if (dependencyBlockers.length) mismatches.push("hard_dependency_blocked");
    if (parsed.registryRevision !== candidate.registry_revision) mismatches.push("registry_revision_changed");
    if (parsed.fileSha256 !== candidate.registry_sha) mismatches.push("registry_sha_changed");
    if (task.status !== candidate.status) mismatches.push("status_changed");
    if (currentRole !== candidate.eligible_role) mismatches.push("eligible_role_changed");
    if (task.assignee || task.sessionId) mismatches.push("owner_or_session_present");
    return {
      ok: mismatches.length === 0,
      stale: mismatches.length > 0,
      mismatches,
      blockers: dependencyBlockers,
      current: {
        status: task.status,
        planned_role: task.plannedRole,
        assignee: task.assignee,
        session_id: task.sessionId,
        registry_revision: parsed.registryRevision,
        registry_sha: parsed.fileSha256,
      },
      next_step: mismatches.length ? "mark_stale" : "run_taskctl_guard_then_claim",
    };
  }
}
