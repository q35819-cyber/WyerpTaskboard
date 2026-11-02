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
async function assertDeveloperClaimExclusive(store, projectId, context, parsed, task, actorId, sessionId) {
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
      if (overlapping && (RESERVED_WRITES.has(other.status) ||
        (other.status === "HOLD" && history?.some((event) =>
          event.event_type === "claim" && event.actor_type === "developer_ai")))) {
        throw new TaskboardError("计划写文件与未交付任务冲突", {
          code: "CLAIM_WRITE_CONFLICT", status: 409, details: { taskId: other.id, projectId: otherProject }
        });
      }
    }
  }
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

async function verifyDeliveryCompletion(context, task, events, patch, { actorType, actorId, sessionId, metadata }) {
  if (task.status !== "交付中" || patch?.status !== "已完成") {
    throw new TaskboardError("只有交付中的任务可以提交合并完成", { code: "DELIVERY_STAGE_REQUIRED", status: 409 });
  }
  if (actorType !== "developer_ai" || !sessionId || sessionId !== task.sessionId) {
    throw new TaskboardError("必须由当前交付负责人在原Session完成合并交付", { code: "DELIVERY_OWNER_MISMATCH", status: 409 });
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
  const testerClaim = [...prior].reverse().find((event) =>
    event.event_type === "claim" && event.actor_type === "test_ai" && event.actor_id === latestTest.actor_id);
  const developerHandoff = [...prior].reverse().find((event) =>
    event.event_type === "handoff" && event.actor_type === "developer_ai"
    && ["开发中", "修复中"].includes(event.metadata?.completedFromStatus));
  if (!testerClaim || testerClaim.session_id !== latestTest.session_id || !developerHandoff
    || events.indexOf(developerHandoff) >= events.indexOf(testerClaim)
    || developerHandoff.actor_id === latestTest.actor_id || developerHandoff.session_id === latestTest.session_id) {
    throw new TaskboardError("独立测试必须由不同于原开发者的正式test_ai认领并完成", {
      code: "DELIVERY_TEST_INDEPENDENCE_INVALID", status: 409
    });
  }
  const takeover = deliveryTakeoverAuthority(events, {
    valid: true, eventId: latestTest.event_id, latestResult: latestTest,
    developerActorId: developerHandoff.actor_id, developerSessionId: developerHandoff.session_id
  });
  const originalOwner = developerHandoff.actor_id === actorId && developerHandoff.session_id === sessionId;
  const delegatedOwner = takeover?.metadata?.newDeveloperActorId === actorId &&
    takeover?.metadata?.newDeveloperSessionId === sessionId;
  if ((!originalOwner && !delegatedOwner) || (takeover && !delegatedOwner)) {
    throw new TaskboardError("交付必须由当前已授权的开发Session完成；旧Session接管后失权", {
      code: "DELIVERY_ORIGINAL_DEVELOPER_REQUIRED", status: 409,
      details: { requiredActorId: takeover?.metadata?.newDeveloperActorId || developerHandoff.actor_id,
        requiredSessionId: takeover?.metadata?.newDeveloperSessionId || developerHandoff.session_id }
    });
  }
  const invalidation = events.slice(passIndex + 1).find((event) =>
    event.event_type === "code_change" || event.event_type === "test_result" || event.metadata?.invalidatesTestEvidence === true);
  if (invalidation) throw new TaskboardError("独立PASS之后又发生代码修改或测试结果变化，必须重新独测", {
    code: "DELIVERY_PASS_INVALIDATED", status: 409
  });
  const deliveryClaim = [...events].reverse().find((event) =>
    event.event_type === "claim" && event.new_status === "交付中" && event.actor_type === "developer_ai");
  if (!deliveryClaim || deliveryClaim.actor_id !== actorId || deliveryClaim.session_id !== sessionId
    || (takeover && !delegatedOwner) || (!takeover && !originalOwner)) {
    throw new TaskboardError("当前执行身份不是原开发AI的正式交付认领", {
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
function presentationForTask(task, events = [], project = {}) {
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
    const tasks = [...parsed.tasks].sort((a, b) =>
      context.workflow.sortKey(a) - context.workflow.sortKey(b) || a.id.localeCompare(b.id)
    ).map((task) => {
      const events = eventMap.get(task.id) || [];
      const acceptanceScope = context.workflow.resolveAcceptanceScope(task, events);
      return {
        ...task,
        acceptanceScope,
        presentation: { ...presentationForTask(task, events, context.project), acceptanceScope }
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
      if (eventType === "claim" && actorType === "developer_ai") {
        await assertDeveloperClaimExclusive(this, projectId, context, parsed, currentTask, actorId, sessionId);
      }
      let effectiveMetadata = metadata;
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
    expectedRevision = undefined
  } = {}) {
    assertOperationId(operationId);
    const append = async () => {
      const existing = await this.events.findByOperationId(projectId, operationId);
      if (existing) return { event: existing, idempotentReplay: true };
      const { task, snapshot } = await this.getTask(projectId, taskId);
      if (expectedRevision !== undefined && expectedRevision !== null && snapshot.registryRevision !== expectedRevision) {
        throw new TaskboardError("任务注册表revision已变化，拒绝追加过期的任务事件", {
          code: "REVISION_CONFLICT", status: 409,
          details: { expectedRevision, actualRevision: snapshot.registryRevision }
        });
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

  async presentation(projectId, taskId) {
    const { task } = await this.getTask(projectId, taskId);
    const events = await this.taskHistory(projectId, taskId, { all: true });
    return presentationForTask(task, events, this.projects.get(projectId));
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

