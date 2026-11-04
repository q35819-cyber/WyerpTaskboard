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
      if (stepId === "D01_CLAIM" && state.cursors.developer_ai !== "D01_CLAIM") {
        const lastFailIndex = history.findLastIndex((entry) =>
          entry.event_type === "test_result" && entry.actor_type === "test_ai"
          && entry.metadata?.atomicLifecycle === true && entry.metadata?.testResult === "fail"
          && ["独测中", "复测中"].includes(entry.old_status)
          && entry.new_status === "测试失败待修复");
        const failed = history[lastFailIndex];
        const latestQAClaim = lastFailIndex >= 0 && [...history.slice(0, lastFailIndex)].reverse().find((entry) =>
          entry.actor_type === "test_ai" && ["claim", "takeover"].includes(entry.event_type));
        const validFailure = failed && ["独测中", "复测中"].includes(failed.old_status)
          && failed.new_status === "测试失败待修复" && failed.metadata?.reportPath
          && latestQAClaim?.actor_id === failed.actor_id
          && latestQAClaim?.session_id === failed.session_id;
        const previouslyStarted = state.records.some((record) =>
          record.stepId === "D01_CLAIM" && record.result === "PASS");
        const alreadyRestarted = state.records.some((record) =>
          record.stepId === "D01_CLAIM" && record.eventId === currentClaim?.event_id);
        if (validFailure && previouslyStarted && !alreadyRestarted
          && currentClaimIndex > lastFailIndex && currentClaim?.event_id === eventId
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
        const claimIndex = history.findIndex((entry) =>
          entry.event_id === eventId && entry.event_type === "claim"
          && entry.actor_type === "developer_ai" && entry.actor_id === actorId
          && entry.session_id === sessionId);
        const dispatch = history.slice(0, Math.max(0, claimIndex)).some((entry) =>
          entry.actor_type === "controller_ai" && /^controller_dispatch(?:_[a-z0-9_]+)?$/i.test(entry.event_type));
        if (!dispatch || task.sessionId !== sessionId
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
      await writeFileAtomically(absoluteFile, nextText);
      const reread = await this.show(projectId, taskId);
      if (reread.state.lastAction?.operationId !== operationId) {
        throw invalid("CHECKPOINT_PERSIST_FAILED", "断点写入后核验失败");
      }
      return { ...reread, duplicate: false };
    });
  }

  async assertFormalTransition(projectId, taskId, { eventType, actorType, actorId, sessionId } = {}) {
    const required = eventType === "claim" && actorType === "developer_ai"
      ? { step: "C03_DISPATCH", role: "controller_ai" }
      : eventType === "handoff" && actorType === "developer_ai"
        ? { step: "D07_TEST_3", role: "developer_ai" }
        : eventType === "test_result" && actorType === "test_ai"
          ? { step: "Q02_TEST", role: "test_ai" }
          : eventType === "delivery_complete" && actorType === "controller_ai"
            ? { step: "C06_CLEANUP", role: "controller_ai" }
            : null;
    if (!required) return;
    const { exists, legacy, state } = await this.show(projectId, taskId);
    // Plain-text legacy checkpoints retain existing formal-event gates until migrated.
    if (!exists || legacy || state.flowVersion !== "role-steps-v2") return;
    const proof = state.records.findLast((item) => item.attempt === state.attempts
      && item.stepId === required.step && item.actorType === required.role
      && (required.step === "Q02_TEST" ? ["PASS", "FAIL", "BLOCK"].includes(item.result)
        : item.result === "PASS")
      && (required.role !== actorType || (item.actorId === actorId && item.sessionId === sessionId))
      && (required.step !== "C03_DISPATCH" || item.eventId));
    if (!proof) throw invalid("CHECKPOINT_STEP_EVIDENCE_REQUIRED",
      "正式任务状态推进缺少当前轮次可信步骤证据", 409);
  }
}
