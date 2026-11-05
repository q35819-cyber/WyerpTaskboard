import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProjectPath } from "./core/path-safety.mjs";

const gitExec = promisify(execFile);
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function splitRefs(value) {
  return String(value || "").split(/[；;]/).map((x) => x.replace(/`/g, "").trim()).filter(Boolean);
}
function hardTaskDependencyId(value) {
  const token = String(value || "").replace(/`/g, "").trim();
  const match = token.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*完成$/);
  return match ? match[1] : "";
}
export function hardDependencyBlockers(task, tasksById) {
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

export async function provisionalClaimAuthorization(store, projectId, task, tasksById, actor = {}) {
  const unfinished = splitRefs(task.readDependencies).map(hardTaskDependencyId).filter(Boolean)
    .filter((id) => tasksById.get(id)?.status !== "已完成");
  if (!unfinished.length || unfinished.some((id) => id === task.id || !tasksById.has(id))) return null;
  const history = await store.taskHistory(projectId, task.id, { all: true });
  const issuedIndex = history.findLastIndex((event) =>
    event.event_type === "controller_provisional_dev_authorization");
  if (issuedIndex < 0) return null;
  const issued = history[issuedIndex], meta = issued.metadata || {};
  if (issued.actor_type !== "controller_ai" || !issued.actor_id ||
    !["待准备", "待开发"].includes(task.status) ||
    meta.taskId !== task.id || !/^[a-f0-9]{40}$/i.test(String(meta.baseSha || "")) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,127}$/.test(String(meta.worktreeName || "")) ||
    !String(meta.developerActorId || "").trim() || !String(meta.developerSessionId || "").trim() ||
    (actor.actorId && meta.developerActorId !== actor.actorId) ||
    (actor.sessionId && meta.developerSessionId !== actor.sessionId) ||
    !Number.isFinite(Date.parse(meta.expiresAt)) || Date.parse(meta.expiresAt) <= Date.now() ||
    !Array.isArray(meta.upstreamTaskIds) ||
    meta.upstreamTaskIds.length !== new Set(unfinished).size ||
    !unfinished.every((id) => meta.upstreamTaskIds.includes(id)) ||
    history.slice(issuedIndex + 1).some((event) =>
      ["controller_provisional_dev_revoked", "user_provisional_dev_revoked"].includes(event.event_type))) return null;
  const approved = history.find((event) =>
    event.event_id === meta.userAuthorizationEventId && event.actor_type === "user"
    && event.event_type === "user_review" && event.metadata?.approveProvisionalDevelopment === true);
  if (!approved || history.indexOf(approved) >= issuedIndex ||
    history.slice(history.indexOf(approved) + 1).some((event) =>
      event.event_type === "user_provisional_dev_revoked")) return null;
  try {
    const context = await store.projects.context(projectId);
    const root = await fs.realpath(context.rootRealPath);
    const git = async (cwd, ...args) => (await gitExec("git", ["-C", cwd, ...args],
      { encoding: "utf8", windowsHide: true, timeout: 12000 })).stdout.trim();
    if (await git(root, "symbolic-ref", "--short", "HEAD") !== "main" ||
      await git(root, "rev-parse", "HEAD") !== meta.baseSha) return null;
    const worktrees = (await git(root, "worktree", "list", "--porcelain")).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    for (const linked of worktrees) {
      if (path.basename(linked) !== meta.worktreeName) continue;
      const real = await fs.realpath(linked);
      if ((process.platform === "win32" ? real.toLowerCase() : real) ===
        (process.platform === "win32" ? root.toLowerCase() : root)) continue;
      const actualRoot = path.resolve(await git(real, "rev-parse", "--show-toplevel"));
      if ((process.platform === "win32" ? actualRoot.toLowerCase() : actualRoot) !==
        (process.platform === "win32" ? real.toLowerCase() : real)) continue;
      await git(real, "merge-base", "--is-ancestor", meta.baseSha, "HEAD");
      return {
        eventId: issued.event_id, actorId: meta.developerActorId,
        sessionId: meta.developerSessionId, baseSha: meta.baseSha,
        worktreeName: meta.worktreeName, unfinished
      };
    }
  } catch { return null; }
  return null;
}

