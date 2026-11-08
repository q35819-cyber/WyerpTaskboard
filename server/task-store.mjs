import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteText } from "./core/atomic-files.mjs";
import { resolveProjectPath } from "./core/path-safety.mjs";
import { withProjectLock } from "./core/project-lock.mjs";
import isPathInside from "./core/vendor/is-path-inside.mjs";
import { ProjectRegistry } from "./project-registry.mjs";
import { EventStore } from "./event-store.mjs";
import { TransactionStore } from "./transaction-store.mjs";
import { ScanStore } from "./scan-store.mjs";
import { RequirementStore } from "./requirement-store.mjs";
import { hardDependencyBlockers, provisionalClaimAuthorization, latestAuthorizedTestExecution, deliveryEvidence } from "./candidate-evaluator.mjs";

function assertOperationId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    throw new TaskboardError("operation_id格式非法", { code: "INVALID_OPERATION_ID", status: 400 });
  }
}
function injectedCrash(phase) {
  throw new TaskboardError(`测试注入崩溃: ${phase}`, {
    code: "INJECTED_CRASH", status: 599, details: { phase },
  });
}

const RULE_INTERNAL=Symbol("RULE_INTERNAL");
const RULE_ANSWERS={parallel_different_tasks:"allow_isolated",parallel_same_task:"deny_duplicate",
stale_takeover:"revoke_old_session",incomplete_dependency_or_stop:"deny_claim",
independent_qa:"unique_qa_only",final_merge:"controller_after_qa_pass",
green_completed_dependency:"skip_green_check_workflow",missing_or_cyclic_dependency:"deny_unresolved"};
const RULE_ROLE_DUTY={developer_ai:"develop_only_own_task",test_ai:"test_independently",controller_ai:"dispatch_and_merge_after_qa"};
const USER_MESSAGE_TYPES = new Set(["user_review"]);
const USER_DECISION_TYPES = new Set(["user_accept", "user_reject"]);
function cleanHumanText(value = "") {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/\*\*/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}
function documentEntries(task, project = {}) {
  const raw = String(task.targets || "");
  const seen = new Set();
  const entries = [];
  const matcher = /(?:^|[；;])\s*\x60?([^；;\x60]+\.md)\x60?/g;
  let match;
  while ((match = matcher.exec(raw))) {
    const documentPath = match[1].trim();
    if (!documentPath || seen.has(documentPath)) continue;
    seen.add(documentPath);
    const normalized = documentPath.replace(/\\/g, "/");
    const checkpointDir = String(project.checkpointDir || "任务进度断点").replace(/\\/g, "/").replace(/\/+$/, "");
    const reportDir = String(project.reportDir || "测试报告").replace(/\\/g, "/").replace(/\/+$/, "");
    let kind = "related";
    if (normalized === checkpointDir || normalized.startsWith(checkpointDir + "/")) kind = "checkpoint";
    else if (normalized === reportDir || normalized.startsWith(reportDir + "/")) kind = "report";
    entries.push({
      index: entries.length,
      kind,
      name: documentPath.split(/[\\/]/).at(-1) || documentPath,
      path: documentPath
    });
  }
  return entries;
}
function planEntries(task) {
  const raw = String(task.plan || "").trim();
  if (!raw) return [];
  return raw.split(/[；;]/).map((value) => value.trim().replace(/^\x60+|\x60+$/g, "")).filter(Boolean).map((planPath, index) => ({
    index,
    name: planPath.split(/[\\/]/).at(-1) || planPath,
    path: planPath,
    primary: index === 0
  }));
}
function readableTitle(task) {
  const raw = String(task.boundary || "");
  const bold = raw.match(/\*\*([^*]{2,100})\*\*/);
  if (bold) return cleanHumanText(bold[1]);
  const text = cleanHumanText(raw);
  if (text) {
    const head = text.split(/[：:；;]/, 1)[0].trim();
    return (head || text).slice(0, 72);
  }
  return task.id + " 任务";
}
function currentProgressText(task, events = []) {
  if (task.status === "交付中") {
    const latestFailure = [...events].reverse().find((event) => event.event_type === "delivery_attempt_failed");
    const laterClaim = latestFailure && [...events].some((event) =>
      event.event_type === "claim" && events.indexOf(event) > events.indexOf(latestFailure));
    if (latestFailure && !laterClaim) {
      const metadata = latestFailure.metadata || {};
      const stage = cleanHumanText(metadata.failureStage || "delivery");
      const code = cleanHumanText(metadata.failureCode || "DELIVERY_ATTEMPT_FAILED");
      const reason = cleanHumanText(metadata.failureMessage || latestFailure.note || "交付步骤失败");
      const next = cleanHumanText(metadata.nextAction || "原开发AI保持当前Session继续处理失败原因，修复后重试合并、推送和回归");
      return `交付受阻（${stage} / ${code}）：${reason}。下一步：${next}`;
    }
  }
  if (task.status === "已完成") {
    const userAccepted = events.some((event) => event.event_type === "user_accept");
    return userAccepted ? "用户已确认UI视觉/交互与业务逻辑，任务已完成。" : "系统自动验收与所需交付门禁均已通过，任务已自动完成。";
  }
  const map = {
    "待确认": "等待需求或规则确认，确认后才能继续。",
    "待准备": "准备条件尚未完全具备，正在等待进入开发/测试所需条件。",
    "待开发": "准备条件已确认，尚未开始正式开发。",
    "开发中": "正在开发实现；执行中的会话和负责人会持续回写。",
    "待独测": "下一步：独立测试AI正式认领，从测试流程起点执行完整独测。",
    "独测中": "独立测试AI正在验证当前实现。",
    "测试失败待修复": "下一步：退回原开发AI修复、自测，通过后重新交独测。",
    "修复中": "正在修复测试发现的问题，修复后进入复测。",
    "待复测": "下一步：独立测试AI重新从测试起点复测修复结果。",
    "复测中": "独立测试AI正在复测修复结果。",
    "待交付": "下一步：原开发AI认领任务，把独测PASS绑定的候选SHA合入origin默认分支。",
    "交付中": "下一步：合并候选SHA并推送；在远端默认分支运行回归，写PASS报告后执行taskctl complete --report关闭任务。",
    "待用户验收": "系统技术验收已完成；只需检查UI视觉/交互与业务逻辑，然后通过或打回。",
    "已完成": "系统验收与所需交付门禁均已通过，任务已完成。",
    "阻断": "当前存在阻断条件，必须先解除阻断才能继续。",
    "HOLD": "任务已暂停，恢复前不会继续执行。",
    "已取消": "任务已取消，不再执行。"
  };
  return map[task.status] || ("当前状态：" + task.status);
}
const execFileAsync = promisify(execFile);
const GIT_SHA = /^[a-f0-9]{40}$/i;
const EXECUTING_DEVELOPER = new Set(["开发中", "修复中", "交付中"]);
const RESERVED_WRITES = new Set(["开发中", "修复中", "交付中", "待独测", "独测中",
  "测试失败待修复", "待复测", "复测中", "待交付", "待用户验收", "阻断"]);
