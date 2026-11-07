import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { TaskboardError } from "./core/errors.mjs";
import { withProjectLock } from "./core/project-lock.mjs";
import { isWithinRoot } from "./core/path-safety.mjs";
import { TaskStore } from "./task-store.mjs";

const START = "<!-- TASK_STEP_CHECKPOINT_START v1 -->";
const END = "<!-- TASK_STEP_CHECKPOINT_END -->";
const SHA = (text) => crypto.createHash("sha256").update(text).digest("hex");
const LEGACY_ROLE_STEPS = Object.freeze({
  controller_ai: ["C01_SCAN", "C02_TRIAGE", "C03_DISPATCH", "C04_VERIFY_NEXT"],
  developer_ai: ["D01_CLAIM", "D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3", "D08_HANDOFF", "D09_MERGE_MAIN", "D10_POSTMERGE",
    "D11_CLEANUP", "D12_COMPLETE", "D13_NEXT"],
  test_ai: ["Q01_ADMISSION", "Q02_TEST", "Q03_RESULT", "Q04_NEXT"]
});
const ROLE_STEPS = Object.freeze({
  controller_ai: ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C00_D_ENVIRONMENT", "C01_SCAN", "C02_TRIAGE", "C03_DISPATCH", "C04_MERGE_MAIN",
    "C05_POSTMERGE", "C06_CLEANUP", "C07_COMPLETE", "C08_NEXT"],
  developer_ai: ["D01_CLAIM", "D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3", "D08_HANDOFF", "D09_NEXT"],
  test_ai: LEGACY_ROLE_STEPS.test_ai
});
const FLOW_STEPS = Object.freeze({
  "role-steps-v1": LEGACY_ROLE_STEPS,
  "role-steps-v2": ROLE_STEPS
});
const EVENT_REQUIRED = {
  C03_DISPATCH: ["controller_dispatch", "task_created"],
  D01_CLAIM: ["claim", "takeover"], D08_HANDOFF: ["handoff"],
  D12_COMPLETE: ["delivery_complete"], C07_COMPLETE: ["delivery_complete"],
  Q01_ADMISSION: ["claim", "takeover"], Q03_RESULT: ["test_result"]
};
const C00_EVENTS = Object.freeze({
  C00_A_REQUIREMENTS: "controller_requirements_reviewed",
  C00_B_MAIN_VERSION: "controller_main_version_verified",
  C00_C_SAFE_CLEANUP: "controller_safe_cleanup_verified"
});
function validC00Evidence(stepId, metadata = {}) {
  if (stepId === "C00_A_REQUIREMENTS") {
    return metadata.requirementsReviewed === true
      && typeof metadata.requirementEvidence === "string" && metadata.requirementEvidence.trim().length >= 8;
  }
  if (stepId === "C00_B_MAIN_VERSION") {
    return metadata.gitExitCode === 0 && /^[a-f0-9]{40}$/i.test(metadata.localMainSha || "")
      && metadata.localMainSha === metadata.remoteMainSha
      && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.packageVersion || "");
  }
  return metadata.resourcesChecked === true
    && ["clean", "archived", "preserved"].includes(metadata.cleanupOutcome)
    && typeof metadata.cleanupEvidence === "string" && metadata.cleanupEvidence.trim().length >= 8
    && (metadata.cleanupOutcome !== "preserved" || Boolean(metadata.nextAction));
}
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLOSED = new Set(["已完成", "已取消"]);
function invalid(code, message, status = 409) {
  return new TaskboardError(message, { code, status });
}
async function hardDependenciesCompleted(taskStore, projectId, task) {
  const ids = String(task.readDependencies || "").split(/[；;]/)
    .map((item) => item.replaceAll("`", "").trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s*完成$/)?.[1])
    .filter(Boolean);
  if (!ids.length) return true;
  const snapshot = await taskStore.snapshot(projectId);
  return ids.every((id) => snapshot.tasks.some((entry) =>
    entry.id === id && entry.status === "已完成"));
}
async function committedAutoPreparation(store, projectId, taskId, history, claimIndex) {
  if (claimIndex < 0 || history.slice(0, claimIndex).some((event) =>
    event.actor_type === "developer_ai" && ["claim", "takeover"].includes(event.event_type))) return false;
  const ready = history.slice(0, claimIndex).findLast((event) =>
    event.event_type === "auto_preparation_ready" && event.actor_type === "system"
    && event.actor_id === "task-scan" && event.old_status === "待准备"
    && event.new_status === "待开发" && typeof event.metadata?.preparationUpdatedAt === "string");
  if (!ready) return false;
  const readyIndex = history.indexOf(ready);
  if (history.slice(readyIndex + 1, claimIndex).some((event) =>
    event.old_status !== event.new_status)) return false;
  const operationId = "auto_preparation_ready." + SHA(projectId + "|" + taskId + "|" + ready.metadata.preparationUpdatedAt);
  if (ready.operation_id !== operationId) return false;
  const transaction = await store.transactions.read(operationId);
  return transaction?.state === "committed" && transaction.result?.eventId === ready.event_id
    && transaction.event?.event_type === "auto_preparation_ready"
    && transaction.event?.actor_type === "system" && transaction.event?.actor_id === "task-scan"
    && transaction.event?.metadata?.preparationUpdatedAt === ready.metadata.preparationUpdatedAt;
}
function emptyState(projectId, taskId, flowVersion) {
  return {
    version: 1, projectId, taskId, flowVersion,
    cursors: Object.fromEntries(Object.entries(FLOW_STEPS[flowVersion]).map(([role, steps]) => [role, steps[0]])),
    attempts: 1, records: [], lastAction: null
  };
}
function parseCheckpoint(text, projectId, taskId, flowVersion) {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 && end < 0) return { state: emptyState(projectId, taskId, flowVersion), legacy: text.trim().length > 0 };
  if (start < 0 || end < start || text.indexOf(START, start + START.length) >= 0) {
    throw invalid("CHECKPOINT_FORMAT_INVALID", "任务断点结构化区块重复或损坏");
  }
  let state;
  try { state = JSON.parse(text.slice(start + START.length, end).trim()); }
  catch { throw invalid("CHECKPOINT_FORMAT_INVALID", "任务断点JSON损坏，拒绝覆盖"); }
  if (state.projectId !== projectId || state.taskId !== taskId || state.version !== 1
    || !state.cursors || !Array.isArray(state.records)) {
    throw invalid("CHECKPOINT_TASK_MISMATCH", "断点任务编号与当前项目不匹配，拒绝覆盖");
  }
  const steps = FLOW_STEPS[state.flowVersion];
  if (!steps || !Object.entries(steps).every(([role, names]) =>
    state.cursors[role] === null || names.includes(state.cursors[role]))) {
    throw invalid("CHECKPOINT_FLOW_VERSION_INVALID", "旧/新步骤游标不受支持，禁止猜测并跳级");
  }
  return { state, legacy: state.flowVersion === "role-steps-v1" };
}
function renderCheckpoint(original, state) {
  const begin = original.indexOf(START), finish = original.indexOf(END);
  const visible = [
    "", "## 当前执行步骤（由任务看板原子维护）",
    ...Object.keys(FLOW_STEPS[state.flowVersion]).map((role) =>
      "- " + role + " 下一步：" + (state.cursors[role] || "已完成")),
    "- 最近执行：" + (state.lastAction?.stepId || "无") + " / " + (state.lastAction?.result || "—"),
    "- 记录条数：" + state.records.length,
    "", START, JSON.stringify(state, null, 2), END, ""
  ].join("\n");
  if (begin < 0) return original.trimEnd() + "\n" + visible;
  // Preserve any legacy content before the generated snapshot, and reject extra text after it.
  const previous = original.lastIndexOf("## 当前执行步骤（由任务看板原子维护）", begin);
  const prefix = previous >= 0 ? original.slice(0, previous) : original.slice(0, begin);
  const suffix = original.slice(finish + END.length).trim();
  if (suffix) throw invalid("CHECKPOINT_TRAILING_CONTENT", "结构化断点后有手工改动，请先由总控核对");
  return prefix.trimEnd() + "\n" + visible;
}
async function writeFileAtomically(filename, text) {
  const tmp = filename + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    await fs.writeFile(tmp, text, { flag: "wx" });
    await fs.rename(tmp, filename);
  } finally {
    await fs.rm(tmp, { force: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export const ROLE_STAGE_STEPS = ROLE_STEPS;

export class TaskStepCheckpoint {
  constructor(rootDir, { taskStore = null, flowVersion = "role-steps-v2" } = {}) {
    if (!FLOW_STEPS[flowVersion]) throw invalid("CHECKPOINT_FLOW_VERSION_INVALID", "不支持的角色步骤版本", 400);
    this.rootDir = rootDir;
    this.taskStore = taskStore;
    this.flowVersion = flowVersion;
  }
  async init() {
    this.taskStore ||= await new TaskStore(this.rootDir).init();
    return this;
  }
  async location(projectId, taskId) {
    if (!ID_PATTERN.test(taskId)) throw invalid("INVALID_TASK_ID", "断点文件只能使用合法任务编号", 400);
    if (!this.taskStore) await this.init();
    const { task } = await this.taskStore.getTask(projectId, taskId);
    const context = await this.taskStore.projects.context(projectId);
    const dir = path.resolve(context.rootRealPath, context.project.checkpointDir || "任务进度断点");
    if (!isWithinRoot(context.rootRealPath, dir)) throw invalid("CHECKPOINT_ROOT_ESCAPE", "断点目录越过项目根目录", 403);
    await fs.mkdir(dir, { recursive: true });
    const realDir = await fs.realpath(dir);
    if (!isWithinRoot(context.rootRealPath, realDir)) throw invalid("CHECKPOINT_ROOT_ESCAPE", "断点目录含指向项目外的链接", 403);
    const file = path.join(realDir, task.id + ".md");
    const stat = await fs.lstat(file).catch((e) => e.code === "ENOENT" ? null : Promise.reject(e));
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw invalid("CHECKPOINT_NOT_REGULAR_FILE", "断点不能是符号链接", 403);
    return file;
  }
  async show(projectId, taskId) {
    const file = await this.location(projectId, taskId);
    const content = await fs.readFile(file, "utf8").catch((e) => e.code === "ENOENT" ? "" : Promise.reject(e));
    const { state, legacy } = parseCheckpoint(content, projectId, taskId, this.flowVersion);
    const context = await this.taskStore.projects.context(projectId);
    const relativeFile = path.relative(context.rootRealPath, file).split(path.sep).join("/");
    return { file: relativeFile, sha256: SHA(content), exists: Boolean(content), legacy, state };
  }
  async assertTransitionEvidence(projectId, taskId, { eventType, actorType, actorId, sessionId }) {
    const stage = {
      handoff: { role: "developer_ai", prior: "D07_TEST_3", next: "D08_HANDOFF", results: ["PASS"] },
      test_result: { role: "test_ai", prior: "Q02_TEST", next: "Q03_RESULT",
        results: ["PASS", "FAIL", "BLOCK"] },
      delivery_complete: { role: "controller_ai", prior: "C06_CLEANUP", next: "C07_COMPLETE",
        results: ["PASS"] }
    }[eventType];
    if (!stage || actorType !== stage.role) return;
    const checkpoint = await this.show(projectId, taskId);
    if (!checkpoint.exists || checkpoint.legacy) return;
    const { state } = checkpoint;
    const actorSteps = state.records.filter((item) =>
      item.actorType === actorType && item.actorId === actorId && item.sessionId === sessionId);
    // Historical API-only tasks never entered this actor's step chain.
    if (!actorSteps.length) return;
    const ownSteps = actorSteps.filter((item) => item.attempt === state.attempts);
    const prior = [...ownSteps].reverse().find((item) => item.stepId === stage.prior);
    const cursor = state.cursors[actorType];
    const cursorReady = cursor === stage.next ||
      (eventType === "test_result" && cursor === "Q02_TEST"
        && prior && ["FAIL", "BLOCK"].includes(prior.result));
    if (!prior || !stage.results.includes(prior.result) || !cursorReady) {
      throw invalid("CHECKPOINT_STAGE_REQUIRED", "正式任务状态推进缺少本轮当前角色的可信上一步证据");
    }
  }
  async record(projectId, taskId, { operationId, expectedSha256, stepId, actorType, actorId,
    sessionId, result = "PASS", evidence, eventId = null, note = "", substepId = null } = {}) {
    if (!ID_PATTERN.test(operationId || "") || !expectedSha256 || !ID_PATTERN.test(actorId || "")
      || !String(sessionId || "").trim()) throw invalid("CHECKPOINT_ARGUMENT_REQUIRED", "缺少操作编号/断点版本/actor/Session", 400);
    const supported = Object.values(FLOW_STEPS).some((roleSteps) => roleSteps[actorType]?.includes(stepId));
    if (!supported) throw invalid("CHECKPOINT_ROLE_STEP_INVALID", "角色与步骤不匹配", 403);
    if (!["PASS", "FAIL", "BLOCK", "PROGRESS"].includes(result)) throw invalid("CHECKPOINT_RESULT_INVALID", "步骤结果非法", 400);
    if (result === "PROGRESS" && !ID_PATTERN.test(substepId || "")) throw invalid("CHECKPOINT_SUBSTEP_REQUIRED", "小功能完成须提供唯一子步骤编号", 400);
    if (typeof evidence !== "string" || evidence.trim().length < 8) {
      throw invalid("CHECKPOINT_EVIDENCE_REQUIRED", "完成步骤必须附可追溯证据", 422);
    }
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      const previous = await this.show(projectId, taskId);
      const state = previous.state;
      const roleSteps = FLOW_STEPS[state.flowVersion];
      const steps = roleSteps[actorType];
      if (!steps?.includes(stepId)) throw invalid("CHECKPOINT_ROLE_STEP_INVALID", "该断点版本不允许此步骤", 403);
      const modern = state.flowVersion === "role-steps-v2";
      const optionalEnvironment = modern && actorType === "controller_ai"
        && stepId === "C00_D_ENVIRONMENT" && state.cursors.controller_ai === "C01_SCAN"
        && state.records.some((r) => r.stepId === "C00_C_SAFE_CLEANUP" && r.result === "PASS" && r.attempt === state.attempts)
        && !state.records.some((r) => r.stepId === "C00_D_ENVIRONMENT" && r.result === "PASS" && r.attempt === state.attempts);
      const prior = state.records.find((x) => x.operationId === operationId);
      if (prior) {
        if (prior.stepId !== stepId || prior.actorId !== actorId || prior.sessionId !== sessionId
          || prior.result !== result || prior.substepId !== substepId || prior.evidence !== evidence.trim()) {
          throw invalid("CHECKPOINT_OPERATION_CONFLICT", "操作编号已用于其它步骤或身份");
        }
        return { ...previous, duplicate: true };
      }
      if (previous.sha256 !== expectedSha256) {
        throw invalid("CHECKPOINT_REVISION_CONFLICT", "断点被其它角色更新，必须重新读取", 409);
      }
      const history = await this.taskStore.taskHistory(projectId, taskId, { all: true });
      const { task } = await this.taskStore.getTask(projectId, taskId);
      if (state.flowVersion === "role-steps-v2" && actorType === "controller_ai"
        && stepId === "C00_A_REQUIREMENTS" && state.cursors.controller_ai === null
        && task.status === "交付中" && !state.records.some((r) =>
          r.stepId === "C00_A_REQUIREMENTS" && r.attempt > state.attempts)) {
        const claimIndex = history.findLastIndex((entry) =>
          entry.event_type === "claim" && entry.actor_type === "controller_ai"
          && entry.new_status === "交付中");
        const claim = history[claimIndex];
        const qaPassIndex = history.findLastIndex((entry, i) => i < claimIndex
          && entry.event_type === "test_result" && entry.actor_type === "test_ai"
          && entry.metadata?.atomicLifecycle === true
          && entry.metadata?.testResult === "pass"
          && entry.new_status === "待交付");
        const previousEnd = state.records.some((entry) =>
          entry.stepId === "C08_NEXT" && entry.result === "PASS" && entry.attempt === state.attempts);
        if (claimIndex >= 0 && claim?.actor_id === actorId && claim?.session_id === sessionId
          && task.sessionId === sessionId && qaPassIndex >= 0 && previousEnd
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task)) {
          state.attempts += 1;
          state.cursors.controller_ai = "C00_A_REQUIREMENTS";
        }
      }
      const currentClaim = [...history].reverse().find((entry) =>
        entry.actor_type === "developer_ai" && ["claim", "takeover"].includes(entry.event_type));
      const currentClaimIndex = history.indexOf(currentClaim);
      let q04RequeuedTakeover = false;
      if (stepId === "D01_CLAIM" && state.cursors.developer_ai !== "D01_CLAIM") {
        const lastFailIndex = history.findLastIndex((entry) =>
          entry.event_type === "test_result" && entry.actor_type === "test_ai"
          && entry.metadata?.atomicLifecycle === true && entry.metadata?.testResult === "fail"
          && ["独测中", "复测中"].includes(entry.old_status)
          && entry.new_status === "测试失败待修复");
        const failed = history[lastFailIndex];
        const latestQAClaim = lastFailIndex >= 0 && [...history.slice(0, lastFailIndex)].reverse().find((entry) =>
          entry.actor_type === "test_ai" && ["claim", "takeover"].includes(entry.event_type));
        const validFailure = failed && lastFailIndex === history.findLastIndex((e) =>
          e.event_type === "test_result" && e.actor_type === "test_ai")
          && ["独测中", "复测中"].includes(failed.old_status)
          && failed.new_status === "测试失败待修复" && failed.metadata?.reportPath
          && latestQAClaim?.actor_id === failed.actor_id
          && latestQAClaim?.session_id === failed.session_id;
        const latestQaResultIndex = history.findLastIndex((e) =>
          e.event_type === "test_result" && e.actor_type === "test_ai");
        const blockedIndex = history.findLastIndex((e) =>
          e.event_type === "test_result" && e.actor_type === "test_ai"
          && e.metadata?.atomicLifecycle === true
          && e.metadata?.testResult === "blocked"
          && ["独测中", "复测中"].includes(e.old_status)
          && e.new_status === "阻断" && Boolean(e.metadata?.reportPath));
        const blocked = history[blockedIndex];
        const blockedQaClaim = blockedIndex >= 0
          && [...history.slice(0, blockedIndex)].reverse().find((e) =>
            e.actor_type === "test_ai" && ["claim", "takeover"].includes(e.event_type));
        const afterBlock = history.slice(blockedIndex + 1, currentClaimIndex);
        const returnOffset = afterBlock.findLastIndex((e) =>
          e.actor_type === "controller_ai"
          && /^controller_[a-z0-9_]+$/i.test(e.event_type)
          && ["阻断", "HOLD", "待复测"].includes(e.old_status)
          && e.new_status === "测试失败待修复");
        const hasFreshDispatch = returnOffset >= 0
          && afterBlock.slice(returnOffset + 1).some((e) =>
            e.actor_type === "controller_ai"
            && /^controller_dispatch(?:_[a-z0-9_]+)?$/i.test(e.event_type));
        // A real user may order a blocked task back to its original developer.
        // Require both server-committed transitions and that actor's latest formal claim.
        const userRequeueIndex = afterBlock.findLastIndex((e) =>
          e.event_type === "developer_user_directed_bugfix_requeue"
          && e.actor_type === "developer_ai"
          && e.actor_id === currentClaim?.actor_id && e.session_id === currentClaim?.session_id
          && e.old_status === "HOLD" && e.new_status === "测试失败待修复");
        const userAuthorizedReturn = userRequeueIndex >= 0
          && afterBlock.slice(0, userRequeueIndex).some((e) =>
            e.event_type === "developer_user_directed_bugfix_hold"
            && e.actor_type === "developer_ai"
            && e.actor_id === currentClaim?.actor_id && e.session_id === currentClaim?.session_id
            && e.old_status === "阻断" && e.new_status === "HOLD");
        const validBlockedReturn = blockedIndex === latestQaResultIndex
          && blockedIndex >= 0 && currentClaimIndex > blockedIndex
          && blockedQaClaim?.actor_id === blocked?.actor_id
          && blockedQaClaim?.session_id === blocked?.session_id
          && currentClaim?.old_status === "测试失败待修复"
          && (hasFreshDispatch || userAuthorizedReturn)
          && state.records.some((r) =>
            r.stepId === "Q02_TEST" && r.result === "BLOCK" && r.attempt === state.attempts);
        if (currentClaim?.event_id === eventId
          && (currentClaim.actor_id !== actorId || currentClaim.session_id !== sessionId)) {
          throw invalid("CHECKPOINT_SESSION_MISMATCH", "旧开发Session不能复用最新正式认领事件", 403);
        }
        const previouslyStarted = state.records.some((record) =>
          record.stepId === "D01_CLAIM" && record.result === "PASS");
        const alreadyRestarted = state.records.some((record) =>
          record.stepId === "D01_CLAIM" && record.eventId === currentClaim?.event_id);
        // A finished QA round can be followed by a real controller requeue and an authorized developer takeover.
        const priorDevIndex = history.findLastIndex((entry, i) => i < currentClaimIndex
          && entry.event_type === "claim" && entry.actor_type === "developer_ai"
          && entry.old_status === "待开发" && entry.new_status === "开发中");
        const requeueIndex = history.findLastIndex((entry, i) => i < priorDevIndex
          && entry.event_type === "controller_rework_requeue" && entry.actor_type === "controller_ai");
        const requeue = history[requeueIndex];
        const priorDev = history[priorDevIndex];
        const qaIndex = history.findLastIndex((e,i) => i < requeueIndex
          && e.event_type === "test_result" && e.actor_type === "test_ai"
          && e.metadata?.atomicLifecycle === true && e.metadata?.testResult === "pass"
          && e.old_status === "独测中" && e.new_status === "待交付");
        q04RequeuedTakeover = modern && state.cursors.developer_ai === null
          && qaIndex >= 0
          && history.findLastIndex(e => e.event_type === "test_result" && e.actor_type === "test_ai") === qaIndex
          && state.records.some((r) => r.stepId === "Q04_NEXT"
            && r.result === "PASS" && r.attempt === state.attempts)
          && state.records.some((r) => r.stepId === "Q03_RESULT"
            && r.eventId === history[qaIndex].event_id && r.attempt === state.attempts)
          && state.records.some((r) => r.stepId === "D08_HANDOFF"
            && r.result === "PASS" && r.attempt === state.attempts)
          && state.records.some((r) => r.stepId === "Q03_RESULT"
            && r.result === "PASS" && r.verdict === "pass" && r.attempt === state.attempts)
          && requeueIndex >= 0 && priorDevIndex > requeueIndex
          && requeue.old_status === "阻断" && requeue.new_status === "待开发"
          && priorDev?.session_id !== sessionId
          && history.slice(requeueIndex + 1, priorDevIndex).every((e) =>
            !e.old_status || e.old_status === e.new_status)
          && history.slice(priorDevIndex + 1, currentClaimIndex).every((e) =>
            !e.old_status || e.old_status === e.new_status)
          && currentClaim?.event_type === "takeover"
          && currentClaim?.event_id === eventId && currentClaim?.actor_id === actorId
          && currentClaim?.session_id === sessionId
          && currentClaim.old_status === "开发中" && currentClaim.new_status === "开发中"
          && task.status === "开发中" && task.sessionId === sessionId
          && previouslyStarted && !alreadyRestarted
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task);
        if (q04RequeuedTakeover) {
          state.attempts += 1;
          state.cursors.developer_ai = "D01_CLAIM";
          state.cursors.test_ai = "Q01_ADMISSION";
        }
        // Reopen only a new, committed machine recovery after the prior D07 BLOCK.
        if (modern && result === "PASS" && state.cursors.developer_ai === "D07_TEST_3"
          && currentClaim?.event_id === eventId && currentClaim.actor_id === actorId
          && currentClaim.session_id === sessionId && currentClaim.old_status === "待开发"
          && currentClaim.new_status === "开发中" && task.status === "开发中"
          && task.sessionId === sessionId && previouslyStarted && !alreadyRestarted
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task)) {
          const restoredIndex = history.findLastIndex((e, i) => i < currentClaimIndex
            && e.event_type === "auto_unblock" && e.actor_type === "system"
            && e.actor_id === "task-scan" && e.old_status === "阻断" && e.new_status === "待开发");
          const restored = history[restoredIndex];
          const failedBlock = history.find((e) => e.event_id === restored?.metadata?.blockedEventId
            && e.event_type === "developer_d01_reentry_checkpoint_order_blocked");
          const failedClaim = history.find((e) => e.event_id === failedBlock?.metadata?.newClaimEventId
            && e.event_type === "claim" && e.actor_type === "developer_ai");
          const initialUnblock = history.find((e) => e.event_id === failedBlock?.metadata?.autoUnblockEventId);
          const runnerBlock = history.find((e) => e.event_id === initialUnblock?.metadata?.blockedEventId
            && e.event_type === "developer_r3_runner_timeout_blocked");
          const transaction = restored && await this.taskStore.transactions.read(restored.operation_id);
          const oldD07 = state.records.findLast((r) => r.stepId === "D07_TEST_3"
            && r.result === "BLOCK" && r.attempt === state.attempts);
          const controllerReviewed = history.slice(history.indexOf(failedBlock) + 1, restoredIndex)
            .some((e) => e.event_type === "controller_blocker_resolution_plan"
              && e.actor_type === "controller_ai" && e.actor_id && e.session_id);
          if (restored?.operation_id === "auto_unblock." + SHA(projectId + "|" + taskId + "|" + failedBlock?.event_id)
            && transaction?.state === "committed" && transaction.result?.eventId === restored.event_id
            && failedBlock?.old_status === "开发中" && failedBlock.new_status === "阻断"
            && failedBlock.actor_type === "developer_ai" && failedBlock.actor_id === failedClaim?.actor_id
            && failedBlock.session_id === failedClaim?.session_id
            && failedBlock.metadata?.failureStage === "D01_CLAIM"
            && failedBlock.metadata?.failureCode === "CHECKPOINT_STEP_ORDER"
            && failedBlock.metadata?.oldStep === "D07_TEST_3" && failedBlock.metadata?.oldResult === "BLOCK"
            && failedBlock.metadata?.sourceChanges === false && failedBlock.metadata?.codeTouched === false
            && initialUnblock?.event_type === "auto_unblock"
            && initialUnblock.actor_type === "system" && initialUnblock.actor_id === "task-scan"
            && runnerBlock?.metadata?.failureStage === "D07_TEST_3"
            && runnerBlock.metadata?.failureCode === "TEST_RUNNER_30S_SPAWNSYNC_ETIMEDOUT"
            && oldD07?.actorId === runnerBlock.actor_id && oldD07.sessionId === runnerBlock.session_id
            && controllerReviewed && history.indexOf(runnerBlock) < history.indexOf(initialUnblock)
            && history.indexOf(initialUnblock) < history.indexOf(failedClaim)
            && history.indexOf(failedClaim) < history.indexOf(failedBlock)
            && history.indexOf(failedBlock) < restoredIndex && restoredIndex < currentClaimIndex
            && failedClaim.old_status === "待开发" && failedClaim.new_status === "开发中"
            && failedClaim.session_id !== sessionId
            && !history.slice(restoredIndex + 1, currentClaimIndex)
              .some((e) => e.old_status !== e.new_status)) {
            state.attempts += 1;
            state.cursors.developer_ai = "D01_CLAIM";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
        // A completed legacy QA pass can leave D09 as the developer cursor.
        // A new controller dispatch and a genuinely fresh claim start a new attempt.
        if (modern && result === "PASS" && state.cursors.developer_ai === "D09_NEXT"
          && currentClaim?.event_id === eventId && currentClaim?.actor_id === actorId
          && currentClaim?.session_id === sessionId && currentClaim?.old_status === "待开发"
          && currentClaim?.new_status === "开发中" && task.status === "开发中"
          && task.sessionId === sessionId && previouslyStarted && !alreadyRestarted
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task)) {
          const reworkIndex = history.findLastIndex((entry, i) => i < currentClaimIndex
            && ["delivery_merge_conflict_rework", "controller_rework_requeue"].includes(entry.event_type));
          const rework = history[reworkIndex];
          const qaIndex = history.findLastIndex((entry, i) => i < reworkIndex
            && entry.event_type === "test_result" && entry.actor_type === "test_ai");
          const qaPass = history[qaIndex];
          const controllerClaim = history.slice(qaIndex + 1, reworkIndex).findLast((entry) =>
            entry.event_type === "claim" && entry.actor_type === "controller_ai"
            && entry.old_status === "待交付" && entry.new_status === "交付中");
          const oldDevClaim = history.slice(0, qaIndex).findLast((entry) =>
            entry.event_type === "claim" && entry.actor_type === "developer_ai");
          const oldHandoff = history.slice(0, qaIndex).findLast((entry) =>
            entry.event_type === "handoff" && entry.actor_type === "developer_ai");
          const qaClaim = history.slice(0, qaIndex).findLast((entry) =>
            entry.event_type === "claim" && entry.actor_type === "test_ai");
          const meta = rework?.metadata || {};
          const failure = history.slice(qaIndex + 1, reworkIndex).findLast((entry) =>
            entry.event_type === "delivery_attempt_failed"
            && entry.actor_type === "controller_ai"
            && entry.actor_id === (rework?.event_type === "controller_rework_requeue"
              ? controllerClaim?.actor_id : rework?.actor_id)
            && entry.session_id === (rework?.event_type === "controller_rework_requeue"
              ? controllerClaim?.session_id : rework?.session_id)
            && entry.metadata?.failureStage === "merge"
            && entry.metadata?.candidateSha === qaPass?.metadata?.commitSha);
          // Only a verified failed controller merge may requeue a blocked D09 task to fresh D01.
          const conflictBlocked = history.slice(qaIndex + 1, reworkIndex).findLast((e) =>
            e.event_type === "controller_c04_candidate_new_main_merge_conflict"
            && e.actor_type === "controller_ai" && e.old_status === "交付中"
            && e.new_status === "阻断" && e.metadata?.failureEventId === failure?.event_id
            && e.metadata?.failureCode === "GIT_MERGE_CONFLICT"
            && e.metadata?.candidateSha === qaPass?.metadata?.commitSha
            && e.actor_id === controllerClaim?.actor_id && e.session_id === controllerClaim?.session_id);
          const ready = conflictBlocked && history.slice(history.indexOf(conflictBlocked) + 1, reworkIndex)
            .findLast((e) => e.event_type === "controller_rework_ready"
              && e.actor_type === "controller_ai" && e.actor_id === rework?.actor_id
              && e.session_id === rework?.session_id && e.old_status === "阻断"
              && e.new_status === "阻断");
          if (rework?.event_type === "controller_rework_requeue"
            && rework.old_status === "阻断" && rework.new_status === "待开发"
            && rework.actor_type === "controller_ai" && rework.actor_id && rework.session_id
            && meta.requiresIndependentRetest === true && meta.reasonCode === "GIT_MERGE_CONFLICT"
            && meta.priorCandidateSha === qaPass?.metadata?.commitSha
            && /^[a-f0-9]{40}$/i.test(String(qaPass?.metadata?.commitSha || ""))
            && qaPass?.metadata?.atomicLifecycle === true && qaPass.metadata.testResult === "pass"
            && qaPass.old_status === "独测中" && qaPass.new_status === "待交付"
            && Boolean(String(qaPass.metadata.reportPath || "").trim())
            && qaPass.actor_id === qaClaim?.actor_id && qaPass.session_id === qaClaim?.session_id
            && history.findLastIndex((e) => e.event_type === "test_result"
              && e.actor_type === "test_ai") === qaIndex
            && oldDevClaim?.actor_id === oldHandoff?.actor_id
            && oldDevClaim?.session_id === oldHandoff?.session_id
            && oldDevClaim?.session_id !== sessionId
            && history.indexOf(oldHandoff) > history.indexOf(oldDevClaim)
            && controllerClaim?.actor_id === failure?.actor_id
            && controllerClaim?.session_id === failure?.session_id
            && failure?.metadata?.failureStage === "merge"
            && failure?.metadata?.failureCode === "GIT_MERGE_CONFLICT"
            && failure?.metadata?.candidateSha === qaPass.metadata.commitSha
            && history.indexOf(failure) < history.indexOf(conflictBlocked)
            && conflictBlocked && ready && reworkIndex > history.indexOf(ready)
            && !history.slice(reworkIndex + 1, currentClaimIndex)
              .some((e) => e.old_status && e.new_status && e.old_status !== e.new_status)
            && state.records.some((e) => e.attempt === state.attempts
              && e.stepId === "D08_HANDOFF" && e.result === "PASS")
            && state.records.some((e) => e.attempt === state.attempts
              && e.stepId === "Q03_RESULT" && e.result === "PASS" && e.verdict === "pass")) {
            state.attempts += 1;
            state.cursors.developer_ai = "D01_CLAIM";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
          if (rework?.old_status === "交付中" && rework.new_status === "待开发"
            && rework.actor_type === "controller_ai" && controllerClaim
            && controllerClaim.actor_id === rework.actor_id
            && controllerClaim.session_id === rework.session_id
            && meta.mergeConflictVerified === true && meta.invalidatesTestEvidence === true
            && meta.requiresIndependentRetest === true
            && meta.independentPassEventId === qaPass?.event_id
            && Boolean(failure?.event_id) && meta.deliveryFailureEventId === failure.event_id
            && /^[a-f0-9]{40}$/i.test(String(qaPass?.metadata?.commitSha || ""))
            && meta.candidateSha === qaPass?.metadata?.commitSha
            && Boolean(String(qaPass?.metadata?.reportPath || "").trim())
            && meta.originalControllerActorId === rework.actor_id
            && meta.originalControllerSessionId === rework.session_id
            && meta.originalDeveloperActorId === actorId
            && meta.originalDeveloperSessionId === oldDevClaim?.session_id
            && meta.originalDeveloperSessionId !== sessionId
            && oldDevClaim?.actor_id === actorId && oldHandoff?.actor_id === actorId
            && oldHandoff?.session_id === oldDevClaim?.session_id
            && history.indexOf(oldHandoff) > history.indexOf(oldDevClaim)
            && qaPass?.metadata?.atomicLifecycle === true
            && qaPass.metadata.testResult === "pass" && qaPass.old_status === "独测中"
            && qaPass.new_status === "待交付" && qaPass.actor_id === qaClaim?.actor_id
            && qaPass.session_id === qaClaim?.session_id
            && history.findLastIndex((entry) => entry.event_type === "test_result"
              && entry.actor_type === "test_ai") === qaIndex
            && state.records.some((entry) => entry.attempt === state.attempts
              && entry.stepId === "D08_HANDOFF" && entry.result === "PASS")
            && state.records.some((entry) => entry.attempt === state.attempts
              && entry.stepId === "Q03_RESULT" && entry.result === "PASS"
              && entry.verdict === "pass")) {
            state.attempts += 1;
            state.cursors.developer_ai = "D01_CLAIM";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
        if (!modern && result === "PASS" && state.cursors.developer_ai === "D09_MERGE_MAIN"
          && currentClaim?.event_id === eventId && currentClaim?.actor_id === actorId
          && currentClaim?.session_id === sessionId && currentClaim?.old_status === "待开发"
          && currentClaim?.new_status === "开发中" && task.status === "开发中"
          && task.sessionId === sessionId && !alreadyRestarted && previouslyStarted
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task)) {
          const oldClaim = history.slice(0, currentClaimIndex).findLast((entry) =>
            entry.actor_type === "developer_ai" && ["claim", "takeover"].includes(entry.event_type));
          const qaResultIndex = history.findLastIndex((entry, index) => index < currentClaimIndex
            && entry.event_type === "test_result" && entry.actor_type === "test_ai");
          const qaResult = history[qaResultIndex];
          const dispatchIndex = history.findLastIndex((entry, index) => index < currentClaimIndex
            && entry.actor_type === "controller_ai"
            && /^controller_dispatch(?:_[a-z0-9_]+)?$/i.test(entry.event_type));
          const previousPass = state.records.some((r) => r.attempt === state.attempts
            && r.stepId === "D08_HANDOFF" && r.result === "PASS")
            && state.records.some((r) => r.attempt === state.attempts
              && r.stepId === "Q03_RESULT" && r.result === "PASS" && r.verdict === "pass");
          if (oldClaim && oldClaim.actor_id !== actorId && oldClaim.session_id !== sessionId
            && previousPass && qaResult?.metadata?.atomicLifecycle === true
            && qaResult.metadata.testResult === "pass"
            && dispatchIndex > qaResultIndex && qaResultIndex > history.indexOf(oldClaim)) {
            state.attempts += 1;
            state.cursors.developer_ai = "D01_CLAIM";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
        if ((validFailure || validBlockedReturn) && previouslyStarted && !alreadyRestarted
          && currentClaimIndex > (validBlockedReturn ? blockedIndex : lastFailIndex) && currentClaim?.event_id === eventId
          && currentClaim?.actor_id === actorId && currentClaim?.session_id === sessionId
          && task.status === "修复中" && task.sessionId === sessionId
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested) {
          if (await hardDependenciesCompleted(this.taskStore, projectId, task)) {
            if (state.records.some((entry) => entry.attempt === state.attempts)) state.attempts += 1;
            state.cursors.developer_ai = "D01_CLAIM";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
      }
      let resumedQaAttempt = false;
      if (actorType === "test_ai" && stepId === "Q01_ADMISSION" && result === "PASS"
        && state.cursors.test_ai !== "Q01_ADMISSION") {
        const qaIndex = history.findLastIndex((e) => e.actor_type === "test_ai"
          && ["claim", "takeover"].includes(e.event_type));
        const qaClaim = history[qaIndex];
        if (qaClaim && (qaClaim.actor_id !== actorId || qaClaim.session_id !== sessionId))
          throw invalid("CHECKPOINT_SESSION_MISMATCH", "旧独测Session不得重开Q01", 403);
        const verdictIndex = history.findLastIndex((e, i) => i < qaIndex
          && e.actor_type === "test_ai" && e.event_type === "test_result"
          && e.metadata?.atomicLifecycle === true
          && ["blocked", "fail", "pass"].includes(e.metadata?.testResult));
        const verdict = history[verdictIndex];
        const formerQA = verdictIndex >= 0 && [...history.slice(0, verdictIndex)].reverse().find(
          (e) => e.actor_type === "test_ai" && ["claim", "takeover"].includes(e.event_type));
        const between = history.slice(verdictIndex + 1, qaIndex);
        const restored = between.some((e) => e.actor_type === "controller_ai"
          && typeof e.event_type === "string" && e.event_type.startsWith("controller_")
          && e.old_status === "阻断" && e.new_status === "待复测");
        const failedDelivery = between.some((e) => typeof e.event_type === "string" && e.event_type.startsWith("controller_")
          && ["待交付", "交付中"].includes(e.old_status) && e.new_status === "阻断");
        const repair = [...between].reverse().find((e) => e.actor_type === "developer_ai"
          && e.event_type === "handoff" && e.old_status === "修复中"
          && e.new_status === "待复测" && e.metadata?.atomicLifecycle === true);
        const repairIndex = repair ? history.indexOf(repair) : -1;
        const repairClaim = repairIndex >= 0 && [...history.slice(0, repairIndex)].reverse().find(
          (e) => e.actor_type === "developer_ai" && ["claim", "takeover"].includes(e.event_type));
        const oldSha = String(verdict?.metadata?.commitSha || "");
        const repairedSha = String(repair?.metadata?.commitSha || "");
        const changedSha = !(/^[a-f0-9]{40}$/i.test(oldSha) && /^[a-f0-9]{40}$/i.test(repairedSha)
          && oldSha.toLowerCase() === repairedSha.toLowerCase());
        const genuineRepair = repair && repairClaim && changedSha
          && repair.actor_id === repairClaim.actor_id && repair.session_id === repairClaim.session_id;
        // The old Q04 PASS can be followed by a genuinely new development candidate.
        const candidateSha = (entry) => String(entry?.metadata?.commitSha
          || String(entry?.note || "").match(/候选\s*([a-f0-9]{40})/i)?.[1] || "").toLowerCase();
        const formerPassIndex = history.findLastIndex((e, i) => i < qaIndex
          && e.event_type === "test_result" && e.actor_type === "test_ai"
          && e.metadata?.atomicLifecycle === true && e.metadata?.testResult === "pass"
          && /^[a-f0-9]{40}$/.test(candidateSha(e)));
        const handoffIndex = history.findLastIndex((e, i) => i > formerPassIndex && i < qaIndex
          && e.event_type === "handoff" && e.actor_type === "developer_ai"
          && e.old_status === "开发中" && e.new_status === "待独测"
          && e.metadata?.atomicLifecycle === true);
        const newHandoff = history[handoffIndex];
        const devEvents = history.slice(formerPassIndex + 1, handoffIndex);
        const developerClaim = devEvents.findLast((e) => e.actor_type === "developer_ai"
          && ["claim", "takeover"].includes(e.event_type)
          && e.actor_id === newHandoff?.actor_id && e.session_id === newHandoff?.session_id
          && e.new_status === "开发中");
        const developerPass = devEvents.findLast((e) => e.event_type === "test_result"
          && e.actor_type === "developer_ai" && e.metadata?.testResult === "pass"
          && e.metadata?.reportPath && e.actor_id === newHandoff?.actor_id
          && e.session_id === newHandoff?.session_id);
        const newSha = candidateSha(newHandoff);
        const newCandidateRestart = formerPassIndex >= 0 && handoffIndex > formerPassIndex
          && developerClaim && developerPass && newHandoff
          && /^[a-f0-9]{40}$/.test(newSha)
          && newSha === candidateSha(developerPass)
          && newSha !== candidateSha(history[formerPassIndex])
          && devEvents.indexOf(developerClaim) < devEvents.indexOf(developerPass)
          && !devEvents.some((e) => e.event_type === "test_result"
            && e.actor_type === "test_ai" && e.metadata?.testResult === "fail")
          && state.records.some((r) => r.stepId === "Q04_NEXT" && r.result === "PASS"
            && r.attempt === state.attempts);
        const validRestart = (verdict?.metadata?.testResult === "blocked"
            && verdict.new_status === "阻断" && restored)
          || (verdict?.metadata?.testResult === "pass" && verdict.new_status === "待交付"
            && failedDelivery && restored)
          || (["blocked", "fail"].includes(verdict?.metadata?.testResult) && genuineRepair);
        if (qaClaim?.event_id === eventId && qaClaim.actor_id === actorId
          && qaClaim.session_id === sessionId
          && ((qaClaim.old_status === "待复测" && qaClaim.new_status === "复测中"
              && task.status === "复测中" && validRestart)
            || (qaClaim.old_status === "待独测" && qaClaim.new_status === "独测中"
              && task.status === "独测中" && newCandidateRestart))
          && task.sessionId === sessionId && formerQA
          && formerQA.actor_id === verdict?.actor_id && formerQA.session_id === verdict?.session_id
          && state.records.some((r) => r.stepId === "Q01_ADMISSION"
            && r.result === "PASS" && r.attempt === state.attempts)
          && !(await this.taskStore.stopState(projectId, taskId)).stopRequested
          && await hardDependenciesCompleted(this.taskStore, projectId, task)) {
          state.attempts += 1;
          state.cursors.test_ai = "Q01_ADMISSION";
          resumedQaAttempt = true;
        }
      }
      if (state.cursors[actorType] !== stepId && !optionalEnvironment) {
        throw invalid("CHECKPOINT_STEP_ORDER", "上一步尚未通过，不得越级执行；请先读取唯一下一步");
      }
      const authority = [...history].reverse().find((entry) =>
        entry.actor_type === actorType && ["claim", "takeover"].includes(entry.event_type));
      const lastTakeover = [...history].reverse().find((entry) =>
        entry.actor_type === actorType && entry.event_type === "takeover");
      // A takeover invalidates the former actor/Session even if its old claim is still in history.
      if (lastTakeover && (authority?.actor_id !== actorId || authority?.session_id !== sessionId)) {
        throw invalid("CHECKPOINT_SESSION_MISMATCH", "接管后旧actor或Session已失去步骤写入权", 403);
      }
      if (actorType === "test_ai" && stepId === "Q01_ADMISSION" && authority
        && (authority.actor_id !== actorId || authority.session_id !== sessionId)) {
        throw invalid("CHECKPOINT_SESSION_MISMATCH", "独测必须由最新正式认领会话执行", 403);
      }
      if (actorType === "test_ai" && stepId === "Q01_ADMISSION" && result === "PASS" && !eventId
        && !state.records.some((entry) => entry.stepId === "D08_HANDOFF"
          && entry.result === "PASS" && entry.attempt === state.attempts)) {
        throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "开发尚未正式交独测");
      }
      const [index] = [steps.indexOf(stepId)];
      if (actorType === "developer_ai" && stepId === "D01_CLAIM"
        && state.cursors.controller_ai !== null) {
        const authorityIndex = history.findIndex((entry) =>
          entry.event_id === eventId && ["claim", "takeover"].includes(entry.event_type)
          && entry.actor_type === "developer_ai" && entry.actor_id === actorId
          && entry.session_id === sessionId);
        const authorityEvent = history[authorityIndex];
        const priorDeveloperIndex = history.findLastIndex((entry, index) =>
          index < authorityIndex && entry.actor_type === "developer_ai"
          && ["claim", "takeover"].includes(entry.event_type));
        const dispatchIndex = history.findLastIndex((entry, index) =>
          index < authorityIndex && entry.actor_type === "controller_ai"
          && /^controller_dispatch(?:_[a-z0-9_]+)?$/i.test(entry.event_type));
        let authorizedTakeover = authorityEvent?.event_type !== "takeover";
        if (authorityEvent?.event_type === "takeover") {
          const allowedIndex = history.findIndex((entry, index) =>
            index > dispatchIndex && index < authorityIndex
            && entry.event_type === "takeover_allowed"
            && entry.operation_id === authorityEvent.metadata?.authorizationOperationId
            && entry.actor_type === "developer_ai" && entry.actor_id === actorId
            && entry.session_id === sessionId
            && entry.metadata?.explicitUserOverride === true
            && entry.metadata?.authorizationSource === "chat_user_instruction_cooperative"
            && ["task", "project"].includes(entry.metadata?.authorizationScope)
            && entry.metadata?.authorizationForwardedBy === actorId
            && entry.metadata?.authorizationForwardingSessionId === sessionId
            && entry.metadata?.authorizedFromSessionId === authorityEvent.metadata?.previousSessionId
            && entry.metadata?.authorizedFromStatus === authorityEvent.old_status);
          const authorization = history[allowedIndex];
          const suspicionIndex = history.findIndex((entry, index) =>
            index > priorDeveloperIndex && index < allowedIndex
            && entry.event_type === "suspected_disconnect"
            && entry.operation_id === authorization?.metadata?.suspicionOperationId
            && entry.actor_type === "developer_ai" && entry.actor_id === actorId
            && entry.session_id === sessionId);
          const revoked = history.slice(allowedIndex + 1, authorityIndex).some((entry) =>
            entry.event_type === "takeover_revoked");
          authorizedTakeover = priorDeveloperIndex >= 0 && allowedIndex >= 0
            && suspicionIndex >= 0 && !revoked
            && String(authorization?.metadata?.authorizationQuote || "").trim().length > 0
            && (dispatchIndex > priorDeveloperIndex || q04RequeuedTakeover)
            && history[priorDeveloperIndex].session_id === authorityEvent.metadata?.previousSessionId
            && authorityEvent.old_status === authorityEvent.new_status
            && ["开发中", "修复中"].includes(authorityEvent.old_status);
        }
        const machineReady = authorityEvent?.event_type === "claim"
          && await committedAutoPreparation(this.taskStore, projectId, taskId, history, authorityIndex);
        if (authorityEvent?.event_id !== currentClaim?.event_id
          || (dispatchIndex < 0 && !machineReady) || !authorizedTakeover || task.sessionId !== sessionId
          || !["开发中", "修复中"].includes(task.status)
          || (await this.taskStore.stopState(projectId, taskId)).stopRequested
          || !(await hardDependenciesCompleted(this.taskStore, projectId, task))) {
          throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "总控未完成可信正式派工");
        }
      }
      if (!modern && actorType === "developer_ai" && stepId === "D09_MERGE_MAIN"
        && (!state.records.some((r) => r.stepId === "Q03_RESULT" && r.result === "PASS"
          && r.verdict === "pass" && r.attempt === state.attempts)
        || state.cursors.test_ai !== null)) {
        throw invalid("CHECKPOINT_QA_PASS_REQUIRED", "最新一次独测没有正式PASS");
      }
      if (!modern && actorType === "developer_ai" && stepId === "D12_COMPLETE"
        && !state.records.some((r) => r.stepId === "D11_CLEANUP" && r.result === "PASS"
          && r.attempt === state.attempts)) {
        throw invalid("CHECKPOINT_CLEANUP_REQUIRED", "清理未完成不能关闭任务");
      }
      if (actorType !== "controller_ai" && !["D01_CLAIM","Q01_ADMISSION"].includes(stepId)
        && (!authority || authority.actor_id !== actorId || authority.session_id !== sessionId)) {
        throw invalid("CHECKPOINT_SESSION_MISMATCH", "未用当前正式认领身份写断点", 403);
      }
      if (actorType === "controller_ai" && stepId !== (modern ? "C00_A_REQUIREMENTS" : "C01_SCAN")) {
        const firstStep = modern ? "C00_A_REQUIREMENTS" : "C01_SCAN";
        const controllerStart = state.records.find((entry) =>
          entry.stepId === firstStep && entry.result === "PASS" && entry.attempt === state.attempts);
        if (!controllerStart || (!lastTakeover && (controllerStart.actorId !== actorId || controllerStart.sessionId !== sessionId))) {
          throw invalid("CHECKPOINT_SESSION_MISMATCH", "总控换窗口须先进行合法接管", 403);
        }
      }
      if (modern && actorType === "controller_ai" && stepId === "C04_MERGE_MAIN" && result === "PASS") {
        const deliveryClaim = [...history].reverse().find((entry) =>
          entry.event_type === "claim" && entry.actor_type === "controller_ai"
          && entry.new_status === "交付中");
        const qaPass = history.findLast((entry) =>
          entry.event_type === "test_result" && entry.actor_type === "test_ai"
          && entry.metadata?.testResult === "pass");
        if (!deliveryClaim || !qaPass || history.indexOf(qaPass) >= history.indexOf(deliveryClaim)
          || deliveryClaim.actor_id !== actorId || deliveryClaim.session_id !== sessionId
          || task.status !== "交付中") {
          throw invalid("CHECKPOINT_QA_PASS_REQUIRED", "交付步骤需要最新可信独测PASS及当前总控正式认领");
        }
      }
      const required = EVENT_REQUIRED[stepId] || [];
      const event = eventId ? history.find((x) => x.event_id === eventId) : null;
      if (modern && actorType === "controller_ai" && result === "PASS" && C00_EVENTS[stepId]) {
        const preceding = state.records.findLast((entry) =>
          entry.actorType === "controller_ai" && entry.result === "PASS"
            && entry.attempt === state.attempts && C00_EVENTS[entry.stepId]);
        if (!event || event.event_type !== C00_EVENTS[stepId] || event.actor_type !== actorType
          || event.actor_id !== actorId || event.session_id !== sessionId
          || state.records.some((entry) => entry.eventId === eventId)
          || (preceding && Date.parse(event.timestamp) < Date.parse(preceding.at))
          || !validC00Evidence(stepId, event.metadata)) {
          throw invalid("CHECKPOINT_C00_EVIDENCE_REQUIRED", "C00缺少本轮同一总控Session的可信核验事件和结构化结果");
        }
      }
      if (result === "PASS" && required.length && (!event || !required.includes(event.event_type)
        || event.actor_type !== actorType || event.actor_id !== actorId
        || (event.session_id && event.session_id !== sessionId))) {
        throw invalid("CHECKPOINT_FORMAL_EVENT_REQUIRED", "必须关联当前角色已发生的真实正式任务事件");
      }
      if (result === "PASS" && stepId === "D01_CLAIM" && !["开发中", "修复中", "交付中"].includes(event?.new_status)) {
        throw invalid("CHECKPOINT_FORMAL_EVENT_REQUIRED", "开发正式认领事件阶段错误");
      }
      if (result === "PASS" && stepId === "Q01_ADMISSION"
        && (!["独测中", "复测中"].includes(event?.new_status)
          || (authority && event?.event_id !== authority.event_id))) {
        throw invalid("CHECKPOINT_FORMAL_EVENT_REQUIRED", "独测准入必须关联最新有效认领事件");
      }
      if (result === "PASS" && stepId === "Q01_ADMISSION" && task.status === "复测中") {
        const claimIndex = history.indexOf(event);
        const failIndex = history.findLastIndex((entry, index) => index < claimIndex
          && entry.event_type === "test_result" && entry.actor_type === "test_ai"
          && entry.metadata?.atomicLifecycle === true && entry.metadata?.testResult === "fail"
          && entry.new_status === "测试失败待修复");
        if (failIndex >= 0) {
          const repaired = [...history.slice(failIndex + 1, claimIndex)].reverse().find((entry) =>
            entry.event_type === "handoff" && entry.actor_type === "developer_ai"
            && entry.metadata?.atomicLifecycle === true && entry.new_status === "待复测");
          if (!repaired) throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "旧独测FAIL后缺少真实修复交接");
          const priorHandoff = [...history.slice(0, failIndex)].reverse().find((entry) =>
            entry.event_type === "handoff" && entry.actor_type === "developer_ai");
          const oldSha = String(history[failIndex].metadata?.commitSha || priorHandoff?.metadata?.commitSha || "");
          const newSha = String(repaired.metadata?.commitSha || "");
          if (/^[a-f0-9]{40}$/i.test(oldSha) && /^[a-f0-9]{40}$/i.test(newSha)
            && oldSha.toLowerCase() === newSha.toLowerCase()) {
            throw invalid("CHECKPOINT_CANDIDATE_UNCHANGED", "独测FAIL后未更换候选Git SHA");
          }
        }
      }
      if (result === "PASS" && stepId === "D08_HANDOFF" && !["待独测", "待复测"].includes(event?.new_status)) {
        throw invalid("CHECKPOINT_FORMAL_EVENT_REQUIRED", "未真实进入独测队列");
      }
      if (result === "PASS" && stepId === "Q03_RESULT" && !["pass", "fail", "blocked"].includes(event?.metadata?.testResult)) {
        throw invalid("CHECKPOINT_QA_RESULT_INVALID", "独测正式事件缺少真实判定");
      }
      if (result === "PASS" && ["D12_COMPLETE", "C07_COMPLETE"].includes(stepId)
        && !["已完成", "待用户验收"].includes(event?.new_status)) {
        throw invalid("CHECKPOINT_DELIVERY_NOT_CLOSED", "任务未在真实看板关闭");
      }
      if (result === "PASS" && stepId === "Q01_ADMISSION"
        && !resumedQaAttempt
        && !state.records.some((r) => r.stepId === "D08_HANDOFF" && r.result === "PASS"
          && r.attempt === state.attempts)) {
        // The formal handoff may have released the developer before D08 could be saved.
        // Recover only from an authentic handoff preceding this QA claim, never from a note.
        const handoff = [...history].reverse().find((entry) => entry.event_type === "handoff");
        const handoffIndex = history.indexOf(handoff);
        const devAuthority = history.slice(0, handoffIndex).reverse().find((entry) =>
          entry.actor_type === "developer_ai" && ["claim", "takeover"].includes(entry.event_type));
        const qaClaimIndex = history.indexOf(event);
        const recordedSteps = state.records.filter((entry) => entry.actorType === "developer_ai"
          && entry.attempt === state.attempts);
        const legacyEmpty = state.cursors.developer_ai === "D01_CLAIM" && recordedSteps.length === 0
          && state.records.every((entry) => entry.actorType === "test_ai"
            && entry.stepId === "Q01_ADMISSION" && entry.result === "FAIL");
        const intervening = history.slice(handoffIndex + 1, qaClaimIndex);
        const superseded = intervening.some((entry, index) =>
          (entry.event_type === "test_result" &&
            (entry.metadata?.testResult !== "blocked"
              || !intervening.slice(index + 1).some((later) =>
                later.actor_type === "controller_ai" && later.old_status === "阻断"
                  && later.new_status === "待复测")))
          || (entry.actor_type === "developer_ai"
            && ["claim", "takeover"].includes(entry.event_type)));
        if ((!legacyEmpty && state.cursors.developer_ai !== "D08_HANDOFF") || !handoff || handoffIndex < 0
          || !devAuthority || !event || !["claim", "takeover"].includes(event.event_type)
          || event.actor_type !== "test_ai" || event.actor_id !== actorId
          || event.session_id !== sessionId || qaClaimIndex <= handoffIndex
          || !["待独测", "待复测"].includes(handoff.new_status)
          || handoff.metadata?.atomicLifecycle !== true
          || handoff.metadata?.handoffTarget !== handoff.new_status
          || handoff.actor_type !== "developer_ai"
          || handoff.actor_id !== devAuthority.actor_id
          || handoff.session_id !== devAuthority.session_id
          || superseded) {
          throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "缺少本轮可信正式开发交接事件，不能进入独测");
        }
        const recovered = {
          operationId: "recovered." + handoff.event_id,
          stepId: legacyEmpty ? "HISTORICAL_HANDOFF" : "D08_HANDOFF", actorType: "developer_ai",
          actorId: handoff.actor_id, sessionId: handoff.session_id,
          result: legacyEmpty ? "RECOVERED" : "PASS", substepId: null, attempt: state.attempts,
          at: new Date().toISOString(),
          evidence: "基于已发生的正式handoff事件恢复缺失断点",
          eventId: handoff.event_id, verdict: null,
          note: legacyEmpty
            ? "历史空断点仅登记可信交接，不补造D01-D08的开发步骤PASS"
            : "历史事件投影恢复，原开发会话不获得新的执行权"
        };
        state.records.push(recovered);
        if (!legacyEmpty) {
          state.cursors.developer_ai = FLOW_STEPS[state.flowVersion].developer_ai[
            FLOW_STEPS[state.flowVersion].developer_ai.indexOf("D08_HANDOFF") + 1];
        }
      }
      const item = {
        operationId, stepId, actorType, actorId, sessionId, result, substepId,
        attempt: state.attempts, at: new Date().toISOString(), evidence: evidence.trim(),
        eventId: eventId || null, verdict: stepId === "Q03_RESULT" && result === "PASS" ? event.metadata.testResult : null,
        note: String(note || "").slice(0, 1000)
      };
      state.records.push(item);
      state.lastAction = item;
      if (result === "PASS") {
        state.cursors[actorType] = optionalEnvironment ||
          (modern && stepId === "C00_C_SAFE_CLEANUP") ? "C01_SCAN" : (steps[index + 1] || null);
        if (modern && stepId === "C03_DISPATCH") {
          state.cursors.controller_ai = ["待交付", "交付中"].includes(task.status)
            ? "C04_MERGE_MAIN" : "C08_NEXT";
        }
        if (stepId === "Q04_NEXT") {
          const lastVerdict = [...state.records].reverse().find((r) => r.stepId === "Q03_RESULT" && r.attempt === state.attempts);
          if (lastVerdict && lastVerdict.verdict !== "pass") {
            state.attempts += 1;
            state.cursors.developer_ai = "D04_IMPLEMENT";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
      }
      const absoluteFile = await this.location(projectId, taskId);
      const original = await fs.readFile(absoluteFile, "utf8").catch((e) => e.code === "ENOENT" ? "" : Promise.reject(e));
      const nextText = renderCheckpoint(original, state);
      const reportPhase = result === "PROGRESS"
        ? (substepId?.startsWith("START_") ? "started" : "progress")
        : result === "PASS" ? "complete" : "exception";
      const reportDigest = SHA(nextText);
      // The event records the attempt; only a matching checkpoint SHA confirms persistence.
      const report = await this.taskStore.appendTaskEvent(projectId, taskId, {
        operationId: "step.report." + operationId,
        eventType: "step_report_" + reportPhase, actorType, actorId, sessionId,
        note: "步骤证据已登记；聊天送达状态未知",
        metadata: {
          stepId, result, substepId, attempt: item.attempt, stepOperationId: operationId,
          priorCheckpointSha256: previous.sha256, expectedCheckpointSha256: reportDigest,
          evidenceSha256: SHA(item.evidence), chatDeliveryStatus: "unknown"
        }
      });
      if (report.event.event_type !== "step_report_" + reportPhase
        || report.event.actor_id !== actorId || report.event.session_id !== sessionId
        || report.event.metadata?.stepOperationId !== operationId
        || report.event.metadata?.expectedCheckpointSha256 !== reportDigest
        || report.event.metadata?.evidenceSha256 !== SHA(item.evidence)) {
        throw invalid("CHECKPOINT_REPORT_CONFLICT", "步骤证据事件与实际断点操作不匹配");
      }
      await writeFileAtomically(absoluteFile, nextText);
      const reread = await this.show(projectId, taskId);
      if (reread.state.lastAction?.operationId !== operationId || reread.sha256 !== reportDigest) {
        throw invalid("CHECKPOINT_PERSIST_FAILED", "断点写入后核验失败");
      }
      return { ...reread, reportEventId: report.event.event_id, duplicate: false };
    });
  }
}