// The Q2 tester may replace Q1 only with a consumed, task-scoped user authorization.
export function latestAuthorizedTestExecution(history, result) {
  const index = history.indexOf(result);
  if (index < 1 || result.actor_type !== "test_ai") return null;
  const prior = history.slice(0, index);
  const execution = [...prior].reverse().find((event) =>
    event.actor_type === "test_ai" && ["claim", "takeover"].includes(event.event_type));
  if (!execution || execution.actor_id !== result.actor_id || execution.session_id !== result.session_id) return null;
  if (execution.event_type === "claim") return execution;
  const authorizationIndex = prior.findIndex((event) =>
    event.event_type === "takeover_allowed" && event.operation_id === execution.metadata?.authorizationOperationId);
  if (authorizationIndex < 0) return null;
  const authorization = prior[authorizationIndex], approved = authorization.metadata || {};
  const predecessor = [...prior.slice(0, authorizationIndex)].reverse().find((event) =>
    event.actor_type === "test_ai" && ["claim", "takeover"].includes(event.event_type));
  if (!predecessor || !predecessor.actor_id || !predecessor.session_id ||
    predecessor.actor_id === execution.actor_id || predecessor.session_id === execution.session_id ||
    authorization.actor_type !== "test_ai" ||
    authorization.actor_id !== execution.actor_id || authorization.session_id !== execution.session_id ||
    approved.authorizationScope !== "task" ||
    !["browser_user_session", "chat_user_instruction_cooperative"].includes(approved.authorizationSource) ||
    (approved.authorizationSource === "chat_user_instruction_cooperative" &&
      (approved.explicitUserOverride !== true ||
        approved.authorizationForwardedBy !== execution.actor_id ||
        approved.authorizationForwardingSessionId !== execution.session_id)) ||
    !/^[a-f0-9]{64}$/i.test(String(approved.authorizedRegistryRevision || "")) ||
    approved.authorizedRegistryRevision !== authorization.registry_revision_before ||
    authorization.registry_revision_after !== execution.registry_revision_before ||
    authorization.old_status !== execution.old_status ||
    !["独测中", "复测中"].includes(approved.authorizedFromStatus) ||
    approved.authorizedFromStatus !== execution.old_status ||
    approved.authorizedFromSessionId !== predecessor.session_id ||
    execution.metadata?.previousSessionId !== predecessor.session_id ||
    prior.slice(authorizationIndex + 1).some((event) => event.event_type === "takeover_revoked")) return null;
  const handoff = [...prior].reverse().find((event) =>
    event.event_type === "handoff" && event.actor_type === "developer_ai" &&
    ["开发中", "修复中"].includes(event.metadata?.completedFromStatus));
  if (!handoff || prior.indexOf(handoff) >= authorizationIndex ||
    !/^[a-f0-9]{40}$/i.test(String(handoff.metadata?.commitSha || "")) ||
    handoff.metadata.commitSha !== result.metadata?.commitSha ||
    handoff.metadata.headBranch !== result.metadata?.headBranch ||
    !String(result.metadata?.reportPath || "").trim()) return null;
  return execution;
}
export function deliveryEvidence(history, workflow) {
  const latestResult = [...history].reverse().find((event) => event.event_type === "test_result");
  const metadata = latestResult?.metadata || {};
  const passIndex = latestResult ? history.indexOf(latestResult) : -1;
  const prior = passIndex >= 0 ? history.slice(0, passIndex) : [];
  const testerExecution = latestAuthorizedTestExecution(history, latestResult);
  const developerHandoff = [...prior].reverse().find((event) =>
    event.event_type === "handoff" && event.actor_type === "developer_ai"
    && ["开发中", "修复中"].includes(event.metadata?.completedFromStatus));
  const invalidated = passIndex >= 0 && history.slice(passIndex + 1).some((event) =>
    event.event_type === "code_change" || event.event_type === "test_result" || event.metadata?.invalidatesTestEvidence === true);
  const independent = Boolean(testerExecution && developerHandoff &&
    history.indexOf(developerHandoff) < history.indexOf(testerExecution)
    && developerHandoff.actor_id !== latestResult?.actor_id
    && developerHandoff.session_id !== latestResult?.session_id);
  const valid = latestResult?.actor_type === "test_ai" && !invalidated && independent
    && metadata.atomicLifecycle === true
    && workflow.isExecutableDeliveryDecision(metadata)
    && Array.isArray(metadata.deliveryActions)
    && metadata.deliveryActions.includes("candidate_merge")
    && /^[a-f0-9]{40}$/i.test(String(metadata.commitSha || ""))
    && Boolean(String(metadata.headBranch || "").trim());
  return {
    valid,
    eventId: latestResult?.event_id || null,
    latestResult: latestResult || null,
    developerActorId: developerHandoff?.actor_id || "",
    developerSessionId: developerHandoff?.session_id || ""
  };
}