function writePaths(root, value) {
  return String(value || "").split(/[；;]/).map((item) => item.replace(/`/g, "").trim())
    .filter(Boolean).map((item) => {
      const resolved = path.resolve(root, item.replace(/\\/g, "/"));
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    });
}
async function assertDeveloperClaimExclusive(store, projectId, context, parsed, task, actorId, sessionId, allowIsolatedOverlap = false, preserveAutoUnblockScope = false) {
  const requested = writePaths(context.rootRealPath, task.writeTargets);
  if (!requested.length) throw new TaskboardError("开发认领必须声明计划写文件", {
    code: "CLAIM_WRITE_TARGETS_REQUIRED", status: 409
  });
  for (const registered of store.projects.list()) {
    const otherProject = registered.id;
    const otherContext = otherProject === projectId ? context : await store.projects.context(otherProject);
    const otherTasks = otherProject === projectId ? parsed.tasks :
      (await otherContext.adapter.readMarkdownTaskRegistry(otherContext.registryPath, otherContext.project)).tasks;
    for (const other of otherTasks) {
      if (otherProject === projectId && other.id === task.id) continue;
      // A blocked task without an owner or Session cannot hold a live write lock.
      if (other.status === "阻断" && !other.assignee && !other.sessionId) continue;
      const active = EXECUTING_DEVELOPER.has(other.status) && Boolean(other.assignee || other.sessionId);
      const otherPaths = writePaths(otherContext.rootRealPath, other.writeTargets);
      const overlapping = otherPaths.some((item) => requested.some((candidate) =>
        candidate === item || isPathInside(candidate, item) || isPathInside(item, candidate)));
      if (!active && !overlapping) continue;
      let history;
      if (active && sessionId && sessionId === other.sessionId) {
        throw new TaskboardError("同一开发Session不能同时认领多个任务", {
          code: "CLAIM_DEVELOPER_BUSY", status: 409, details: { taskId: other.id, projectId: otherProject }
        });
      }
      if (active || (overlapping && other.status === "HOLD")) {
        history = await store.events.listTaskEvents(otherProject, other.id, { all: true });
      }
      if (active && actorId && [...history].reverse().find((event) =>
        event.actor_type === "developer_ai" && ["claim", "takeover"].includes(event.event_type))?.actor_id === actorId) {
        throw new TaskboardError("同一开发actor不能同时认领多个任务", {
          code: "CLAIM_DEVELOPER_BUSY", status: 409, details: { taskId: other.id, projectId: otherProject }
        });
      }
      if ((otherProject !== projectId || preserveAutoUnblockScope) && !allowIsolatedOverlap && overlapping && (RESERVED_WRITES.has(other.status) ||
        (other.status === "HOLD" && history?.some((event) =>
          event.event_type === "claim" && event.actor_type === "developer_ai")))) {
        throw new TaskboardError("计划写文件与未交付任务冲突", {
          code: "CLAIM_WRITE_CONFLICT", status: 409, details: { taskId: other.id, projectId: otherProject }
        });
      }
    }
  }
}

async function firstClaimableP0Bug(store, projectId, tasks, actorId, sessionId) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (task.track !== "bugfix" || task.priority !== "P0" ||
      !["待准备", "待开发", "待执行", "测试失败待修复"].includes(task.status) ||
      task.assignee || task.sessionId || task.plannedRole !== "开发AI" ||
      !String(task.writeTargets || "").trim() || hardDependencyBlockers(task, byId).length) continue;
    if (task.status === "待准备") {
      const plans = planEntries(task);
      if (!plans.length) continue;
      try {
        const context = await store.projects.context(projectId);
        for (const plan of plans) await resolveProjectPath(context.rootRealPath, plan.path, { mustExist: true, rejectReparse: true });
      } catch { continue; }
      const history = await store.events.listTaskEvents(projectId, task.id, { all: true });
      if (history.some((event) => event.actor_type === "developer_ai"
        && ["claim", "takeover"].includes(event.event_type))) continue;
    }
    if ((await store.stopState(projectId, task.id)).stopRequested) continue;
    const takeover = await store.takeoverState(projectId, task.id);
    if (takeover.suspectedDisconnect && !takeover.takeoverAllowed) continue;
    const messages = await store.userMessageState(projectId, task.id, {
      actorType: "developer_ai", actorId, sessionId
    });
    if (messages.requiresAcknowledgement ||
      (messages.messages?.at(-1) && !messages.messages.at(-1).replies?.length)) continue;
    if (task.status === "测试失败待修复") {
      const history = await store.events.listTaskEvents(projectId, task.id, { all: true });
      const original = [...history].reverse().find((event) =>
        event.actor_type === "developer_ai" && ["claim", "takeover"].includes(event.event_type));
      if (original?.actor_id !== actorId) continue;
    }
    return task.id;
  }
  return null;
}

const TEMPORARY_RESTORE = new Map([
  ["待准备", "待准备"], ["待开发", "待开发"], ["开发中", "待开发"],
  ["待独测", "待独测"], ["独测中", "待独测"],
  ["待复测", "待复测"], ["复测中", "待复测"]
]);
const VERIFIED_DEV_BLOCK_FIXES = {
  blocked: ["WTB-P0-BLOCKED-DEV-RECOVERY-GATE-20261106-T1"],
  developer_c06_blocked: ["WTB-P0-BLOCKED-DEV-RECOVERY-GATE-20261106-T1",
    "WTB-P0-TEST-RUNNER-STEP-CHECKPOINT-TIMEOUT-20261106-T1"],
  developer_r3_runner_timeout_blocked: ["WTB-P0-BLOCKED-DEV-RECOVERY-GATE-20261106-T1",
    "WTB-P0-TEST-RUNNER-STEP-CHECKPOINT-TIMEOUT-20261106-T1"],
  developer_d07_checkpoint_unauthorized_dependency_block: [
    "WTB-P0-BLOCKED-DEV-RECOVERY-GATE-20261106-T1",
    "WTB-P0-DELIVERY-REWORK-D01-CHECKPOINT-20261106-T1"]
};
async function eligibleTemporaryUnblock(store, projectId, task, tasks, context) {
  if (task.status !== "阻断" || task.assignee || task.sessionId) return null;
  const history = await store.events.listTaskEvents(projectId, task.id, { all: true });
  const blocked = [...history].reverse().find((event) =>
    event.old_status !== "阻断" && event.new_status === "阻断");
  const developerPause = blocked?.event_type === "developer_paused_for_independent_full_suite_gate";
  const d01Blocked = blocked?.event_type === "developer_d01_missing_controller_dispatch_block";
  const d09Blocked = blocked?.event_type === "developer_step_cursor_blocked";
  const verifiedDevBlock = Object.hasOwn(VERIFIED_DEV_BLOCK_FIXES, blocked?.event_type || "");
  // Original authorization must belong to the current developer claim cycle.
  const originalAuthorizationFor = (claim) => {
    const index = history.indexOf(claim);
    if (index < 0) return null;
    const priorOwner = history.slice(0, index).findLastIndex((event) =>
      event.actor_type === "developer_ai" && ["claim", "takeover"].includes(event.event_type));
    return history.slice(priorOwner + 1, index).findLast((event) =>
      event.actor_type === "controller_ai" && event.actor_id && event.session_id
      && ["controller_dispatch", "task_created"].includes(event.event_type));
  };
  let recoveryAuthorization = null;
  const d08PendingBlocked = blocked?.event_type === "developer_d08_pending_requirement_scope_gate_blocked";
  const d01ReentryBlocked = blocked?.event_type === "developer_d01_reentry_checkpoint_order_blocked";
  if (d01ReentryBlocked) {
    const blockIndex = history.indexOf(blocked);
    const claim = history.slice(0, blockIndex).findLast((e) =>
      e.event_type === "claim" && e.actor_type === "developer_ai" && e.new_status === "开发中");
    const priorUnblock = history.find((e) => e.event_id === blocked.metadata?.autoUnblockEventId);
    const runnerBlock = history.find((e) => e.event_id === priorUnblock?.metadata?.blockedEventId);
    const transaction = priorUnblock && await store.transactions.read(priorUnblock.operation_id);
    if (blocked.old_status !== "开发中" || blocked.actor_type !== "developer_ai"
      || !claim || claim.old_status !== "待开发" || claim.actor_id !== blocked.actor_id
      || claim.session_id !== blocked.session_id || !claim.session_id
      || blocked.metadata?.newClaimEventId !== claim.event_id
      || blocked.metadata?.failureStage !== "D01_CLAIM"
      || blocked.metadata?.failureCode !== "CHECKPOINT_STEP_ORDER"
      || blocked.metadata?.oldStep !== "D07_TEST_3" || blocked.metadata?.oldResult !== "BLOCK"
      || blocked.metadata?.sourceChanges !== false || blocked.metadata?.codeTouched !== false
      || priorUnblock?.event_type !== "auto_unblock" || priorUnblock.actor_type !== "system"
      || priorUnblock.actor_id !== "task-scan" || priorUnblock.old_status !== "阻断"
      || priorUnblock.new_status !== "待开发"
      || priorUnblock.operation_id !== autoUnblockOperationId(projectId, task.id, runnerBlock?.event_id)
      || transaction?.state !== "committed" || transaction.result?.eventId !== priorUnblock.event_id
      || runnerBlock?.event_type !== "developer_r3_runner_timeout_blocked"
      || runnerBlock.metadata?.failureStage !== "D07_TEST_3"
      || runnerBlock.metadata?.failureCode !== "TEST_RUNNER_30S_SPAWNSYNC_ETIMEDOUT"
      || history.indexOf(runnerBlock) >= history.indexOf(priorUnblock)
      || history.indexOf(priorUnblock) >= history.indexOf(claim)) return null;
    const { TaskStepCheckpoint } = await import("./task-step-checkpoint.mjs");
    const checkpoint = await new TaskStepCheckpoint(store.rootDir, { taskStore: store }).show(projectId, task.id);
    if (!checkpoint.exists || checkpoint.state.cursors.developer_ai !== "D07_TEST_3"
      || !checkpoint.state.records.some((r) => r.stepId === "D07_TEST_3"
        && r.result === "BLOCK" && r.attempt === checkpoint.state.attempts
        && r.actorId === runnerBlock.actor_id && r.sessionId === runnerBlock.session_id)) return null;
  }
  if (d08PendingBlocked) {
    const blockIndex = history.indexOf(blocked);
    const oldClaim = history.slice(0, blockIndex).findLast((event) =>
      event.event_type === "claim" && event.actor_type === "developer_ai"
      && event.old_status === "测试失败待修复" && event.new_status === "修复中"
      && event.actor_id && event.session_id);
    const claimIndex = history.indexOf(oldClaim);
    const qaFailure = history.slice(0, claimIndex).findLast((event) =>
      event.event_type === "test_result" && event.actor_type === "test_ai"
      && event.metadata?.atomicLifecycle === true && event.metadata?.testResult === "fail"
      && event.event_id && event.old_status === "独测中"
      && event.new_status === "测试失败待修复"
      && event.actor_id !== oldClaim?.actor_id
      && String(event.metadata?.reportPath || "").trim());
    const published = history.slice(claimIndex + 1, blockIndex).findLast((event) =>
      event.event_type === "code_published" && event.actor_type === "developer_ai"
      && event.actor_id === oldClaim?.actor_id && event.session_id === oldClaim?.session_id);
    const report = published?.metadata || {};
    const tests = report.developerSelfTests || {};
    const failure = history.slice(claimIndex + 1, blockIndex).find((event) =>
      event.event_id === blocked.metadata?.evidenceEventId
      && event.event_type === "developer_process_preflight_scope_bug"
      && event.actor_type === "developer_ai"
      && event.actor_id === oldClaim?.actor_id && event.session_id === oldClaim?.session_id
      && event.metadata?.failureCode === "REQUIREMENT_INTAKE_PENDING"
      && event.metadata?.candidateSha === report.commitSha);
    const branch = String(report.headBranch || "");
    if (blocked.old_status !== "修复中" || blocked.actor_type !== "developer_ai"
      || blocked.actor_id !== oldClaim?.actor_id || blocked.session_id !== oldClaim?.session_id
      || blocked.metadata?.failureStage !== "D08_HANDOFF"
      || blocked.metadata?.failureCode !== "REQUIREMENT_INTAKE_PENDING"
      || blocked.metadata?.candidateSha !== report.commitSha
      || blocked.metadata?.developerD07 !== "PASS" || blocked.metadata?.noQAHandoff !== true
      || !qaFailure || !published || !failure || !report.remoteVerified
      || report.previousQaFail !== qaFailure.event_id
      || !GIT_SHA.test(report.commitSha || "")
      || !/^[a-f0-9]{64}$/i.test(report.reportSha256 || "")
      || !/^reports\/[A-Za-z0-9][A-Za-z0-9._/-]{1,220}\.md$/.test(String(report.reportPath || ""))
      || String(report.reportPath).includes("..") || String(report.reportPath).includes("//")
      || !/^fix\/[A-Za-z0-9][A-Za-z0-9._/-]{1,180}$/.test(branch)
      || branch.includes("..") || branch.includes("//")
      || !(Number(tests.R1?.passes) > 0 && tests.R1?.failures === 0)
      || !(Number(tests.R2?.passes ?? tests.R2?.uiPasses) > 0 && tests.R2?.failures === 0)
      || !(Number(tests.R3?.files) > 0 && tests.R3?.failedFiles === 0
        && tests.R3?.exitCode === 0)
      || history.slice(claimIndex + 1, blockIndex).some((event) =>
        event.event_type === "test_result" && event.metadata?.testResult === "fail")
      || history.slice(blockIndex + 1).some((event) =>
        ["claim", "takeover"].includes(event.event_type) && event.actor_type === "developer_ai")) return null;
    const pending = await new RequirementStore(store.rootDir).pending(projectId);
    if (pending.pendingCount || pending.waitingUserCount) return null;
    const messages = await store.userMessageState(projectId, task.id, {
      actorType: "scanner", actorId: "task-scan", sessionId: "task-scan"
    });
    if (messages.requiresAcknowledgement || messages.messages?.at(-1)?.replies?.length === 0) return null;
    try {
      const remote = await runGit(context.rootRealPath, ["ls-remote", "origin", "refs/heads/" + branch]);
      if (remote.code !== 0 || remote.stdout.trim() !== report.commitSha + "\trefs/heads/" + branch) return null;
      const frozenReport = await runGit(context.rootRealPath,
        ["show", report.commitSha + ":" + report.reportPath]);
      if (frozenReport.code !== 0 || crypto.createHash("sha256")
        .update(frozenReport.stdout, "utf8").digest("hex") !== report.reportSha256.toLowerCase()) return null;
    } catch { return null; }
  }
  if (verifiedDevBlock || d01ReentryBlocked) {
    const blockIndex = history.indexOf(blocked);
    const claim = history.slice(0, blockIndex).findLast((event) =>
      ["claim", "takeover"].includes(event.event_type) && event.actor_type === "developer_ai"
      && event.new_status === "开发中" && event.actor_id && event.session_id);
    const dispatch = history.slice(blockIndex + 1).find((event) =>
      event.event_type === (d01ReentryBlocked ? "controller_blocker_resolution_plan" : "controller_dispatch")
      && event.actor_type === "controller_ai" && event.actor_id && event.session_id);
    const originalAuthorization = d01ReentryBlocked ? null : originalAuthorizationFor(claim);
    if (blocked.old_status !== "开发中" || blocked.actor_type !== "developer_ai"
      || !claim || claim.actor_id !== blocked.actor_id || claim.session_id !== blocked.session_id
      || (!originalAuthorization && !dispatch) || history.slice(blockIndex + 1).some((event) =>
        ["claim", "takeover"].includes(event.event_type) && event.actor_type === "developer_ai")) return null;
    if (blocked.event_type === "blocked") {
      const failure = history.slice(history.indexOf(claim) + 1, blockIndex).find((event) =>
        event.event_type === "developer_claim_checkpoint_predecessor_blocked"
        && event.actor_type === "developer_ai" && event.actor_id === claim.actor_id
        && event.session_id === claim.session_id
        && event.note?.includes("CHECKPOINT_PREDECESSOR_REQUIRED")
        && event.note?.includes(claim.event_id));
      if (claim.event_type !== "claim" || !failure) return null;
    }
    if (blocked.event_type === "developer_r3_runner_timeout_blocked"
      && (blocked.metadata?.failureStage !== "D07_TEST_3"
        || blocked.metadata?.failureCode !== "TEST_RUNNER_30S_SPAWNSYNC_ETIMEDOUT"
        || blocked.metadata?.blockerCategory !== "test_runner"
        || !GIT_SHA.test(blocked.metadata?.candidateSha || ""))) return null;
    if (blocked.event_type === "developer_d07_checkpoint_unauthorized_dependency_block"
      && (blocked.metadata?.reasonCode !== "CHECKPOINT_STEP_ORDER"
        || blocked.metadata?.blockedByWriteScope !== "server/task-step-checkpoint.mjs"
        || blocked.metadata?.candidateWipPreserved !== true
        || !GIT_SHA.test(blocked.metadata?.candidateSha || ""))) return null;
    for (const fixId of d01ReentryBlocked
      ? ["WTB-P0-REWORK-REQUEUE-D01-STEP-ORDER-20261107-T1"]
      : VERIFIED_DEV_BLOCK_FIXES[blocked.event_type]) {
      const fix = tasks.find((item) => item.id === fixId && item.status === "已完成");
      if (!fix) return null;
      const releases = await store.events.listTaskEvents(projectId, fixId, { all: true });
      const delivered = releases.findLast((event) =>
        event.event_type === "delivery_complete" && event.actor_type === "controller_ai"
        && event.actor_id && event.session_id);
      const proof = delivered?.metadata || {};
      const qa = releases.find((event) =>
        event.event_id === proof.independentPassEventId && event.event_type === "test_result"
        && event.actor_type === "test_ai" && event.actor_id && event.session_id
        && event.metadata?.atomicLifecycle === true && event.metadata?.testResult === "pass");
      if (!qa || releases.indexOf(qa) >= releases.indexOf(delivered)
        || proof.deliveryVerified !== true || proof.postMergeRegressionResult !== "PASS"
        || !GIT_SHA.test(proof.mergeCommitSha || "")
        || !GIT_SHA.test(proof.candidateCommitSha || "")
        || proof.candidateCommitSha !== qa.metadata.commitSha
        || proof.remoteMainSha !== proof.mergeCommitSha) return null;
      try {
        if ((await runGit(context.rootRealPath,
          ["merge-base", "--is-ancestor", proof.mergeCommitSha, "HEAD"])).code !== 0
          || (await runGit(context.rootRealPath,
            ["merge-base", "--is-ancestor", proof.candidateCommitSha, proof.mergeCommitSha])).code !== 0) return null;
      } catch { return null; }
    }
    const messages = await store.userMessageState(projectId, task.id, {
      actorType: "scanner", actorId: "task-scan", sessionId: "task-scan"
    });
    if (messages.requiresAcknowledgement || messages.messages?.at(-1)?.replies?.length === 0) return null;
    recoveryAuthorization = originalAuthorization || dispatch;
  }
  if (d09Blocked) {
    const blockIndex = history.indexOf(blocked);
    const claimIndex = history.findLastIndex((event, index) => index < blockIndex
      && event.event_type === "claim" && event.actor_type === "developer_ai"
      && event.old_status === "待开发" && event.new_status === "开发中"
      && event.actor_id && event.session_id);
    const claim = history[claimIndex];
    const failure = history.slice(claimIndex + 1, blockIndex).find((event) =>
      event.event_type === "developer_checkpoint_resume_blocked"
      && event.actor_type === "developer_ai"
      && event.note?.includes("CHECKPOINT_STEP_ORDER")
      && event.note?.includes("D09_MERGE_MAIN")
      && event.note?.includes(claim?.event_id));
    const dispatch = history.slice(blockIndex + 1).find((event) =>
      event.event_type === "controller_dispatch" && event.actor_type === "controller_ai"
      && event.actor_id && event.session_id);
    const originalAuthorization = originalAuthorizationFor(claim);
    const fix = tasks.find((item) =>
      item.id === "WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1");
    const fixHistory = fix?.status === "已完成"
      ? await store.events.listTaskEvents(projectId, fix.id, { all: true }) : [];
    const delivered = fixHistory.findLast((event) =>
      event.event_type === "delivery_complete" && event.actor_type === "controller_ai");
    const qaPass = fixHistory.find((event) =>
      event.event_id === delivered?.metadata?.independentPassEventId
      && event.event_type === "test_result" && event.actor_type === "test_ai"
      && event.metadata?.atomicLifecycle === true && event.metadata?.testResult === "pass");
    const release = delivered?.metadata || {};
    if (blocked.old_status !== "开发中" || blocked.actor_type !== "developer_ai"
      || !claim || !failure || failure.actor_id !== blocked.actor_id
      || failure.session_id !== blocked.session_id || (!originalAuthorization && !dispatch)
      || history.slice(blockIndex + 1).some((event) =>
        event.event_type === "claim" && event.actor_type === "developer_ai")
      || !qaPass || !delivered.actor_id || !delivered.session_id
      || release.deliveryVerified !== true || release.postMergeRegressionResult !== "PASS"
      || release.candidateCommitSha !== qaPass.metadata.commitSha
      || !/^[a-f0-9]{40}$/i.test(release.mergeCommitSha || "")
      || release.remoteMainSha !== release.mergeCommitSha
      || (!originalAuthorization && Date.parse(dispatch.timestamp) <= Date.parse(delivered.timestamp))) return null;
    try {
      if ((await runGit(context.rootRealPath,
        ["merge-base", "--is-ancestor", release.mergeCommitSha, "HEAD"])).code !== 0) return null;
    } catch { return null; }
    const messages = await store.userMessageState(projectId, task.id, {
      actorType: "scanner", actorId: "task-scan", sessionId: "task-scan"
    });
    if (messages.requiresAcknowledgement || messages.messages?.at(-1)?.replies?.length === 0) return null;
    recoveryAuthorization = originalAuthorization || dispatch;
  }
  if (d01Blocked) {
    const blockIndex = history.indexOf(blocked);
    const oldClaimIndex = history.findLastIndex((event, index) => index < blockIndex
      && event.event_type === "claim" && event.actor_type === "developer_ai");
    const oldClaim = history[oldClaimIndex];
    const newDispatch = history.slice(blockIndex + 1).find((event) =>
      event.event_type === "controller_dispatch" && event.actor_type === "controller_ai"
      && Boolean(event.actor_id) && Boolean(event.session_id));
    const originalAuthorization = originalAuthorizationFor(oldClaim);
    if (blocked.old_status !== "开发中" || blocked.actor_type !== "developer_ai"
      || !blocked.session_id || !oldClaim || oldClaim.new_status !== "开发中"
      || oldClaim.actor_id !== blocked.actor_id || oldClaim.session_id !== blocked.session_id
      || (!originalAuthorization && !newDispatch) || history.slice(oldClaimIndex + 1, blockIndex).some((event) =>
        event.event_type === "controller_dispatch" && event.actor_type === "controller_ai")
      || history.slice(blockIndex + 1).some((event) =>
        event.event_type === "claim" && event.actor_type === "developer_ai")) return null;
    const messages = await store.userMessageState(projectId, task.id, {
      actorType: "scanner", actorId: "task-scan", sessionId: "task-scan"
    });
    if (messages.messages?.at(-1)?.replies?.length === 0) return null;
    recoveryAuthorization = originalAuthorization || newDispatch;
  }
  if (developerPause) {
    if (blocked.actor_type !== "developer_ai" || blocked.old_status !== "开发中") return null;
    const claim = history.slice(0, history.indexOf(blocked)).findLast((event) =>
      ["claim", "takeover"].includes(event.event_type) && event.actor_type === "developer_ai" &&
      event.actor_id === blocked.actor_id && event.session_id === blocked.session_id &&
      event.new_status === "开发中");
    if (!claim || !blocked.session_id) return null;
  } else if (!d01Blocked && !d09Blocked && !verifiedDevBlock && !d01ReentryBlocked && !d08PendingBlocked
    && (blocked?.event_type !== "temporary_block" || blocked.actor_type !== "system")) return null;
  const target = d08PendingBlocked ? "待开发" : blocked.old_status === "待准备"
    ? "待开发" : TEMPORARY_RESTORE.get(blocked.old_status);
  const conditions = d01Blocked || d09Blocked || verifiedDevBlock || d01ReentryBlocked || d08PendingBlocked ? [] : developerPause
    ? [{ kind: "dependency_completed", taskId: blocked.metadata?.requiredTask }]
    : blocked.metadata?.conditions;
  if (!target || !Array.isArray(conditions) || (!d01Blocked && !d09Blocked && !verifiedDevBlock && !d01ReentryBlocked && !d08PendingBlocked && !conditions.length)
    || conditions.length > 8) return null;
  if ((await store.stopState(projectId, task.id)).stopRequested) return null;
  const lastFailure = history.findLastIndex((event) =>
    event.event_type === "test_result" && event.metadata?.testResult === "fail");
  const lastHandoff = history.findLastIndex((event) =>
    event.event_type === "handoff" && event.actor_type === "developer_ai");
  if (lastFailure > lastHandoff && !d08PendingBlocked) return null;
  if (["待独测", "待复测"].includes(target)) {
    const handoff = history[lastHandoff];
    if (!handoff || handoff.new_status !== target || handoff.metadata?.atomicLifecycle !== true ||
      history.slice(lastHandoff + 1).some((event) =>
        event.event_type === "code_change" || event.metadata?.invalidatesTestEvidence === true)) return null;
  }
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const dependencies = String(task.readDependencies || "").split(/[；;]/)
    .map((item) => item.trim().replaceAll("`", ""));
  for (const condition of conditions) {
    if (!condition || typeof condition !== "object") return null;
    if (condition.kind === "dependency_completed") {
      if (typeof condition.taskId !== "string" || condition.taskId === task.id ||
        (!developerPause && !dependencies.includes(condition.taskId + "完成")) ||
        byId.get(condition.taskId)?.status !== "已完成") return null;
    } else if (condition.kind === "owner_released") {
      const other = byId.get(condition.taskId);
      if (!other || other.id === task.id || !condition.sessionId || other.assignee || other.sessionId) return null;
      const events = await store.events.listTaskEvents(projectId, other.id, { all: true });
      const claim = events.findLastIndex((event) =>
        event.event_type === "claim" && event.session_id === condition.sessionId);
      if (claim < 0 || !events.slice(claim + 1).some((event) =>
        ["handoff", "release", "test_result"].includes(event.event_type) &&
        event.session_id === condition.sessionId)) return null;
    } else if (condition.kind === "required_file_exists") {
      if (typeof condition.path !== "string" || !dependencies.includes(condition.path)) return null;
      try {
        const found = await resolveProjectPath(context.rootRealPath, condition.path, {
          mustExist: true, rejectReparse: true
        });
        if (!(await fs.stat(found)).isFile()) return null;
      } catch { return null; }
    } else return null;
  }
  if (["待准备", "待开发"].includes(target)) {
    if (!String(task.writeTargets || "").trim() ||
      hardDependencyBlockers(task, byId).length) return null;
    try {
      await assertDeveloperClaimExclusive(store, projectId, context, { tasks }, task,
        "task-scan", "auto-unblock", false, !(d01Blocked || d09Blocked || verifiedDevBlock || d01ReentryBlocked || d08PendingBlocked));
    } catch (error) {
      if (["CLAIM_WRITE_CONFLICT", "CLAIM_DEVELOPER_BUSY"].includes(error.code)) return null;
      throw error;
    }
  }
  return { target, blockedEventId: blocked.event_id,
    authorizationEventId: recoveryAuthorization?.event_id || null };
}

function autoUnblockOperationId(projectId, taskId, blockedEventId) {
  return "auto_unblock." + crypto.createHash("sha256")
    .update(projectId + "|" + taskId + "|" + blockedEventId).digest("hex");
}

async function runGit(root, args) {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true
    });
    return { code: 0, stdout: result.stdout || "", stderr: result.stderr || "" };
  } catch (error) {
    if (typeof error.code === "number") return { code: error.code, stdout: error.stdout || "", stderr: error.stderr || "" };
    throw new TaskboardError("无法执行Git交付核验，请确认项目仓库和Git可用", {
      code: "DELIVERY_GIT_UNAVAILABLE", status: 409
    });
  }
}
async function gitOutput(root, args, errorCode) {
  const result = await runGit(root, args);
  if (result.code !== 0) throw new TaskboardError("Git交付核验失败：" + errorCode, {
    code: errorCode, status: 409, details: { gitCommand: args[0] }
  });
  return String(result.stdout || "").trim();
}
async function gitIsAncestor(root, ancestor, descendant) {
  const result = await runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new TaskboardError("Git无法验证候选提交与main的关系", { code: "DELIVERY_GIT_ANCESTRY_FAILED", status: 409 });
}
async function deliveryGitRoot(context, metadata) {
  const requested = metadata?.deliveryWorktreePath;
  if (requested === undefined || requested === null || requested === "") return context.rootRealPath;
  const invalid = () => new TaskboardError("交付工作区必须是已登记的同仓库Git worktree", {
    code: "DELIVERY_WORKTREE_INVALID", status: 409
  });
  if (typeof requested !== "string" || !path.isAbsolute(requested)) throw invalid();
  let candidate;
  try {
    candidate = await fs.realpath(requested);
    if (!(await fs.stat(candidate)).isDirectory()) throw invalid();
  } catch { throw invalid(); }
  const normalize = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const listed = await gitOutput(context.rootRealPath, ["worktree", "list", "--porcelain"], "DELIVERY_WORKTREE_INVALID");
  const registered = listed.split(/\r?\n/).filter(line => line.startsWith("worktree "))
    .some(line => normalize(line.slice(9)) === normalize(candidate));
  if (!registered) throw invalid();
  const common = await gitOutput(context.rootRealPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "DELIVERY_WORKTREE_INVALID");
  const candidateCommon = await gitOutput(candidate, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "DELIVERY_WORKTREE_INVALID");
  if (normalize(common) !== normalize(candidateCommon)) throw invalid();
  return candidate;
}
// Fail closed when an independent PASS cannot be matched to a real remote Git
// candidate. A branch may be deleted after it was merged; in that case only an
// existing local commit that is an ancestor of remote HEAD can be accepted.
export async function verifiedRemoteTakeoverCandidate(root, metadata = {}) {
  const sha = String(metadata.commitSha || "").toLowerCase();
  const branch = String(metadata.headBranch || "").trim();
  if (!GIT_SHA.test(sha) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(branch)
    || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) return false;
  try {
    const checkRef = await runGit(root, ["check-ref-format", "--branch", branch]);
    if (checkRef.code !== 0) return false;
    const remoteBranch = await runGit(root, ["ls-remote", "origin", "refs/heads/" + branch]);
    if (remoteBranch.code !== 0) return false;
    const remoteLine = String(remoteBranch.stdout || "").trim();
    if (remoteLine) {
      const actual = remoteLine.split(/\s+/)[0].toLowerCase();
      return GIT_SHA.test(actual) && actual === sha;
    }
    const commit = await runGit(root, ["cat-file", "-t", sha]);
    if (commit.code !== 0 || String(commit.stdout).trim() !== "commit") return false;
    const defaultRemote = await runGit(root, ["ls-remote", "--symref", "origin", "HEAD"]);
    if (defaultRemote.code !== 0) return false;
    const defaultBranch = String(defaultRemote.stdout || "").match(/^ref:\s+refs\/heads\/([A-Za-z0-9._/-]+)\s+HEAD$/m)?.[1];
    if (!defaultBranch) return false;
    const mainRef = await runGit(root, ["ls-remote", "origin", "refs/heads/" + defaultBranch]);
    const actualMainSha = String(mainRef.stdout || "").trim().split(/\s+/)[0].toLowerCase();
    if (mainRef.code !== 0 || !GIT_SHA.test(actualMainSha)) return false;
    return await gitIsAncestor(root, sha, actualMainSha);
  } catch {
    return false;
  }
}

