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
const ROLE_STEPS = Object.freeze({
  controller_ai: ["C01_SCAN", "C02_TRIAGE", "C03_DISPATCH", "C04_VERIFY_NEXT"],
  developer_ai: ["D01_CLAIM", "D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3", "D08_HANDOFF", "D09_MERGE_MAIN", "D10_POSTMERGE",
    "D11_CLEANUP", "D12_COMPLETE", "D13_NEXT"],
  test_ai: ["Q01_ADMISSION", "Q02_TEST", "Q03_RESULT", "Q04_NEXT"]
});
const EVENT_REQUIRED = {
  C03_DISPATCH: ["controller_dispatch", "task_created"],
  D01_CLAIM: ["claim"], D08_HANDOFF: ["handoff"],
  D12_COMPLETE: ["delivery_complete"],
  Q01_ADMISSION: ["claim"], Q03_RESULT: ["test_result"]
};
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CLOSED = new Set(["已完成", "已取消"]);
function invalid(code, message, status = 409) {
  return new TaskboardError(message, { code, status });
}
function emptyState(projectId, taskId) {
  return {
    version: 1, projectId, taskId, flowVersion: "role-steps-v1",
    cursors: Object.fromEntries(Object.entries(ROLE_STEPS).map(([role, steps]) => [role, steps[0]])),
    attempts: 1, records: [], lastAction: null
  };
}
function parseCheckpoint(text, projectId, taskId) {
  const start = text.indexOf(START), end = text.indexOf(END);
  if (start < 0 && end < 0) return { state: emptyState(projectId, taskId), legacy: text.trim().length > 0 };
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
  return { state, legacy: false };
}
function renderCheckpoint(original, state) {
  const begin = original.indexOf(START), finish = original.indexOf(END);
  const visible = [
    "", "## 当前执行步骤（由任务看板原子维护）",
    ...Object.entries(ROLE_STEPS).map(([role]) => "- " + role + " 下一步：" + (state.cursors[role] || "已完成")),
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
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

export const ROLE_STAGE_STEPS = ROLE_STEPS;

export class TaskStepCheckpoint {
  constructor(rootDir, { taskStore = null } = {}) {
    this.rootDir = rootDir;
    this.taskStore = taskStore;
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
    const { state, legacy } = parseCheckpoint(content, projectId, taskId);
    return { file, sha256: SHA(content), exists: Boolean(content), legacy, state };
  }
  async record(projectId, taskId, { operationId, expectedSha256, stepId, actorType, actorId,
    sessionId, result = "PASS", evidence, eventId = null, note = "", substepId = null } = {}) {
    if (!ID_PATTERN.test(operationId || "") || !expectedSha256 || !ID_PATTERN.test(actorId || "")
      || !String(sessionId || "").trim()) throw invalid("CHECKPOINT_ARGUMENT_REQUIRED", "缺少操作编号/断点版本/actor/Session", 400);
    const steps = ROLE_STEPS[actorType];
    if (!steps || !steps.includes(stepId)) throw invalid("CHECKPOINT_ROLE_STEP_INVALID", "角色与步骤不匹配", 403);
    if (!["PASS", "FAIL", "BLOCK", "PROGRESS"].includes(result)) throw invalid("CHECKPOINT_RESULT_INVALID", "步骤结果非法", 400);
    if (result === "PROGRESS" && !ID_PATTERN.test(substepId || "")) throw invalid("CHECKPOINT_SUBSTEP_REQUIRED", "小功能完成须提供唯一子步骤编号", 400);
    if (typeof evidence !== "string" || evidence.trim().length < 8) {
      throw invalid("CHECKPOINT_EVIDENCE_REQUIRED", "完成步骤必须附可追溯证据", 422);
    }
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      const previous = await this.show(projectId, taskId);
      const state = previous.state;
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
      if (state.cursors[actorType] !== stepId) {
        throw invalid("CHECKPOINT_STEP_ORDER", "上一步尚未通过，不得越级执行；请先读取唯一下一步");
      }
      const [index] = [steps.indexOf(stepId)];
      if (actorType === "developer_ai" && stepId === "D01_CLAIM"
        && state.cursors.controller_ai !== null) throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "总控未完成派工");
      if (actorType === "test_ai" && stepId === "Q01_ADMISSION"
        && !state.records.some((r) => r.stepId === "D08_HANDOFF" && r.result === "PASS"
          && r.attempt === state.attempts)) {
        throw invalid("CHECKPOINT_PREDECESSOR_REQUIRED", "开发尚未正式交独测");
      }
      if (actorType === "developer_ai" && stepId === "D09_MERGE_MAIN"
        && (!state.records.some((r) => r.stepId === "Q03_RESULT" && r.result === "PASS"
          && r.verdict === "pass" && r.attempt === state.attempts)
        || state.cursors.test_ai !== null)) {
        throw invalid("CHECKPOINT_QA_PASS_REQUIRED", "最新一次独测没有正式PASS");
      }
      if (actorType === "developer_ai" && stepId === "D12_COMPLETE"
        && !state.records.some((r) => r.stepId === "D11_CLEANUP" && r.result === "PASS"
          && r.attempt === state.attempts)) {
        throw invalid("CHECKPOINT_CLEANUP_REQUIRED", "清理未完成不能关闭任务");
      }
      const history = await this.taskStore.taskHistory(projectId, taskId, { all: true });
      const lastClaim = [...history].reverse().find((entry) =>
        entry.event_type === "claim" && entry.actor_type === actorType);
      if (actorType !== "controller_ai" && !["D01_CLAIM","Q01_ADMISSION"].includes(stepId)
        && (!lastClaim || lastClaim.actor_id !== actorId || lastClaim.session_id !== sessionId)) {
        throw invalid("CHECKPOINT_SESSION_MISMATCH", "未用当前正式认领身份写断点", 403);
      }
      if (actorType === "controller_ai" && stepId !== "C01_SCAN") {
        const controllerStart = state.records.find((entry) => entry.stepId === "C01_SCAN" && entry.result === "PASS");
        if (!controllerStart || controllerStart.actorId !== actorId || controllerStart.sessionId !== sessionId) {
          throw invalid("CHECKPOINT_SESSION_MISMATCH", "总控换窗口须先进行合法接管", 403);
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
      if (result === "PASS" && stepId === "D08_HANDOFF" && !["待独测", "待复测"].includes(event?.new_status)) {
        throw invalid("CHECKPOINT_FORMAL_EVENT_REQUIRED", "未真实进入独测队列");
      }
      if (result === "PASS" && stepId === "Q03_RESULT" && !["pass", "fail", "blocked"].includes(event?.metadata?.testResult)) {
        throw invalid("CHECKPOINT_QA_RESULT_INVALID", "独测正式事件缺少真实判定");
      }
      if (result === "PASS" && stepId === "D12_COMPLETE" && event?.new_status !== "已完成") {
        throw invalid("CHECKPOINT_DELIVERY_NOT_CLOSED", "任务未在真实看板关闭");
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
        state.cursors[actorType] = steps[index + 1] || null;
        if (stepId === "Q04_NEXT") {
          const lastVerdict = [...state.records].reverse().find((r) => r.stepId === "Q03_RESULT" && r.attempt === state.attempts);
          if (lastVerdict && lastVerdict.verdict !== "pass") {
            state.attempts += 1;
            state.cursors.developer_ai = "D04_IMPLEMENT";
            state.cursors.test_ai = "Q01_ADMISSION";
          }
        }
      }
      const original = await fs.readFile(previous.file, "utf8").catch((e) => e.code === "ENOENT" ? "" : Promise.reject(e));
      const nextText = renderCheckpoint(original, state);
      await writeFileAtomically(previous.file, nextText);
      const reread = await this.show(projectId, taskId);
      if (reread.state.lastAction?.operationId !== operationId) {
        throw invalid("CHECKPOINT_PERSIST_FAILED", "断点写入后核验失败");
      }
      return { ...reread, duplicate: false };
    });
  }
}