async function currentAutoUnblockedBug(store, projectId, task, history) {
  if (task.track !== "bugfix" || task.status !== "待开发") return false;
  // A fresh machine transition, not a note or an auto-unblock event from an earlier status round.
  const event = [...history].reverse().find((item) =>
    item.old_status && item.new_status && item.old_status !== item.new_status);
  if (event?.event_type !== "auto_unblock" || event.actor_type !== "system" ||
    event.actor_id !== "task-scan" || event.old_status !== "阻断" ||
    event.new_status !== "待开发" || event.metadata?.restoreStatus !== "待开发") return false;
  const blocked = history.find((item) => item.event_id === event.metadata?.blockedEventId);
  if (!blocked || blocked.new_status !== "阻断" ||
    !["temporary_block", "developer_paused_for_independent_full_suite_gate"].includes(blocked.event_type)) return false;
  const operationId = "auto_unblock." + hash(projectId + "|" + task.id + "|" + blocked.event_id);
  if (event.operation_id !== operationId) return false;
  const transaction = await store.transactions.read(operationId);
  return transaction?.state === "committed" && transaction.projectId === projectId &&
    transaction.taskId === task.id && transaction.eventId === event.event_id &&
    transaction.result?.eventId === event.event_id &&
    transaction.event?.event_type === "auto_unblock";
}