// A delivery takeover only transfers execution authority; it does not create
// or replace independent QA evidence. Match it to an explicit, consumed user
// authorization and preserve the original developer handoff in history.
export function deliveryTakeoverAuthority(events, evidence) {
  const current = [...events].reverse().find((event) =>
    event.event_type === "takeover" && event.metadata?.deliveryTakeover === true);
  if (!current) return null;
  const meta = current.metadata || {};
  const at = events.indexOf(current);
  const authorization = events.slice(0, at).find((event) =>
    event.event_type === "takeover_allowed" &&
    event.operation_id === meta.authorizationOperationId);
  const authorizationMeta = authorization?.metadata || {};
  if (!authorization || !["browser_user_session", "chat_user_instruction_cooperative"].includes(authorizationMeta.authorizationSource)
    || authorizationMeta.authorizedFromStatus !== "待交付"
    || !meta.generation || !Number.isSafeInteger(meta.generation)
    || !meta.newDeveloperActorId || !meta.newDeveloperSessionId
    || meta.newDeveloperActorId === meta.originalDeveloperActorId
    || meta.newDeveloperSessionId === meta.originalDeveloperSessionId
    || current.actor_id !== meta.newDeveloperActorId || current.session_id !== meta.newDeveloperSessionId
    || events.slice(events.indexOf(authorization) + 1, at).some((event) =>
      event.event_type === "takeover_revoked")) return null;
  if (evidence?.valid) {
    const pass = evidence.latestResult;
    if (meta.requiresIndependentRetest) {
      if (events.indexOf(pass) <= at) return null;
    } else if (meta.independentPassEventId !== evidence.eventId
      || meta.candidateSha !== pass?.metadata?.commitSha
      || meta.candidateBranch !== pass?.metadata?.headBranch
      || meta.independentReportPath !== pass?.metadata?.reportPath
      || meta.originalDeveloperActorId !== evidence.developerActorId
      || meta.originalDeveloperSessionId !== evidence.developerSessionId) return null;
  }
  return { event: current, metadata: meta, authorization };
}

async function verifyDeliveryMergeConflictRework(store, projectId, context, task, events, patch, {
  actorType, actorId, sessionId, metadata
}) {
  if (task.status !== "交付中" || patch?.status !== "待开发") {
    throw new TaskboardError("只能由交付中因真实合并冲突退原开发", {
      code: "DELIVERY_REWORK_STAGE_REQUIRED", status: 409
    });
  }
  if (actorType !== "controller_ai" || !actorId || !sessionId ||
    sessionId !== task.sessionId || !task.assignee ||
    (await store.stopState(projectId, task.id)).stopRequested) {
    throw new TaskboardError("必须由当前正式总控Session操作且无STOP", {
      code: "DELIVERY_REWORK_CONTROLLER_REQUIRED", status: 409
    });
  }
  const independent = deliveryEvidence(events, context.workflow);
  if (!independent.valid || !independent.developerActorId || !independent.developerSessionId) {
    throw new TaskboardError("缺少有效固定SHA的独立测试PASS", {
      code: "DELIVERY_REWORK_INDEPENDENT_PASS_REQUIRED", status: 409
    });
  }
  const latest = independent.latestResult;
  const latestIndex = events.indexOf(latest);
  const claimIndex = events.findLastIndex((event, index) => index > latestIndex &&
    event.event_type === "claim" && event.new_status === "交付中" &&
    event.actor_type === "controller_ai" && event.actor_id === actorId &&
    event.session_id === sessionId);
  const failure = events.findLast((event, index) => index > claimIndex && claimIndex >= 0 &&
    event.event_type === "delivery_attempt_failed" &&
    event.actor_type === "controller_ai" && event.actor_id === actorId &&
    event.session_id === sessionId && event.metadata?.failureStage === "merge" &&
    event.metadata?.candidateSha === latest.metadata.commitSha);
  if (!failure) throw new TaskboardError("必须先由正式交付总控登记真实merge失败", {
    code: "DELIVERY_REWORK_FAILURE_EVIDENCE_REQUIRED", status: 409
  });
  const candidateSha = String(latest.metadata.commitSha).toLowerCase();
  const mainSha = String(metadata?.mainSha || "").toLowerCase();
  if (!GIT_SHA.test(mainSha) || !GIT_SHA.test(String(metadata?.candidateSha || "")) ||
    String(metadata.candidateSha).toLowerCase() !== candidateSha ||
    !(await verifiedRemoteTakeoverCandidate(context.rootRealPath, latest.metadata))) {
    throw new TaskboardError("合并冲突的候选SHA/远端证据不可信", {
      code: "DELIVERY_REWORK_CANDIDATE_MISMATCH", status: 409
    });
  }
  const mainRef = await runGit(context.rootRealPath, ["ls-remote", "origin", "refs/heads/main"]);
  if (mainRef.code !== 0 ||
    String(mainRef.stdout).trim().split(/\s+/)[0]?.toLowerCase() !== mainSha) {
    throw new TaskboardError("远端main已变化或提供了过期SHA", {
      code: "DELIVERY_REWORK_MAIN_STALE", status: 409
    });
  }
  const merge = await runGit(context.rootRealPath, ["merge-tree", "--write-tree", mainSha, candidateSha]);
  if (merge.code !== 1 || !/^CONFLICT \([^)]+\):/m.test(merge.stdout)) {
    throw new TaskboardError("未取得真实Git内容冲突，不能退回开发", {
      code: "DELIVERY_REWORK_CONFLICT_NOT_VERIFIED", status: 409
    });
  }
  const conflictFiles = [...merge.stdout.matchAll(/^CONFLICT \([^)]+\):.*? in ([^\r\n]+)/gm)]
    .map((match) => match[1].slice(0, 240)).slice(0, 24);
  return {
    ...(metadata || {}), mergeConflictVerified: true, invalidatesTestEvidence: true,
    requiresIndependentRetest: true, independentPassEventId: latest.event_id,
    deliveryFailureEventId: failure.event_id, candidateSha, mainSha, conflictFiles,
    originalDeveloperActorId: independent.developerActorId,
    originalDeveloperSessionId: independent.developerSessionId,
    originalControllerActorId: actorId, originalControllerSessionId: sessionId
  };
}

async function verifyDeliveryCompletion(context, task, events, patch, { actorType, actorId, sessionId, metadata }) {
  if (task.status !== "交付中" || patch?.status !== "已完成") {
    throw new TaskboardError("只有交付中的任务可以提交合并完成", { code: "DELIVERY_STAGE_REQUIRED", status: 409 });
  }
  if (actorType !== "controller_ai" || !actorId || !sessionId || sessionId !== task.sessionId) {
    throw new TaskboardError("必须由正式认领的总控AI在当前Session完成合并交付", { code: "DELIVERY_OWNER_MISMATCH", status: 409 });
  }
  const latestTest = [...events].reverse().find((event) => event.event_type === "test_result");
  const pass = latestTest?.metadata || {};
  if (!latestTest || latestTest.actor_type !== "test_ai" || pass.testResult !== "pass"
    || pass.atomicLifecycle !== true || pass.deliveryDisposition !== "required"
    || !Array.isArray(pass.deliveryActions) || !pass.deliveryActions.includes("candidate_merge")
    || !GIT_SHA.test(String(pass.commitSha || "")) || !String(pass.headBranch || "").trim()) {
    throw new TaskboardError("缺少绑定固定候选SHA的最新独立测试PASS，不能合并关闭", {
      code: "DELIVERY_INDEPENDENT_PASS_REQUIRED", status: 409
    });
  }
  const passIndex = events.indexOf(latestTest);
  const prior = events.slice(0, passIndex);
  const testerExecution = latestAuthorizedTestExecution(events, latestTest);
  const developerHandoff = [...prior].reverse().find((event) =>
    event.event_type === "handoff" && event.actor_type === "developer_ai"
    && ["开发中", "修复中"].includes(event.metadata?.completedFromStatus));
  if (!testerExecution || !developerHandoff
    || events.indexOf(developerHandoff) >= events.indexOf(testerExecution)
    || developerHandoff.actor_id === latestTest.actor_id || developerHandoff.session_id === latestTest.session_id) {
    throw new TaskboardError("独立测试必须由不同于原开发者的正式test_ai认领并完成", {
      code: "DELIVERY_TEST_INDEPENDENCE_INVALID", status: 409
    });
  }
  const invalidation = events.slice(passIndex + 1).find((event) =>
    event.event_type === "code_change" || event.event_type === "test_result" || event.metadata?.invalidatesTestEvidence === true);
  if (invalidation) throw new TaskboardError("独立PASS之后又发生代码修改或测试结果变化，必须重新独测", {
    code: "DELIVERY_PASS_INVALIDATED", status: 409
  });
  const deliveryClaim = [...events].reverse().find((event) =>
    event.event_type === "claim" && event.new_status === "交付中" && event.actor_type === "controller_ai");
  if (!deliveryClaim || deliveryClaim.actor_id !== actorId || deliveryClaim.session_id !== sessionId) {
    throw new TaskboardError("当前执行身份不是总控AI的正式交付认领", {
      code: "DELIVERY_CLAIM_MISMATCH", status: 409
    });
  }
  const root = await deliveryGitRoot(context, metadata);
  const symref = await gitOutput(root, ["ls-remote", "--symref", "origin", "HEAD"], "DELIVERY_REMOTE_UNAVAILABLE");
  const branchMatch = symref.match(/^ref:\s+refs\/heads\/([A-Za-z0-9][A-Za-z0-9._/-]{0,190})\s+HEAD$/m);
  if (!branchMatch || branchMatch[1].includes("..") || branchMatch[1].includes("//")) {
    throw new TaskboardError("无法识别origin默认分支，拒绝猜测main分支", { code: "DELIVERY_REMOTE_DEFAULT_BRANCH_UNAVAILABLE", status: 409 });
  }
  const mainBranch = branchMatch[1];
  const localBranch = await gitOutput(root, ["rev-parse", "--abbrev-ref", "HEAD"], "DELIVERY_LOCAL_BRANCH_UNAVAILABLE");
  if (localBranch !== mainBranch && !(metadata?.deliveryWorktreePath && localBranch === "HEAD")) throw new TaskboardError("请先切换到origin默认分支，再执行交付闭环", {
    code: "DELIVERY_NOT_ON_MAIN", status: 409, details: { expectedBranch: mainBranch, currentBranch: localBranch }
  });
  const mergeCommitSha = (await gitOutput(root, ["rev-parse", "HEAD"], "DELIVERY_LOCAL_HEAD_UNAVAILABLE")).toLowerCase();
  const remoteLine = await gitOutput(root, ["ls-remote", "origin", "refs/heads/" + mainBranch], "DELIVERY_REMOTE_MAIN_UNAVAILABLE");
  const remoteMainSha = String(remoteLine.split(/\s+/)[0] || "").toLowerCase();
  if (!GIT_SHA.test(remoteMainSha)) throw new TaskboardError("无法读取远端默认分支SHA", { code: "DELIVERY_REMOTE_MAIN_UNAVAILABLE", status: 409 });
  if (mergeCommitSha !== remoteMainSha) throw new TaskboardError("本地main与远端main版本不一致，先同步远端再完成交付", {
    code: "DELIVERY_REMOTE_SHA_MISMATCH", status: 409, details: { localMainSha: mergeCommitSha, remoteMainSha }
  });
  const postMergeReportPath = String(metadata?.postMergeReportPath || "").trim();
  if (!postMergeReportPath) throw new TaskboardError("必须提供合并后回归PASS报告路径", {
    code: "DELIVERY_POST_MERGE_REPORT_REQUIRED", status: 400
  });
  if (metadata?.postMergeRegressionResult !== "PASS") throw new TaskboardError("合并后回归结果必须为PASS", {
    code: "DELIVERY_POST_MERGE_REGRESSION_REQUIRED", status: 409
  });
  const reportFile = await resolveProjectPath(root, postMergeReportPath, { mustExist: true, rejectReparse: true });
  const reportStat = await fs.stat(reportFile);
  if (!reportStat.isFile() || reportStat.size > 2 * 1024 * 1024) throw new TaskboardError("合并后回归报告无效或超过2MB", {
    code: "DELIVERY_POST_MERGE_REPORT_INVALID", status: 422
  });
  const statusText = await gitOutput(root, ["status", "--porcelain", "-z", "--untracked-files=all"], "DELIVERY_WORKTREE_STATUS_UNAVAILABLE");
  const normalizeGitPath = (value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const dirtyEntries = statusText.split("\0").filter(Boolean);
  const unrelatedChanges = dirtyEntries.filter((entry) =>
    !(entry.slice(0, 2) === "??" && normalizeGitPath(entry.slice(3)) === normalizeGitPath(postMergeReportPath)));
  if (unrelatedChanges.length) throw new TaskboardError("合并后回归必须在干净工作区执行；除本次回归报告外仍有未提交修改", {
    code: "DELIVERY_WORKTREE_DIRTY", status: 409, details: { changedCount: unrelatedChanges.length }
  });
  const trackedReport = await runGit(root, ["ls-files", "--error-unmatch", "--", postMergeReportPath]);
  if (trackedReport.code === 0) throw new TaskboardError("合并后回归报告必须是本次生成的独立证据，不能复用已提交旧报告", {
    code: "DELIVERY_REPORT_TRACKED", status: 409
  });
  if (trackedReport.code !== 1) throw new TaskboardError("无法核验合并后回归报告是否为新报告", {
    code: "DELIVERY_REPORT_TRACKING_UNAVAILABLE", status: 409
  });
  const candidateCommitSha = String(pass.commitSha).toLowerCase();
  if (!(await gitIsAncestor(root, candidateCommitSha, mergeCommitSha))) {
    throw new TaskboardError("独测通过的候选提交尚未进入远端main，禁止关闭任务", {
      code: "DELIVERY_CANDIDATE_NOT_MERGED", status: 409, details: { candidateCommitSha, remoteMainSha }
    });
  }
  const reportText = await fs.readFile(reportFile, "utf8");
  if (!/^(?:结论|结果|result)\s*[:：]\s*(?:PASS|通过)\s*$/im.test(reportText)
    || !reportText.toLowerCase().includes(candidateCommitSha)
    || !reportText.toLowerCase().includes(mergeCommitSha)) {
    throw new TaskboardError("回归报告必须明确写明PASS、候选SHA和远端main SHA", {
      code: "DELIVERY_POST_MERGE_REPORT_INVALID", status: 409
    });
  }
  const postMergeReportSha256 = crypto.createHash("sha256").update(reportText).digest("hex");
  return {
    ...(metadata || {}), deliveryVerified: true, candidateCommitSha,
    candidateBranch: String(pass.headBranch), independentPassEventId: latestTest.event_id,
    mainBranch, mergeCommitSha, remoteMainSha, postMergeReportPath,
    postMergeReportSha256, postMergeRegressionResult: "PASS"
  };
}

function isUserMessage(event) {
  return Boolean(event && event.actor_type === "user" && USER_MESSAGE_TYPES.has(event.event_type) && String(event.note || "").trim());
}
function activeUserAction(events, task) {
  let required = null;
  for (const event of events) {
    if (event.event_type === "user_action_required") required = event;
    if (event.event_type === "user_action_cleared") required = null;
  }
  if (required?.note) return cleanHumanText(required.note);
  const fallback = {
    "待确认": "需要你确认需求、范围或业务规则；确认后任务才能继续。",
    "待用户验收": "系统技术验收已完成；只需检查UI视觉/交互与业务逻辑，然后通过或打回。",
    "HOLD": "当前无需操作；如果你希望继续，请在看板中恢复任务并说明恢复条件。",
    "阻断": "请查看任务详情中的阻断原因；若涉及账号、权限、业务决策或外部条件，请按阻断说明提供对应条件。"
  };
  return fallback[task.status] || "当前无需你操作；如后续需要账号、权限、业务决策或页面验收，执行AI必须在这里明确写出具体事项。";
}
function taskVisualState(task, events, statuses) {
  let owner = null, issue = null, suspected = false;
  for (const e of events) {
    if (["claim", "takeover"].includes(e.event_type) && e.actor_type === "developer_ai"
      && e.actor_id && e.session_id && ["开发中", "修复中"].includes(e.new_status)) {
      owner = { actor: e.actor_id, session: e.session_id }; issue = null;
    } else if (e.event_type === "developer_issue_reported" && owner
      && e.actor_type === "developer_ai" && e.actor_id === owner.actor
      && e.session_id === owner.session && e.metadata?.paused === true
      && typeof e.metadata.failureCode === "string" && e.metadata.failureCode.trim()
      && typeof e.metadata.nextAction === "string" && e.metadata.nextAction.trim()
      && Array.isArray(e.metadata.relatedTaskIds) && e.metadata.relatedTaskIds.length) {
      issue = { eventId: e.event_id, timestamp: e.timestamp,
        failureCode: cleanHumanText(e.metadata.failureCode).slice(0, 120),
        nextAction: cleanHumanText(e.metadata.nextAction).slice(0, 300),
        relatedTaskIds: e.metadata.relatedTaskIds };
    } else if (["developer_issue_resolved", "release", "resume", "auto_unblock",
      "handoff", "test_result", "complete", "task_completed"].includes(e.event_type)
      || (e.new_status && e.old_status !== e.new_status
        && !["开发中", "修复中", "阻断"].includes(e.new_status))) {
      issue = null;
      if (["release", "handoff"].includes(e.event_type)) owner = null;
    }
    if (e.event_type === "suspected_disconnect") suspected = true;
    if (["takeover", "claim", "resume", "takeover_revoked"].includes(e.event_type)) suspected = false;
  }
  const seen = new Set(), ids = [];
  const add = id => {
    if (typeof id !== "string" || !/^[A-Za-z][A-Za-z0-9-]+-T[0-9]+$/.test(id)
      || id === task.id || seen.has(id)) return;
    seen.add(id); ids.push(id);
  };
  for (const part of String(task.readDependencies || "").split(/[;；]/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]+-T[0-9]+)完成$/.exec(part.trim());
    if (match) add(match[1]);
  }
  if (issue) issue.relatedTaskIds.forEach(add);
  if (["阻断", "HOLD"].includes(task.status)) {
    const last = [...events].reverse().find(e => e.event_type === "controller_blocker_resolution_plan");
    if (Array.isArray(last?.metadata?.rootCauseTaskIds)) last.metadata.rootCauseTaskIds.forEach(add);
  }
  const paused = Boolean(issue && ["开发中", "修复中", "阻断"].includes(task.status));
  const running = ["开发中", "修复中", "独测中", "复测中", "交付中"].includes(task.status)
    && Boolean(task.assignee && task.sessionId)
    && (!["开发中", "修复中"].includes(task.status) || owner?.session === task.sessionId);
  return {
    cardStage: task.status === "已取消" ? "cancelled" : task.status === "已完成" ? "completed"
      : paused ? "paused_by_issue" : running ? "running" : "not_started",
    developmentIssue: paused ? {eventId: issue.eventId, timestamp: issue.timestamp,
      failureCode: issue.failureCode, nextAction: issue.nextAction} : null,
    suspectedDisconnect: suspected && running && !paused,
    relatedTasks: ids.map(id => ({id, status: statuses.get(id) || null}))
  };
}