function activeDeveloperTask(task) {
  return ["开发中", "修复中"].includes(task.status) && Boolean(task.assignee || task.sessionId);
}
function activeTestTask(task) {
  return ["独测中", "复测中"].includes(task.status) && Boolean(task.assignee || task.sessionId);
}
const TEST_WATCH_STATUSES = new Set(["待独测", "独测中", "待复测", "复测中"]);
const DEVELOPER_WATCH_STATUSES = new Set(["待准备", "待开发", "待执行", "开发中", "测试失败待修复", "修复中"]);
function roleFor(task) {
  if (["待开发", "待执行", "测试失败待修复"].includes(task.status)) return "developer_ai";
  if (task.status === "待交付") return "controller_ai";
  if (["待独测", "待复测"].includes(task.status)) return "test_ai";
  if (task.status === "待准备" && task.plannedRole === "开发AI") return "developer_ai";
  return null;
}
function reasonFor(task, eligibleRole, blockers) {
  if (blockers.length) return blockers.join("；");
  if (eligibleRole === "controller_ai") return "已登记真实交付动作，等待总控AI交付";
  if (eligibleRole === "developer_ai") {
    if (task.status === "测试失败待修复") return "已有缺陷等待开发修复";
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
    await this.taskStore.autoRestoreTemporaryBlocks(projectId);
    const detectedAt = new Date(this.clock()).toISOString();
    const context = await this.taskStore.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const resourceLedgerSha = await this.projectResourceSha(context);
    const requirements = await this.requirementStore.pending(projectId).catch(() => ({ pendingCount: 0, waitingUserCount: 0 }));
    const candidates = [];
    const tasksById = new Map(parsed.tasks.map((task) => [task.id, task]));
    const unlockCounts = new Map(parsed.tasks.map((task) => [task.id, 0]));
    for (const dependent of parsed.tasks) {
      if (["已完成", "已取消"].includes(dependent.status)) continue;
      for (const dependencyId of new Set(splitRefs(dependent.readDependencies).map(hardTaskDependencyId).filter(Boolean))) {
        if (dependencyId !== dependent.id && tasksById.has(dependencyId)
          && tasksById.get(dependencyId).status !== "已完成") {
          unlockCounts.set(dependencyId, (unlockCounts.get(dependencyId) || 0) + 1);
        }
      }
    }

    for (const task of parsed.tasks) {
      let delivery = null;
      if (task.status === "待交付") {
        const history = await this.taskStore.taskHistory(projectId, task.id, { limit: 1000 });
        delivery = deliveryEvidence(history, context.workflow);
      }
      const eligibleRole = roleFor(task);
      if (!eligibleRole) continue;
      const blockers = [];
      if (task.status === "待交付" && !delivery?.valid) {
        blockers.push("缺少有效的最新独立测试PASS、candidate_merge动作或固定候选SHA；任务保留在看板但禁止认领");
      }
      const dependencyBlockers = hardDependencyBlockers(task, tasksById);
      const provisional = eligibleRole === "developer_ai" && dependencyBlockers.length
        ? await provisionalClaimAuthorization(this.taskStore, projectId, task, tasksById) : null;
      if (!provisional) blockers.push(...dependencyBlockers);
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
      const developerEvents = eligibleRole === "developer_ai"
        ? await this.taskStore.taskHistory(projectId, task.id, { limit: 100 })
        : [];
      const urgency = [...developerEvents].reverse().find((event) => event.actor_type === "user"
        && (typeof event.metadata?.urgent === "boolean" || event.event_type === "priority_change"));
      const userUrgent = typeof urgency?.metadata?.urgent === "boolean"
        ? urgency.metadata.urgent
        : urgency?.event_type === "priority_change" && urgency.new_priority === "P0";
      const priorDeveloper = [...developerEvents].reverse().find((event) =>
        event.actor_type === "developer_ai" && ["claim", "takeover"].includes(event.event_type));
      const autoUnblockedBug = eligibleRole === "developer_ai" &&
        await currentAutoUnblockedBug(this.taskStore, projectId, task, developerEvents);
      if (eligibleRole === "developer_ai") {
        if (!writeTargets.length) blockers.push("未声明计划写文件，不能进入待认领");
      }

      const dedupeKey = hash([projectId, task.id, task.status, task.updatedAt || "", task.plannedRole || "", eligibleRole].join("|"));
      const sourceFingerprint = hash([parsed.fileSha256, resourceLedgerSha, task.updatedAt || "", task.assignee || "", task.sessionId || "", delivery?.eventId || "", delivery?.developerActorId || "", delivery?.developerSessionId || "", provisional?.eventId || ""].join("|"));
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
        delivery_evidence_event_id: delivery?.eventId || null,
        provisional_authorization_event_id: provisional?.eventId || null,
        provisional: Boolean(provisional),
        eligible_role: eligibleRole,
        auto_unblocked_bug: Boolean(autoUnblockedBug),
        user_urgent: Boolean(userUrgent),
        unlocks_count: unlockCounts.get(task.id) || 0,
        original_developer_actor_id: task.status === "测试失败待修复" ? priorDeveloper?.actor_id || null : null,
        eligible_actor_id: eligibleRole === "controller_ai" ? null : (provisional?.actorId || delivery?.developerActorId || null),
        eligible_session_id: eligibleRole === "controller_ai" ? null : (provisional?.sessionId || delivery?.developerSessionId || null),
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
    const tasksById = new Map(parsed.tasks.map((item) => [item.id, item]));
    const dependencyBlockers = hardDependencyBlockers(task, tasksById);
    const provisional = dependencyBlockers.length && currentRole === "developer_ai"
      ? await provisionalClaimAuthorization(this.taskStore, candidate.project_id, task, tasksById) : null;
    if (task.status === "待交付") {
      const history = await this.taskStore.taskHistory(candidate.project_id, task.id, { limit: 1000 });
      const delivery = deliveryEvidence(history, context.workflow);
      if (!delivery.valid || delivery.eventId !== (candidate.delivery_evidence_event_id || null)) {
        mismatches.push("delivery_evidence_changed");
      }
      if (candidate.eligible_actor_id && delivery.developerActorId !== candidate.eligible_actor_id) {
        mismatches.push("delivery_developer_changed");
      }
      if (candidate.eligible_session_id && delivery.developerSessionId !== candidate.eligible_session_id) {
        mismatches.push("delivery_session_changed");
      }
    }
    if (dependencyBlockers.length && !provisional) mismatches.push("hard_dependency_blocked");
    if ((candidate.provisional_authorization_event_id || null) !== (provisional?.eventId || null) ||
      (provisional && (candidate.eligible_actor_id !== provisional.actorId ||
        candidate.eligible_session_id !== provisional.sessionId))) mismatches.push("provisional_authorization_changed");
    if (parsed.registryRevision !== candidate.registry_revision) mismatches.push("registry_revision_changed");
    if (parsed.fileSha256 !== candidate.registry_sha) mismatches.push("registry_sha_changed");
    if (task.status !== candidate.status) mismatches.push("status_changed");
    if (currentRole !== candidate.eligible_role) mismatches.push("eligible_role_changed");
    if (task.assignee || task.sessionId) mismatches.push("owner_or_session_present");
    return {
      ok: mismatches.length === 0,
      stale: mismatches.length > 0,
      mismatches,
      blockers: provisional ? [] : dependencyBlockers,
      current: {
        status: task.status,
        planned_role: task.plannedRole,
        assignee: task.assignee,
        session_id: task.sessionId,
        registry_revision: parsed.registryRevision,
        registry_sha: parsed.fileSha256,
        required_actor_id: task.status === "待交付" ? (candidate.eligible_actor_id || null) : null,
        required_session_id: task.status === "待交付" ? (candidate.eligible_session_id || null) : null,
      },
      next_step: mismatches.length ? "mark_stale" : "run_taskctl_guard_then_claim",
    };
  }
}