function presentationForTask(task, events = [], project = {}, statuses = new Map()) {
  const messages = events.filter(isUserMessage);
  const decisions = events.filter((event) => event.actor_type === "user" && USER_DECISION_TYPES.has(event.event_type));
  const latest = messages.at(-1) || null;
  const latestDecision = decisions.at(-1) || null;
  const repliesByMessage = new Map();
  let latestMessageId = null;
  for (const event of events) {
    if (isUserMessage(event)) latestMessageId = event.event_id;
    if (event.event_type !== "user_message_reply") continue;
    const target = event.metadata?.replyToEventId || latestMessageId;
    if (!target) continue;
    if (!repliesByMessage.has(target)) repliesByMessage.set(target, []);
    repliesByMessage.get(target).push({
      eventId: event.event_id,
      timestamp: event.timestamp,
      actorType: event.actor_type,
      actorId: event.actor_id,
      note: cleanHumanText(event.note)
    });
  }
  const latestReplies = latest ? (repliesByMessage.get(latest.event_id) || []) : [];
  return {
    title: readableTitle(task),
    ...taskVisualState(task, events, statuses),
    responsibility: cleanHumanText(task.boundary) || "尚未填写任务职责说明，执行AI需要补充。",
    currentProgress: currentProgressText(task, events),
    userAssistance: activeUserAction(events, task),
    latestUserMessage: latest ? {
      eventId: latest.event_id,
      type: latest.event_type,
      timestamp: latest.timestamp,
      note: cleanHumanText(latest.note),
      replied: latestReplies.length > 0,
      replyCount: latestReplies.length,
      latestReply: latestReplies.at(-1) || null
    } : null,
    userMessageCount: messages.length,
    latestUserDecision: latestDecision ? {
      eventId: latestDecision.event_id,
      type: latestDecision.event_type,
      timestamp: latestDecision.timestamp,
      note: cleanHumanText(latestDecision.note),
      oldStatus: latestDecision.old_status,
      newStatus: latestDecision.new_status
    } : null,
    plans: planEntries(task),
    mainPlan: planEntries(task)[0] || null,
    traceability: cleanHumanText(task.traceability) || "—",
    documents: documentEntries(task, project),
    relatedArtifacts: cleanHumanText(task.targets) || "—"
  };
}
function messageScope({ actorType = "developer_ai", actorId = "taskctl", sessionId = "" } = {}) {
  return [String(actorType || "developer_ai"), String(actorId || "taskctl"), String(sessionId || "")].join("|");
}

export class TaskStore {
  constructor(rootDir, { faultAfter = null } = {}) {
    this.rootDir = rootDir;
    this.projects = new ProjectRegistry(rootDir);
    this.events = new EventStore(rootDir);
    this.transactions = new TransactionStore(rootDir);
    this.scanStore = new ScanStore(rootDir);
    this.faultAfter = faultAfter;
  }

  async init() {
    await this.projects.load();
    return this;
  }

  maybeCrash(phase) {
    if (this.faultAfter === phase) injectedCrash(phase);
  }

  async rearmScanner(reason, metadata = {}) {
    try { await this.scanStore.requestRearm(reason, metadata); }
    catch (error) {
      await this.scanStore.appendEvent({ type: "task_rearm_failed", reason, metadata, error: String(error?.message || error).slice(0, 500) }).catch(logError => console.error("task rearm log failed:", logError?.message || logError));
    }
  }

  async snapshot(projectId) {
    const context = await this.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    for (const task of parsed.tasks) {
      context.workflow.validatePriority(task.priority);
      context.workflow.validateTrack(task.track);
      context.workflow.validateStatus(task.status);
    }
    const eventMap = await this.events.listProjectTaskEvents(projectId, parsed.tasks.map((task) => task.id), { all: true });
    const statuses = new Map(parsed.tasks.map((task) => [task.id, task.status]));
    const tasks = [...parsed.tasks].sort((a, b) =>
      context.workflow.sortKey(a) - context.workflow.sortKey(b) || a.id.localeCompare(b.id)
    ).map((task) => {
      const events = eventMap.get(task.id) || [];
      const acceptanceScope = context.workflow.resolveAcceptanceScope(task, events);
      return {
        ...task,
        acceptanceScope,
        presentation: { ...presentationForTask(task, events, context.project, statuses), acceptanceScope }
      };
    });
    return {
      projectId,
      projectName: context.project.name,
      workflowProfile: context.project.workflowProfile,
      registryFormatVersion: context.project.registryFormatVersion,
      registryRevision: parsed.registryRevision,
      fileSha256: parsed.fileSha256,
      sourceHealth: { status: "healthy", writable: true },
      workflow: {
        id: context.workflow.id,
        priorities: context.workflow.priorities,
        tracks: context.workflow.tracks,
        statuses: context.workflow.statuses,
        roles: context.workflow.roles,
        boardColumns: context.workflow.boardColumns
      },
      tasks,
    };
  }

  async autoRestoreTemporaryBlocks(projectId) {
    const context = await this.projects.context(projectId);
    const before = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const history = await this.events.listProjectTaskEvents(projectId, before.tasks.map((task) => task.id), { all: true });
    for (const task of before.tasks) {
      const blocked = [...(history.get(task.id) || [])].reverse().find((event) =>
        event.old_status !== "阻断" && event.new_status === "阻断");
      if (!["temporary_block", "developer_paused_for_independent_full_suite_gate",
        "developer_d01_missing_controller_dispatch_block",
        "developer_step_cursor_blocked"].includes(blocked?.event_type)) continue;
      const operationId = autoUnblockOperationId(projectId, task.id, blocked.event_id);
      const transaction = await this.transactions.read(operationId);
      if (!transaction || ["committed", "aborted_no_effect"].includes(transaction.state)) continue;
      await withProjectLock(this.rootDir, projectId, operationId, async () => {
        const pending = await this.transactions.read(operationId);
        if (pending && !["committed", "aborted_no_effect"].includes(pending.state)) {
          const recovered = await this.recoverTransaction(pending);
          if (recovered.action === "inconsistent") throw new TaskboardError("自动解阻事务不一致", {
            code: "AUTO_UNBLOCK_RECOVERY_INCONSISTENT", status: 409
          });
        }
      });
    }
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const restored = [];
    for (const task of parsed.tasks) {
      const eligible = await eligibleTemporaryUnblock(this, projectId, task, parsed.tasks, context);
      if (!eligible) continue;
      const { snapshot } = await this.getTask(projectId, task.id);
      const operationId = autoUnblockOperationId(projectId, task.id, eligible.blockedEventId);
      try {
        const result = await this.updateTask(projectId, task.id, {
          status: eligible.target, assignee: "", sessionId: "", sessionWindowName: ""
        }, {
          operationId, expectedRevision: snapshot.registryRevision,
          eventType: "auto_unblock", actorType: "system", actorId: "task-scan",
          note: "可信临时阻断条件已重新验证并自动恢复原合法阶段",
          metadata: { blockedEventId: eligible.blockedEventId, restoreStatus: eligible.target,
            authorizationEventId: eligible.authorizationEventId }
        });
        if (!result.idempotentReplay) restored.push(task.id);
      } catch (error) {
        if (!["REVISION_CONFLICT", "AUTO_UNBLOCK_NOT_READY", "PROJECT_LOCKED"].includes(error.code)) throw error;
      }
    }
    return restored;
  }

  async updateTask(projectId, taskId, patch, {
    expectedRevision,
    operationId,
    eventType = "task_update",
    actorType = "system",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null,
  } = {}) {
    assertOperationId(operationId);
    if(String(eventType).startsWith("rule_read_"))throw new TaskboardError("规则票据只能通过服务端签发",{code:"RULE_READ_SERVER_ROUTE_REQUIRED",status:409});
    const userWrite = actorType === "user";
    if (!expectedRevision && !userWrite) throw new TaskboardError("写操作必须提供expectedRevision", {
      code: "EXPECTED_REVISION_REQUIRED", status: 428,
    });

    const update = () => withProjectLock(this.rootDir, projectId, operationId, async () => {
      let existing = await this.transactions.read(operationId);
      if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
      if (existing && existing.projectId !== projectId) throw new TaskboardError("operation_id已用于其它项目", {
        code: "IDEMPOTENCY_KEY_CONFLICT", status: 409,
      });
      if (existing && existing.state !== "aborted_no_effect") {
        await this.recoverTransaction(existing);
        existing = await this.transactions.read(operationId);
        if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
        if (existing?.state === "inconsistent") throw new TaskboardError("历史操作处于事务一致性异常，拒绝重试", {
          code: "TRANSACTION_INCONSISTENT", status: 409, details: { operationId },
        });
      }

      const context = await this.projects.context(projectId);
      const fileText = await fs.readFile(context.registryPath, "utf8");
      const parsed = context.adapter.parseRegistryText(fileText, context.project);
      if (!userWrite && parsed.registryRevision !== expectedRevision) {
        throw new TaskboardError("任务注册表revision已变化", {
          code: "REVISION_CONFLICT", status: 409,
          details: { expectedRevision, actualRevision: parsed.registryRevision },
        });
      }

      // 用户操作永远以当前最新注册表为基准重放，不能因为页面持有旧 revision 而被挡住。
      // AI / 自动化仍保持严格乐观锁，防止相互覆盖。
      const effectiveExpectedRevision = userWrite ? parsed.registryRevision : expectedRevision;
      const userRebased = userWrite && Boolean(expectedRevision) && expectedRevision !== parsed.registryRevision;

      const currentTask = parsed.tasks.find((item) => item.id === taskId);
      if (!currentTask) throw new TaskboardError("未知任务ID: " + taskId, { code: "TASK_NOT_FOUND", status: 404 });
      if (eventType === "auto_unblock") {
        const allowed = await eligibleTemporaryUnblock(this, projectId, currentTask, parsed.tasks, context);
        if (actorType !== "system" || !allowed || patch.status !== allowed.target ||
          metadata?.blockedEventId !== allowed.blockedEventId ||
          metadata?.authorizationEventId !== allowed.authorizationEventId) {
          throw new TaskboardError("临时阻断未满足机器核验条件", {
            code: "AUTO_UNBLOCK_NOT_READY", status: 409
          });
        }
      }
      if (eventType === "auto_preparation_ready") {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        const messages = await this.userMessageState(projectId, taskId, { actorType: "scanner", actorId: "task-scan", sessionId: "task-scan" });
        const takeover = await this.takeoverState(projectId, taskId);
        const pending = await new RequirementStore(this.rootDir).pending(projectId);
        const preparationUpdatedAt = String(metadata?.preparationUpdatedAt || "");
        const autoId = "auto_preparation_ready." + crypto.createHash("sha256")
          .update(projectId + "|" + taskId + "|" + preparationUpdatedAt).digest("hex");
        const plans = planEntries(currentTask);
        let planExists = plans.length > 0;
        if (planExists) {
          try {
            for (const plan of plans) await resolveProjectPath(context.rootRealPath, plan.path, { mustExist: true, rejectReparse: true });
          } catch { planExists = false; }
        }
        if (actorType !== "system" || actorId !== "task-scan"
          || operationId !== autoId || metadata?.preparationUpdatedAt !== currentTask.updatedAt
          || currentTask.status !== "待准备" || currentTask.plannedRole !== "开发AI"
          || !planExists || !String(currentTask.writeTargets || "").trim()
          || currentTask.assignee || currentTask.sessionId || patch.status !== "待开发"
          || hardDependencyBlockers(currentTask, new Map(parsed.tasks.map((item) => [item.id, item]))).length
          || (await this.stopState(projectId, taskId)).stopRequested
          || takeover.suspectedDisconnect || messages.requiresAcknowledgement
          || messages.messages?.at(-1)?.replies?.length === 0
          || pending.pendingCount || pending.waitingUserCount
          || history.some((event) => ["claim", "takeover"].includes(event.event_type)
            && event.actor_type === "developer_ai")) {
          throw new TaskboardError("准备任务缺少可信自动准入条件", {
            code: "AUTO_PREPARATION_NOT_READY", status: 409
          });
        }
      }
      let provisional = null;
      const dependencyBlockers = hardDependencyBlockers(currentTask,
        new Map(parsed.tasks.map((item) => [item.id, item])));
      if (eventType === "claim" && actorType === "developer_ai" && currentTask.status === "待开发") {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        const rework = history.findLast((event) => event.event_type === "delivery_merge_conflict_rework");
        if (rework && !history.slice(history.indexOf(rework) + 1).some((event) =>
          event.event_type === "claim" && event.actor_type === "developer_ai") &&
          (actorId !== rework.metadata?.originalDeveloperActorId ||
            sessionId === rework.metadata?.originalDeveloperSessionId)) {
          throw new TaskboardError("交付冲突仅原开发以新Session重新认领", {
            code: "DELIVERY_REWORK_ORIGINAL_DEVELOPER_REQUIRED", status: 409
          });
        }
      }
      if (eventType === "claim" && actorType === "developer_ai") {
        if (dependencyBlockers.length) {
          provisional = await provisionalClaimAuthorization(this, projectId, currentTask,
            new Map(parsed.tasks.map((item) => [item.id, item])), { actorId, sessionId });
          if (!provisional) throw new TaskboardError("未完成硬前置且缺少有效的独立工作区预开发授权", {
            code: "CLAIM_DEPENDENCY_NOT_COMPLETED", status: 409,
            details: { blockers: dependencyBlockers }
          });
        }
        await assertDeveloperClaimExclusive(this, projectId, context, parsed, currentTask,
          actorId, sessionId, Boolean(provisional));
        if (["待准备", "待开发", "待执行"].includes(currentTask.status) &&
          currentTask.track !== "bugfix") {
          const history = await this.events.listTaskEvents(projectId, currentTask.id, { all: true });
          const urgency = [...history].reverse().find((event) =>
            event.actor_type === "user" && event.event_type === "priority_change" &&
            typeof event.metadata?.urgent === "boolean");
          if (urgency?.metadata?.urgent !== true) {
            const bugId = await firstClaimableP0Bug(this, projectId, parsed.tasks, actorId, sessionId);
            if (bugId) throw new TaskboardError("请先领取当前可执行的P0 BUG修复任务", {
              code: "BUGFIX_PRIORITY_REQUIRED", status: 409, details: { bugTaskId: bugId, projectId }
            });
          }
        }
      }
      if (dependencyBlockers.length && (["handoff", "test_result", "delivery_complete"].includes(eventType)
        || (eventType === "claim" && actorType === "test_ai"))) {
        throw new TaskboardError("上游任务尚未完成，预开发权限不能用于独测或正式交付", {
          code: "PROVISIONAL_UPSTREAM_NOT_COMPLETE", status: 409,
          details: { blockers: dependencyBlockers }
        });
      }
      let effectiveMetadata = provisional ? {
        ...(metadata || {}), provisionalClaim: true,
        provisionalAuthorizationEventId: provisional.eventId,
        provisionalBaseSha: provisional.baseSha,
        provisionalWorktreeName: provisional.worktreeName
      } : metadata;
      let effectivePatchInput = patch;
      if (["user_accept", "user_reject"].includes(eventType)) {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        const acceptanceScope = context.workflow.resolveAcceptanceScope(currentTask, history);
        if (actorType !== "user" || currentTask.status !== "待用户验收" || acceptanceScope !== "user_ui_business") {
          throw new TaskboardError("只有处于待用户验收阶段的user_ui_business任务，才能由用户会话作出验收决定", {
            code: "USER_ACCEPTANCE_STAGE_REQUIRED", status: 409,
            details: { status: currentTask.status, acceptanceScope, actorType }
          });
        }
        effectiveMetadata = { ...(effectiveMetadata || {}), acceptanceScope };
      }
      if (eventType === "delivery_merge_conflict_rework") {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        effectiveMetadata = await verifyDeliveryMergeConflictRework(
          this, projectId, context, currentTask, history, patch,
          { actorType, actorId, sessionId, metadata });
        effectivePatchInput = {
          status: "待开发", plannedRole: "开发AI",
          assignee: "", sessionWindowName: "", sessionId: ""
        };
      }
      if (eventType === "delivery_complete") {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        const acceptanceScope = context.workflow.resolveAcceptanceScope(currentTask, history);
        effectiveMetadata = await verifyDeliveryCompletion(context, currentTask, history, patch, {
          actorType, actorId, sessionId, metadata
        });
        effectiveMetadata = { ...(effectiveMetadata || {}), acceptanceScope };
        effectivePatchInput = { ...patch, status: acceptanceScope === "user_ui_business" ? "待用户验收" : "已完成" };
      }
      const effectivePatch = context.workflow.normalizeTaskPatch(currentTask, effectivePatchInput, {
        eventType, actorType, actorId, sessionId, metadata: effectiveMetadata
      });
      await this.assertRuleReadForMutation(projectId, taskId, { actorType, actorId, sessionId }, eventType);
      if (["handoff", "test_result", "delivery_complete"].includes(eventType)) {
        const { TaskStepCheckpoint } = await import("./task-step-checkpoint.mjs");
        await new TaskStepCheckpoint(this.rootDir, { taskStore: this })
          .assertTransitionEvidence(projectId, taskId, { eventType, actorType, actorId, sessionId });
      }
      if (parsed.indexes.updatedAt >= 0 && !("updatedAt" in effectivePatch)) {
        effectivePatch.updatedAt = new Date().toISOString();
      }
      const change = context.adapter.patchRegistryText(fileText, context.project, taskId, effectivePatch, context.workflow);
      const timestamp = new Date().toISOString();
      const event = {
        operation_id: operationId,
        project_id: projectId,
        task_id: taskId,
        event_type: eventType,
        timestamp,
        actor_type: actorType,
        actor_id: actorId,
        session_window_name: sessionWindowName,
        session_id: sessionId,
        old_status: change.before.status,
        new_status: change.after.status,
        old_priority: change.before.priority,
        new_priority: change.after.priority,
        old_track: change.before.track,
        new_track: change.after.track,
        note,
        metadata: userRebased
          ? { ...(effectiveMetadata || {}), user_revision_rebased: true, stale_expected_revision: expectedRevision }
          : effectiveMetadata,
        registry_revision_before: change.beforeRevision,
        registry_revision_after: change.afterRevision,
      };
      const prepared = await this.transactions.prepare({
        operationId, projectId, taskId,
        expectedRevision: effectiveExpectedRevision,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
        beforeFileSha256: change.beforeFileSha256,
        afterFileSha256: change.afterFileSha256,
        patch: effectivePatch,
        event,
      });
      if (prepared.state === "committed") return { ...prepared.result, idempotentReplay: true };
      this.maybeCrash("prepared");

      await atomicWriteText(context.registryPath, change.text, change.beforeFileSha256);
      await this.transactions.phase(operationId, "registry_written");
      this.maybeCrash("registry_written");

      const appended = await this.events.append(projectId, event);
      await this.transactions.phase(operationId, "event_written", {
        eventId: appended.event.event_id,
        eventSegment: appended.segment || null,
      });
      this.maybeCrash("event_written");

      const result = {
        projectId, taskId, operationId,
        before: change.before,
        after: change.after,
        registryRevision: change.afterRevision,
        fileSha256: change.afterFileSha256,
        eventId: appended.event.event_id,
        idempotentReplay: false,
      };
      await this.transactions.phase(operationId, "committed", {
        committedAt: new Date().toISOString(),
        result,
      });
      await this.rearmScanner("task_write", { projectId, taskId, eventType });
      return result;
    });
    // Reuse the existing short-lived project lock to serialize developer claims across projects.
    return eventType === "claim" && actorType === "developer_ai"
      ? withProjectLock(this.rootDir, "developer-claim", operationId, update)
      : update();
  }

  async createTask(projectId, taskInput, {
    expectedRevision,
    operationId,
    actorType = "developer_ai",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null,
  } = {}) {
    assertOperationId(operationId);
    if (!expectedRevision) throw new TaskboardError("创建任务必须提供expectedRevision", {
      code: "EXPECTED_REVISION_REQUIRED", status: 428,
    });
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      let existing = await this.transactions.read(operationId);
      if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
      if (existing && existing.projectId !== projectId) throw new TaskboardError("operation_id已用于其它项目", {
        code: "IDEMPOTENCY_KEY_CONFLICT", status: 409,
      });
      if (existing && existing.state !== "aborted_no_effect") {
        await this.recoverTransaction(existing);
        existing = await this.transactions.read(operationId);
        if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
        if (existing?.state === "inconsistent") throw new TaskboardError("历史操作处于事务一致性异常，拒绝重试", {
          code: "TRANSACTION_INCONSISTENT", status: 409, details: { operationId },
        });
      }

      const context = await this.projects.context(projectId);
      const fileText = await fs.readFile(context.registryPath, "utf8");
      const parsed = context.adapter.parseRegistryText(fileText, context.project);
      if (parsed.registryRevision !== expectedRevision) throw new TaskboardError("任务注册表revision已变化", {
        code: "REVISION_CONFLICT", status: 409,
        details: { expectedRevision, actualRevision: parsed.registryRevision },
      });
      context.workflow.validatePriority(taskInput.priority);
      context.workflow.validateTrack(taskInput.track || context.project.defaultTrack || "product");
      context.workflow.validateStatus(taskInput.status);
      if (taskInput.status === "待用户验收") throw new TaskboardError("新任务不能直接创建为待用户验收；必须先经过独立测试PASS或受控交付完成", {
        code: "TASK_CREATE_USER_ACCEPTANCE_FORBIDDEN", status: 409,
      });
      if (context.workflow.isExecutionStatus(taskInput.status)) throw new TaskboardError("新任务不能直接创建为执行中阶段；请先创建待执行状态，再通过正式claim进入执行态", {
        code: "TASK_CREATE_EXECUTION_STATUS_FORBIDDEN", status: 409, details: { status: taskInput.status },
      });
      const suppliedRole = String(taskInput.plannedRole ?? "").trim().replace(/^—$/, "");
      const expectedRole = context.workflow.plannedRoleForStatus(taskInput.status, {
        currentRole: "", suppliedRole, hasSuppliedRole: true, statusChanging: true
      });
      if (suppliedRole !== expectedRole) throw new TaskboardError(`阶段 ${taskInput.status} 的计划角色必须为 ${expectedRole || "—"}`, {
        code: "STATUS_ROLE_MISMATCH", status: 409,
        details: { targetStatus: taskInput.status, expectedRole: expectedRole || "—", suppliedRole: suppliedRole || "—" },
      });
      if (taskInput.assignee || taskInput.sessionWindowName || taskInput.sessionId) throw new TaskboardError("新任务创建阶段不得直接写入负责人或Session；请使用正式claim", {
        code: "TASK_CREATE_OWNER_FORBIDDEN", status: 409,
      });
      const task = { ...taskInput, plannedRole: expectedRole, assignee: "", sessionWindowName: "", sessionId: "", updatedAt: taskInput.updatedAt || new Date().toISOString() };
      const creationMetadata = { ...(metadata && typeof metadata === "object" ? metadata : {}) };
      if (["controller_ai","developer_ai","test_ai"].includes(actorType) && await this.ruleGateEnabled(projectId)) {
        const sourceTaskId=String(creationMetadata.ruleReadContextTaskId||"").trim();
        if(!sourceTaskId||!parsed.tasks.some(t=>t.id===sourceTaskId))
          throw new TaskboardError("新建任务缺少同项目已验证规则的来源任务",{code:"RULE_READ_REQUIRED",status:409,details:{eventType:"task_created",reason:"context_task_missing"}});
        await this.assertRuleReadForMutation(projectId,sourceTaskId,{actorType,actorId,sessionId},"task_created");
      }
      const requestedAcceptanceScope = creationMetadata.acceptanceScope || taskInput.acceptanceScope || "system";
      const acceptanceScope = context.workflow.resolveAcceptanceScope(task, [{
        event_type: "task_created",
        metadata: { ...creationMetadata, acceptanceScope: requestedAcceptanceScope }
      }]);
      const eventMetadata = { ...creationMetadata, acceptanceScope };
      const change = context.adapter.appendRegistryTaskText(fileText, context.project, task);
      const timestamp = new Date().toISOString();
      const event = {
        operation_id: operationId, project_id: projectId, task_id: change.task.id,
        event_type: "task_created", timestamp, actor_type: actorType, actor_id: actorId,
        session_window_name: sessionWindowName, session_id: sessionId,
        old_status: null, new_status: change.task.status,
        old_priority: null, new_priority: change.task.priority,
        old_track: null, new_track: change.task.track,
        note, metadata: eventMetadata,
        registry_revision_before: change.beforeRevision, registry_revision_after: change.afterRevision,
      };
      const prepared = await this.transactions.prepare({
        operationId, projectId, taskId: change.task.id, expectedRevision,
        beforeRevision: change.beforeRevision, afterRevision: change.afterRevision,
        beforeFileSha256: change.beforeFileSha256, afterFileSha256: change.afterFileSha256,
        patch: { createTask: change.task }, event,
      });
      if (prepared.state === "committed") return { ...prepared.result, idempotentReplay: true };
      this.maybeCrash("prepared");
      await atomicWriteText(context.registryPath, change.text, change.beforeFileSha256);
      await this.transactions.phase(operationId, "registry_written");
      this.maybeCrash("registry_written");
      const appended = await this.events.append(projectId, event);
      await this.transactions.phase(operationId, "event_written", {
        eventId: appended.event.event_id, eventSegment: appended.segment || null,
      });
      this.maybeCrash("event_written");
      const result = {
        projectId, taskId: change.task.id, operationId, task: change.task,
        registryRevision: change.afterRevision, fileSha256: change.afterFileSha256,
        eventId: appended.event.event_id, idempotentReplay: false,
      };
      await this.transactions.phase(operationId, "committed", { committedAt: new Date().toISOString(), result });
      await this.rearmScanner("task_created", { projectId, taskId: change.task.id });
      return result;
    });
  }
  async getTask(projectId, taskId) {
    const snapshot = await this.snapshot(projectId);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new TaskboardError("未知任务ID: " + taskId, { code: "TASK_NOT_FOUND", status: 404 });
    return { task, snapshot };
  }

  async appendTaskEvent(projectId, taskId, {
    operationId,
    eventType,
    actorType = "system",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null,
    expectedRevision = undefined,
    internalRuleMark = null
  } = {}) {
    assertOperationId(operationId);
    if(String(eventType).startsWith("rule_read_")&&internalRuleMark!==RULE_INTERNAL)throw new TaskboardError("禁止伪造规则已读记录",{code:"RULE_READ_SERVER_ROUTE_REQUIRED",status:409});
    const append = async () => {
      const existing = await this.events.findByOperationId(projectId, operationId);
      if (existing) return { event: existing, idempotentReplay: true };
      const { task, snapshot } = await this.getTask(projectId, taskId);
      await this.assertRuleReadForMutation(projectId, taskId, { actorType, actorId, sessionId }, eventType);
      if (expectedRevision !== undefined && expectedRevision !== null && snapshot.registryRevision !== expectedRevision) {
        throw new TaskboardError("任务注册表revision已变化，拒绝追加过期的任务事件", {
          code: "REVISION_CONFLICT", status: 409,
          details: { expectedRevision, actualRevision: snapshot.registryRevision }
        });
      }
      if (["developer_issue_reported", "developer_issue_resolved"].includes(eventType)) {
        const history = await this.events.listTaskEvents(projectId, taskId, { all: true });
        const activeClaim = [...history].reverse().find(e => ["claim", "takeover"].includes(e.event_type)
          && e.actor_type === "developer_ai" && e.session_id === task.sessionId);
        if (!["开发中", "修复中", "阻断"].includes(task.status)
          || actorType !== "developer_ai" || !actorId || !sessionId
          || task.sessionId !== sessionId || activeClaim?.actor_id !== actorId) {
          throw new TaskboardError("开发问题事件必须由当前合法开发会话提交", {
            code: "DEVELOPER_ISSUE_SESSION_REQUIRED", status: 409
          });
        }
        if (eventType === "developer_issue_reported") {
          const links = metadata?.relatedTaskIds;
          const known = new Set(snapshot.tasks.map(item => item.id));
          if (metadata?.paused !== true || typeof metadata.failureCode !== "string"
            || !metadata.failureCode.trim() || metadata.failureCode.length > 120
            || typeof metadata.nextAction !== "string" || !metadata.nextAction.trim()
            || metadata.nextAction.length > 300 || !Array.isArray(links)
            || links.length < 1 || links.length > 8 || links.some(id => id === taskId || !known.has(id))) {
            throw new TaskboardError("开发暂停必须提供真实关联任务、错误码和下一动作", {
              code: "DEVELOPER_ISSUE_EVIDENCE_REQUIRED", status: 409
            });
          }
        }
      }
      const appended = await this.events.append(projectId, {
        operation_id: operationId,
        project_id: projectId,
        task_id: taskId,
        event_type: eventType,
        timestamp: new Date().toISOString(),
        actor_type: actorType,
        actor_id: actorId,
        session_window_name: sessionWindowName,
        session_id: sessionId,
        old_status: task.status,
        new_status: task.status,
        old_priority: task.priority,
        new_priority: task.priority,
        old_track: task.track,
        new_track: task.track,
        note,
        metadata,
        registry_revision_before: snapshot.registryRevision,
        registry_revision_after: snapshot.registryRevision
      });
      if (!appended.duplicate) await this.rearmScanner("task_event", { projectId, taskId, eventType });
      return { event: appended.event, idempotentReplay: appended.duplicate };
    };
    return expectedRevision === undefined || expectedRevision === null
      ? append()
      : withProjectLock(this.rootDir, projectId, operationId, append);
  }

  async taskHistory(projectId, taskId, { limit = 200, all = false } = {}) {
    await this.getTask(projectId, taskId);
    return this.events.listTaskEvents(projectId, taskId, { limit, all });
  }


  async testResourceState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { all: true });
    const resources = new Map();
    for (const event of events) {
      const metadata = event.metadata || {};
      const resourceId = String(metadata.resourceId || "").trim();
      if (!resourceId) continue;
      if (event.event_type === "test_resource_preserved") {
        resources.set(resourceId, {
          resourceId,
          resourceType: String(metadata.resourceType || "").trim(),
          locator: String(metadata.locator || "").trim(),
          purpose: String(metadata.purpose || "").trim(),
          owner: {
            actorType: event.actor_type,
            actorId: event.actor_id,
            sessionId: event.session_id || "",
            sessionWindowName: event.session_window_name || ""
          },
          handoffTarget: String(metadata.handoffTarget || "").trim(),
          cleanupCondition: String(metadata.cleanupCondition || "").trim(),
          cleanupBy: metadata.cleanupBy || null,
          evidencePath: String(metadata.evidencePath || "").trim(),
          safetyStatus: String(metadata.safetyStatus || "safe").trim(),
          preservedAt: event.timestamp,
          status: "待开发观察",
          lastEventId: event.event_id,
          observed: null,
          cleaned: null
        });
      } else if (event.event_type === "test_resource_observed" && resources.has(resourceId)) {
        const item = resources.get(resourceId);
        item.observed = {
          result: String(metadata.result || "viewed"),
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionId: event.session_id || "",
          timestamp: event.timestamp,
          note: cleanHumanText(event.note)
        };
        item.status = metadata.result === "reproduced" ? "开发已复现" : metadata.result === "not_needed" ? "开发确认不再需要" : "开发已查看";
        item.lastEventId = event.event_id;
      } else if (event.event_type === "test_resource_cleaned" && resources.has(resourceId)) {
        const item = resources.get(resourceId);
        item.cleaned = {
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionId: event.session_id || "",
          timestamp: event.timestamp,
          note: cleanHumanText(event.note)
        };
        item.status = "已清理";
        item.lastEventId = event.event_id;
      }
    }
    const now = Date.now();
    const items = [...resources.values()].map((item) => {
      const cleanupAt = item.cleanupBy ? Date.parse(item.cleanupBy) : NaN;
      const stale = !item.cleaned && Number.isFinite(cleanupAt) && cleanupAt <= now;
      const requiresImmediateCleanup = !item.cleaned && !["safe", "isolated"].includes(item.safetyStatus);
      return { ...item, stale, requiresImmediateCleanup };
    });
    return {
      items,
      active: items.filter((item) => !item.cleaned),
      activeCount: items.filter((item) => !item.cleaned).length,
      staleCount: items.filter((item) => !item.cleaned && item.stale).length,
      immediateCleanupCount: items.filter((item) => item.requiresImmediateCleanup).length
    };
  }

  async userMessageState(projectId, taskId, actor = {}) {
    const events = await this.taskHistory(projectId, taskId, { all: true });
    const messages = events.filter(isUserMessage);
    const scope = messageScope(actor);
    const acknowledged = new Set();
    const replies = new Map();
    let latestMessageId = null;
    for (const event of events) {
      if (isUserMessage(event)) latestMessageId = event.event_id;
      if (event.event_type === "user_message_ack" && event.metadata?.scope === scope) {
        for (const eventId of event.metadata?.eventIds || []) acknowledged.add(eventId);
      }
      if (event.event_type === "user_message_reply") {
        const target = event.metadata?.replyToEventId || latestMessageId;
        if (!target) continue;
        if (!replies.has(target)) replies.set(target, []);
        replies.get(target).push({
          eventId: event.event_id,
          timestamp: event.timestamp,
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionWindowName: event.session_window_name,
          note: cleanHumanText(event.note),
          inferred: !event.metadata?.replyToEventId
        });
      }
    }
    const serialize = (event) => ({
      eventId: event.event_id,
      type: event.event_type,
      timestamp: event.timestamp,
      note: cleanHumanText(event.note),
      replies: replies.get(event.event_id) || []
    });
    const unread = messages.filter((event) => !acknowledged.has(event.event_id));
    return {
      scope,
      messages: messages.slice(-20).map(serialize),
      unreadMessages: unread.map(serialize),
      unreadCount: unread.length,
      requiresAcknowledgement: unread.length > 0
    };
  }

  async preclaimReportState(projectId, taskId, actor = {}, currentTask = null) {
    const task = currentTask || (await this.getTask(projectId, taskId)).task;
    const actorType = String(actor.actorType || "developer_ai");
    const actorId = String(actor.actorId || "");
    const sessionId = String(actor.sessionId || "");
    if (!actorId || !sessionId) {
      return { valid: false, reason: "identity_missing", eventId: null, timestamp: null };
    }
    const events = await this.events.listTaskEvents(projectId, taskId, { all: true });
    let latest = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (
        event.event_type === "preclaim_report" &&
        event.actor_type === actorType &&
        event.actor_id === actorId &&
        String(event.session_id || "") === sessionId
      ) {
        latest = event;
        break;
      }
    }
    if (!latest) {
      return { valid: false, reason: "missing", eventId: null, timestamp: null };
    }
    const metadata = latest.metadata || {};
    const currentStatus = String(task.status || "");
    const currentUpdatedAt = String(task.updatedAt || "");
    const reportedStatus = String(metadata.taskStatus || "");
    const reportedUpdatedAt = String(metadata.taskUpdatedAt || "");
    const valid = reportedStatus === currentStatus && reportedUpdatedAt === currentUpdatedAt;
    return {
      valid,
      reason: valid ? null : "task_changed",
      eventId: latest.event_id,
      timestamp: latest.timestamp,
      reportedStatus,
      reportedUpdatedAt,
      currentStatus,
      currentUpdatedAt
    };
  }


  async ruleManifest(projectId,taskId,actorType){
    const role={developer_ai:"开发",test_ai:"独测",controller_ai:"总控"}[actorType];
    if(!role)throw new TaskboardError("无效角色",{code:"RULE_READ_ROLE_INVALID",status:400});
    const {task}=await this.getTask(projectId,taskId);
    const ctx=await this.projects.context(projectId);
    const roleDocs={"开发":"流程文档/开发/D01_CLAIM_正式领取任务.md","独测":"流程文档/独测/Q01_ADMISSION_独立测试准入.md","总控":"流程文档/总控/C00_A_REQUIREMENTS_需求记录与讨论.md"};
    const files=["流程文档/00_流程与重大更新日志.md","流程文档/00_统一入口.md",
      "流程文档/"+role+"/00_角色入口.md",
      "流程文档/07_全软件BUG强制修复与闭环续接规范.md",
      "流程文档/02_增删改操作日志规范.md",
      "流程文档/04_逐步聊天汇报与证据校验规范.md",
      "流程文档/05_BUG修复三问与关联任务验收规范.md",
      "流程文档/06_全任务依赖审计与阻断优先调度规范.md",
      roleDocs[role],
      ".agents/skills/ponytail/SKILL.md",
      "data/taskboard/checkpoints/00_跨角色共享待办_总控维护.md",
      ...String(task.plan||"").split(";").filter(Boolean)];
    const cp="data/taskboard/checkpoints/"+taskId+".md";
    if(await fs.stat(path.join(ctx.rootRealPath,cp)).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;}))files.push(cp);
    const documents=[];
    for(const relative of new Set(files)){
      let content;
      try{
        const f=await resolveProjectPath(ctx.rootRealPath,relative,{mustExist:true,rejectReparse:true});
        const st=await fs.stat(f);
        if(!st.isFile()||st.size>1048576)throw Error("oversize");
        content=await fs.readFile(f,"utf8");
      }catch{throw new TaskboardError("必读文档无法安全读取: "+relative,
        {code:"RULE_READ_DOCUMENT_INVALID",status:409,details:{path:relative}});}
      documents.push({path:relative,content,sha:crypto.createHash("sha256").update(content).digest("hex"),
        chunks:Math.max(1,Math.ceil(content.length/4096))});
    }
    const fingerprint=crypto.createHash("sha256").update(JSON.stringify([projectId,taskId,actorType,
      task.plan,task.readDependencies,task.writeTargets,task.boundary,
      documents.map(d=>[d.path,d.sha,d.chunks])])).digest("hex");
    return {fingerprint,documents};
  }
  async ruleGateEnabled(projectId){
    // The canonical taskboard must fail closed if its authority rules directory is missing.
    if(projectId==="wyerp-taskboard")return true;
    const ctx=await this.projects.context(projectId);
    return Boolean((await fs.stat(path.join(ctx.rootRealPath,"流程文档")).catch(error=>{if(error.code==="ENOENT")return undefined;throw error;}))?.isDirectory());
  }
  async ruleCheckList(projectId,taskId,role){
    const m=await this.ruleManifest(projectId,taskId,role);
    return {fingerprint:m.fingerprint,documents:m.documents.map((d,i)=>({index:i,path:d.path,sha:d.sha,chunks:d.chunks})),
      scenarios:[...Object.keys(RULE_ANSWERS),"role_duty"]};
  }
  async ruleReadChunk(projectId,taskId,actor,docIndex,chunkIndex){
    if(!actor.actorId||!actor.sessionId)throw new TaskboardError("Session缺失",
      {code:"RULE_READ_IDENTITY_REQUIRED",status:400});
    const m=await this.ruleManifest(projectId,taskId,actor.actorType);
    const d=m.documents[Number(docIndex)],i=Number(chunkIndex);
    if(!d||!Number.isInteger(i)||i<0||i>=d.chunks)throw new TaskboardError("无效文档分块",
      {code:"RULE_READ_CHUNK_INVALID",status:404});
    const e=await this.appendTaskEvent(projectId,taskId,{
      operationId:"rule_read.chunk."+crypto.randomUUID(),eventType:"rule_read_chunk_served",
      actorType:actor.actorType,actorId:actor.actorId,sessionId:actor.sessionId,
      internalRuleMark:RULE_INTERNAL,
      metadata:{fingerprint:m.fingerprint,path:d.path,sha:d.sha,index:i}
    });
    return {path:d.path,sha:d.sha,index:i,total:d.chunks,
      content:d.content.slice(i*4096,(i+1)*4096),eventId:e.event.event_id};
  }
  async ruleVerify(projectId,taskId,actor,answers){
    const m=await this.ruleManifest(projectId,taskId,actor.actorType);
    const events=await this.events.listTaskEvents(projectId,taskId,{all:true});
    for(const d of m.documents)for(let i=0;i<d.chunks;i++){
      if(!events.some(e=>e.event_type==="rule_read_chunk_served"
        &&e.actor_type===actor.actorType&&e.actor_id===actor.actorId&&e.session_id===actor.sessionId
        &&e.metadata?.fingerprint===m.fingerprint&&e.metadata?.path===d.path
        &&e.metadata?.sha===d.sha&&e.metadata?.index===i))
        throw new TaskboardError("规则没有完整读取："+d.path,{code:"RULE_READ_INCOMPLETE",status:409});
    }
    if(!answers||Object.keys(RULE_ANSWERS).some(k=>answers[k]!==RULE_ANSWERS[k])
      ||answers.role_duty!==RULE_ROLE_DUTY[actor.actorType])
      throw new TaskboardError("规则场景错误",{code:"RULE_READ_SCENARIO_FAILED",status:409});
    const e=await this.appendTaskEvent(projectId,taskId,{
      operationId:"rule_read.verified."+crypto.randomUUID(),eventType:"rule_read_verified",
      actorType:actor.actorType,actorId:actor.actorId,sessionId:actor.sessionId,
      internalRuleMark:RULE_INTERNAL,metadata:{fingerprint:m.fingerprint}
    });
    return {valid:true,fingerprint:m.fingerprint,eventId:e.event.event_id};
  }
  async assertRuleReadForMutation(projectId, taskId, actor, eventType) {
    if (!["controller_ai", "developer_ai", "test_ai"].includes(actor.actorType)
      || eventType === "preclaim_report"
      || String(eventType).startsWith("rule_read_")) return;
    if (!(await this.ruleGateEnabled(projectId))) return;
    const proof = await this.ruleStatus(projectId, taskId, actor);
    if (!proof.valid) throw new TaskboardError("本Session尚未完成当前规则阅读及情境验证", {
      code: "RULE_READ_REQUIRED", status: 409,
      details: { eventType, ...proof }
    });
  }
  async ruleStatus(projectId,taskId,actor){
    if(!actor.actorId||!actor.sessionId)return {valid:false,reason:"identity_missing"};
    if(!(await this.ruleGateEnabled(projectId)))return {valid:true,disabled:true};
    const m=await this.ruleManifest(projectId,taskId,actor.actorType);
    const events=await this.events.listTaskEvents(projectId,taskId,{all:true});
    const e=events.findLast(e=>e.event_type==="rule_read_verified"
      &&e.actor_type===actor.actorType&&e.actor_id===actor.actorId&&e.session_id===actor.sessionId);
    return {valid:e?.metadata?.fingerprint===m.fingerprint,
      reason:e?.metadata?.fingerprint===m.fingerprint?null:"missing_or_stale",
      fingerprint:m.fingerprint};
  }
  async presentation(projectId, taskId) {
    const { task } = await this.getTask(projectId, taskId);
    return task.presentation;
  }

  async readTaskDocument(projectId, taskId, documentIndex) {
    const { task } = await this.getTask(projectId, taskId);
    const context = await this.projects.context(projectId);
    const documents = documentEntries(task, context.project);
    const index = Number(documentIndex);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) {
      throw new TaskboardError("任务没有这个关联文档入口", {
        code: "TASK_DOCUMENT_NOT_FOUND", status: 404, details: { taskId, documentIndex }
      });
    }
    const selected = documents[index];
    const filePath = await resolveProjectPath(context.rootRealPath, selected.path, { mustExist: true, rejectReparse: true });
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new TaskboardError("关联文档不是文件", { code: "TASK_DOCUMENT_NOT_FILE", status: 422 });
    if (stat.size > 2 * 1024 * 1024) throw new TaskboardError("关联文档过大，拒绝在看板中直接打开", {
      code: "TASK_DOCUMENT_TOO_LARGE", status: 413, details: { bytes: stat.size }
    });
    return { taskId, ...selected, content: await fs.readFile(filePath, "utf8") };
  }

  async readTaskPlan(projectId, taskId, planIndex) {
    const { task } = await this.getTask(projectId, taskId);
    const plans = planEntries(task);
    const index = Number(planIndex);
    if (!Number.isInteger(index) || index < 0 || index >= plans.length) {
      throw new TaskboardError("任务没有这个计划入口", {
        code: "TASK_PLAN_NOT_FOUND", status: 404, details: { taskId, planIndex }
      });
    }
    const selected = plans[index];
    if (!selected.path.toLowerCase().endsWith(".md")) {
      throw new TaskboardError("任务计划必须是Markdown文档", {
        code: "TASK_PLAN_FORMAT_INVALID", status: 422, details: { taskId, planIndex }
      });
    }
    const context = await this.projects.context(projectId);
    const filePath = await resolveProjectPath(context.rootRealPath, selected.path, { mustExist: true, rejectReparse: true });
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new TaskboardError("任务计划不是文件", { code: "TASK_PLAN_NOT_FILE", status: 422 });
    if (stat.size > 2 * 1024 * 1024) throw new TaskboardError("任务计划文件过大，拒绝在看板中直接打开", {
      code: "TASK_PLAN_TOO_LARGE", status: 413, details: { bytes: stat.size }
    });
    return {
      taskId,
      index,
      name: selected.name,
      path: selected.path,
      primary: selected.primary,
      content: await fs.readFile(filePath, "utf8")
    };
  }

  async stopState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { all: true });
    let pending = null;
    for (const event of events) {
      if (event.event_type === "stop_request") pending = event;
      if (["stop_acknowledged", "resume"].includes(event.event_type)) pending = null;
    }
    return { stopRequested: Boolean(pending), request: pending };
  }
  async takeoverState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { all: true });
    let suspected = null;
    let allowed = null;
    for (const event of events) {
      if (event.event_type === "suspected_disconnect") {
        suspected = event;
        allowed = null;
      }
      if (event.event_type === "takeover_allowed") {
        allowed = event;
      }
      if (["takeover", "takeover_revoked", "claim"].includes(event.event_type)) {
        suspected = null;
        allowed = null;
      }
    }
    return {
      suspectedDisconnect: Boolean(suspected),
      suspicion: suspected,
      takeoverAllowed: Boolean(allowed),
      authorization: allowed,
    };
  }
  async recoverTransaction(transaction) {
    const { operationId, projectId } = transaction;
    const context = await this.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const event = await this.events.findByOperationId(projectId, operationId);

    if (parsed.registryRevision === transaction.beforeRevision && !event) {
      await this.transactions.phase(operationId, "aborted_no_effect", {
        recovery: { action: "aborted_no_effect", at: new Date().toISOString() },
      });
      await this.transactions.audit("recovery_aborted_no_effect", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null }, "warning");
      return { operationId, action: "aborted_no_effect" };
    }

    if (parsed.registryRevision === transaction.afterRevision) {
      let finalEvent = event;
      if (!finalEvent) {
        const appended = await this.events.append(projectId, transaction.event);
        finalEvent = appended.event;
      }
      const result = transaction.result || {
        projectId,
        taskId: transaction.taskId,
        operationId,
        registryRevision: transaction.afterRevision,
        fileSha256: transaction.afterFileSha256,
        eventId: finalEvent.event_id,
        recovered: true,
      };
      await this.transactions.phase(operationId, "committed", {
        committedAt: new Date().toISOString(),
        recovery: { action: event ? "commit_existing_event" : "append_missing_event", at: new Date().toISOString() },
        result,
      });
      await this.transactions.audit("recovery_committed", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null, action: event ? "commit_existing_event" : "append_missing_event" });
      return { operationId, action: event ? "commit_existing_event" : "append_missing_event", result };
    }

    await this.transactions.phase(operationId, "inconsistent", {
      recovery: {
        action: "manual_intervention_required",
        at: new Date().toISOString(),
        currentRevision: parsed.registryRevision,
        eventPresent: Boolean(event),
      },
    });
    await this.transactions.audit("recovery_inconsistent", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null, current_revision: parsed.registryRevision, event_present: Boolean(event) }, "error");
    return { operationId, action: "inconsistent" };
  }

  async recoverPendingTransactions() {
    const pending = await this.transactions.listPending();
    const results = [];
    for (const transaction of pending) {
      try {
        results.push(await withProjectLock(this.rootDir, transaction.projectId, transaction.operationId, () =>
          this.recoverTransaction(transaction)
        ));
      } catch (error) {
        await this.transactions.audit("recovery_failed", { operation_id: transaction.operationId, project_id: transaction.projectId, task_id: transaction.taskId || null, error: String(error?.message || error).slice(0, 1000) }, "error");
        throw error;
      }
    }
    return results;
  }
}

