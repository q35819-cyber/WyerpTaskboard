import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeFixture, registryText } from "./helpers.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";

const execFileAsync = promisify(execFile);
async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  return String(stdout || "").trim();
}

async function deliveryFixture(t, { merged = true, deliveryActorId = "controller", deliverySessionId = "ctrl-session", acceptanceScope = "user_ui_business" } = {}) {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const taskId = "D-DELIVERY";
  await fs.writeFile(fixture.registryPath, registryText([
    [taskId, "F-DELIVERY", "product", "P0", "交付中", "总控AI", deliveryActorId, "总控窗口", deliverySessionId,
      "2026-10-31T00:00:00Z", "Git交付闭环测试", "测试计划.md", "reports/D-DELIVERY/post-merge.md"]
  ]), "utf8");
  await fs.mkdir(path.join(fixture.projectRoot, "reports", taskId), { recursive: true });

  const bare = path.join(fixture.boardRoot, "delivery-remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bare], { encoding: "utf8" });
  await git(fixture.projectRoot, "init", "--initial-branch=main");
  await git(fixture.projectRoot, "config", "user.name", "Delivery Fixture");
  await git(fixture.projectRoot, "config", "user.email", "delivery-fixture@example.test");
  await git(fixture.projectRoot, "add", "-A");
  await git(fixture.projectRoot, "commit", "-m", "fixture base");
  await git(fixture.projectRoot, "remote", "add", "origin", bare);
  await git(fixture.projectRoot, "push", "-u", "origin", "main");
  await execFileAsync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8" });

  await git(fixture.projectRoot, "checkout", "-b", "feature/delivery");
  await fs.writeFile(path.join(fixture.projectRoot, "delivery-candidate.js"), "export const deliveryCandidate = true;\n", "utf8");
  await git(fixture.projectRoot, "add", "delivery-candidate.js");
  await git(fixture.projectRoot, "commit", "-m", "delivery candidate");
  const candidateSha = await git(fixture.projectRoot, "rev-parse", "HEAD");
  if (merged) {
    await git(fixture.projectRoot, "checkout", "main");
    await git(fixture.projectRoot, "merge", "--no-ff", "--no-edit", "feature/delivery");
    await git(fixture.projectRoot, "push", "origin", "main");
  } else {
    await git(fixture.projectRoot, "checkout", "main");
  }
  const mergeSha = await git(fixture.projectRoot, "rev-parse", "HEAD");
  const reportPath = "reports/D-DELIVERY/post-merge.md";
  const report = "结论：PASS\n候选SHA：" + candidateSha + "\nmain SHA：" + mergeSha + "\n";
  await fs.writeFile(path.join(fixture.projectRoot, reportPath), report, "utf8");

  const store = await new TaskStore(fixture.boardRoot).init();
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.task.created.0001",
    eventType: "task_created",
    actorType: "system",
    actorId: "fixture",
    metadata: { acceptanceScope }
  });
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.developer.handoff.0001",
    eventType: "handoff",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }
  });
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.tester.claim.0001",
    eventType: "claim",
    actorType: "test_ai",
    actorId: "independent-tester",
    sessionId: "test-session",
    metadata: { claimedFromStatus: "待独测" }
  });
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.independent.pass.0001",
    eventType: "test_result",
    actorType: "test_ai",
    actorId: "independent-tester",
    sessionId: "test-session",
    metadata: {
      atomicLifecycle: true,
      testResult: "pass",
      acceptanceScope,
      deliveryDisposition: "required",
      deliveryActions: ["candidate_merge"],
      commitSha: candidateSha,
      headBranch: "feature/delivery",
      reportPath: "reports/D-DELIVERY/independent-pass.md"
    }
  });
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.controller.claim.0001",
    eventType: "claim",
    actorType: "controller_ai",
    actorId: deliveryActorId,
    sessionId: deliverySessionId,
    metadata: { claimedFromStatus: "待交付" }
  });
  const snapshot = await store.snapshot("fixture");
  return { fixture, store, snapshot, taskId, candidateSha, mergeSha, reportPath, bare };
}

test("delivery completion rejects a developer impersonating controller", async (t) => {
  const x = await deliveryFixture(t, { deliveryActorId: "replacement-controller", deliverySessionId: "replacement-session" });
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.complete.wrong.owner.0001",
    eventType: "delivery_complete",
    actorType: "developer_ai",
    actorId: "replacement-developer",
    sessionId: "replacement-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_OWNER_MISMATCH");
  const current = await x.store.getTask("fixture", x.taskId);
  assert.equal(current.task.status, "交付中");
  assert.equal(current.task.assignee, "replacement-controller");
  assert.equal(current.task.sessionId, "replacement-session");
});

test("delivery reaches user acceptance only after the independently tested candidate is on remote default branch with a bound post-merge PASS report", async (t) => {
  const x = await deliveryFixture(t);
  const result = await x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.complete.verified.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionWindowName: "总控窗口",
    sessionId: "ctrl-session",
    note: "已合并、推送并完成合并后回归",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(result.after.status, "待用户验收");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
  assert.equal(result.after.sessionWindowName, "");
  const event = await x.store.events.findByOperationId("fixture", "delivery.complete.verified.0001");
  assert.equal(event.metadata.deliveryVerified, true);
  assert.equal(event.metadata.candidateCommitSha, x.candidateSha);
  assert.equal(event.metadata.mergeCommitSha, x.mergeSha);
  assert.equal(event.metadata.remoteMainSha, x.mergeSha);
  assert.match(event.metadata.postMergeReportSha256, /^[a-f0-9]{64}$/);
});

test("system-scoped delivery auto-closes after verified merge without user acceptance", async (t) => {
  const x = await deliveryFixture(t, { acceptanceScope: "system" });
  const result = await x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.complete.system.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionWindowName: "总控窗口",
    sessionId: "ctrl-session",
    note: "系统范围任务已合并并完成合并后回归",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(result.after.status, "已完成");
  assert.equal(result.after.plannedRole, "");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
});

test("delivery cannot close by a generic status change or before candidate merge", async (t) => {
  const bypass = await deliveryFixture(t);
  await assert.rejects(() => bypass.store.updateTask("fixture", bypass.taskId, { status: "已完成" }, {
    expectedRevision: bypass.snapshot.registryRevision,
    operationId: "delivery.generic.bypass.0001",
    eventType: "status_change",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session"
  }), (error) => error.code === "DELIVERY_VERIFICATION_REQUIRED");

  const unmerged = await deliveryFixture(t, { merged: false });
  await assert.rejects(() => unmerged.store.updateTask("fixture", unmerged.taskId, { status: "已完成" }, {
    expectedRevision: unmerged.snapshot.registryRevision,
    operationId: "delivery.unmerged.denied.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    metadata: { postMergeReportPath: unmerged.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_CANDIDATE_NOT_MERGED");
  const blocked = await unmerged.store.getTask("fixture", unmerged.taskId);
  assert.equal(blocked.task.status, "交付中");
  assert.equal(blocked.task.assignee, "controller");
  assert.equal(blocked.task.sessionId, "ctrl-session");

  const failureSnapshot = await unmerged.store.snapshot("fixture");
  const failureEvent = await unmerged.store.appendTaskEvent("fixture", unmerged.taskId, {
    expectedRevision: failureSnapshot.registryRevision,
    operationId: "delivery.unmerged.failure.logged.0001",
    eventType: "delivery_attempt_failed",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    note: "候选提交尚未进入远端main",
    metadata: {
      failureStage: "verification",
      failureCode: "DELIVERY_CANDIDATE_NOT_MERGED",
      failureMessage: "候选提交尚未进入远端main",
      nextAction: "合并feature/delivery并推送origin/main后重试"
    }
  });
  assert.equal(failureEvent.event.event_type, "delivery_attempt_failed");
  assert.equal((await unmerged.store.snapshot("fixture")).registryRevision, failureSnapshot.registryRevision);
  await git(unmerged.fixture.projectRoot, "merge", "--no-ff", "--no-edit", "feature/delivery");
  await git(unmerged.fixture.projectRoot, "push", "origin", "main");
  const retryMergeSha = await git(unmerged.fixture.projectRoot, "rev-parse", "HEAD");
  await fs.writeFile(path.join(unmerged.fixture.projectRoot, unmerged.reportPath),
    "结论：PASS\n候选SHA：" + unmerged.candidateSha + "\nmain SHA：" + retryMergeSha + "\n", "utf8");
  const retrySnapshot = await unmerged.store.snapshot("fixture");
  const retried = await unmerged.store.updateTask("fixture", unmerged.taskId, { status: "已完成" }, {
    expectedRevision: retrySnapshot.registryRevision,
    operationId: "delivery.unmerged.retry.completed.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    metadata: { postMergeReportPath: unmerged.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(retried.after.status, "待用户验收");
  assert.equal(retried.after.assignee, "");
  assert.equal(retried.after.sessionId, "");
});

test("delivery rejects a remote main SHA that advanced after the local merge", async (t) => {
  const x = await deliveryFixture(t);
  const advanced = path.join(x.fixture.boardRoot, "remote-advance");
  await execFileAsync("git", ["clone", x.bare, advanced], { encoding: "utf8" });
  await git(advanced, "config", "user.name", "Remote Advance");
  await git(advanced, "config", "user.email", "remote-advance@example.test");
  await fs.writeFile(path.join(advanced, "remote-advance.txt"), "remote advanced\n", "utf8");
  await git(advanced, "add", "remote-advance.txt");
  await git(advanced, "commit", "-m", "advance remote main");
  await git(advanced, "push", "origin", "main");
  const snapshot = await x.store.snapshot("fixture");
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: snapshot.registryRevision,
    operationId: "delivery.remote.sha.mismatch.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_REMOTE_SHA_MISMATCH");
});

test("code changes after independent PASS invalidate delivery evidence", async (t) => {
  const x = await deliveryFixture(t);
  await x.store.appendTaskEvent("fixture", x.taskId, {
    operationId: "delivery.code.changed.after.pass.0001",
    eventType: "code_change",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    metadata: { changedPaths: ["src/changed-after-pass.js"], invalidatesTestEvidence: true }
  });
  const snapshot = await x.store.snapshot("fixture");
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: snapshot.registryRevision,
    operationId: "delivery.pass.invalidated.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_PASS_INVALIDATED");
});

test("delivery refuses to close when source files remain dirty outside the new report", async (t) => {
  const x = await deliveryFixture(t);
  await fs.writeFile(path.join(x.fixture.projectRoot, "uncommitted-source.js"), "export const dirty = true;\n", "utf8");
  const snapshot = await x.store.snapshot("fixture");
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: snapshot.registryRevision,
    operationId: "delivery.dirty.worktree.denied.0001",
    eventType: "delivery_complete",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_WORKTREE_DIRTY");
});

async function isolatedDeliveryWorktree(x) {
  const worktree = path.join(x.fixture.boardRoot, "isolated-delivery");
  await git(x.fixture.projectRoot, "worktree", "add", "--detach", worktree, "main");
  await fs.mkdir(path.join(worktree, path.dirname(x.reportPath)), { recursive: true });
  await fs.writeFile(path.join(worktree, x.reportPath),
    "结论：PASS\n候选SHA：" + x.candidateSha + "\nmain SHA：" + x.mergeSha + "\n", "utf8");
  return worktree;
}

test("registered clean isolated delivery succeeds while another AI's root worktree remains dirty", async (t) => {
  const x = await deliveryFixture(t, { acceptanceScope: "system" });
  const dirtyPath = path.join(x.fixture.projectRoot, "other-ai-uncommitted.js");
  await fs.writeFile(dirtyPath, "export const otherAi = true;\n", "utf8");
  const worktree = await isolatedDeliveryWorktree(x);
  const result = await x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.isolated.clean.accepted.0001",
    eventType: "delivery_complete", actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
    metadata: { deliveryWorktreePath: worktree, postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(result.after.status, "已完成");
  assert.equal(await fs.readFile(dirtyPath, "utf8"), "export const otherAi = true;\n");
  assert.match(await git(x.fixture.projectRoot, "status", "--porcelain"), /other-ai-uncommitted/);
});

test("isolated delivery rejects a dirty worktree or an unregistered path", async (t) => {
  const x = await deliveryFixture(t);
  const worktree = await isolatedDeliveryWorktree(x);
  const complete = (candidate, operationId) => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId, eventType: "delivery_complete",
    actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
    metadata: { deliveryWorktreePath: candidate, postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  });
  await fs.writeFile(path.join(worktree, "dirty-source.js"), "dirty", "utf8");
  await assert.rejects(() => complete(worktree, "delivery.isolated.dirty.denied.0001"),
    (error) => error.code === "DELIVERY_WORKTREE_DIRTY");
  const external = path.join(x.fixture.boardRoot, "external-repository");
  await execFileAsync("git", ["clone", x.bare, external], { encoding: "utf8" });
  await assert.rejects(() => complete(external, "delivery.isolated.other.repo.denied.0001"),
    (error) => error.code === "DELIVERY_WORKTREE_INVALID");
  await assert.rejects(() => complete(path.join(x.fixture.boardRoot, "missing-worktree"),
    "delivery.isolated.unknown.path.denied.0001"), (error) => error.code === "DELIVERY_WORKTREE_INVALID");
});

test("isolated delivery retains candidate ancestry, report, and controller identity gates", async (t) => {
  const unmerged = await deliveryFixture(t, { merged: false });
  const worktree = await isolatedDeliveryWorktree(unmerged);
  const complete = (x, meta, who = "controller") => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.isolated.unmerged.denied.0001",
    eventType: "delivery_complete", actorType: "controller_ai", actorId: who, sessionId: "ctrl-session",
    metadata: { deliveryWorktreePath: worktree, postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS", ...meta }
  });
  await assert.rejects(() => complete(unmerged, {}), (error) => error.code === "DELIVERY_CANDIDATE_NOT_MERGED");
  const merged = await deliveryFixture(t);
  const validWorktree = await isolatedDeliveryWorktree(merged);
  const mergedComplete = (meta, who = "controller") => merged.store.updateTask("fixture", merged.taskId, { status: "已完成" }, {
    expectedRevision: merged.snapshot.registryRevision,
    operationId: "delivery.isolated." + (who === "controller" ? "report" : "owner") + ".denied.0001",
    eventType: "delivery_complete", actorType: "controller_ai", actorId: who, sessionId: "ctrl-session",
    metadata: { deliveryWorktreePath: validWorktree, postMergeReportPath: merged.reportPath, postMergeRegressionResult: "PASS", ...meta }
  });
  await assert.rejects(() => mergedComplete({}, "wrong-controller"),
    (error) => error.code === "DELIVERY_CLAIM_MISMATCH");
  await fs.writeFile(path.join(validWorktree, merged.reportPath), "结论：PASS\n错误SHA\n", "utf8");
  await assert.rejects(() => mergedComplete({}), (error) => error.code === "DELIVERY_POST_MERGE_REPORT_INVALID");
});

test("delivery attempt failure is visible and retains the controller for retry", async (t) => {
  const x = await deliveryFixture(t);
  const failed = await x.store.updateTask("fixture", x.taskId, { status: "交付中" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.attempt.failed.0001",
    eventType: "delivery_attempt_failed",
    actorType: "controller_ai",
    actorId: "controller",
    sessionId: "ctrl-session",
    note: "远端推送被拒绝",
    metadata: {
      failureStage: "push",
      failureCode: "REMOTE_REJECTED",
      failureMessage: "远端分支已前进，推送被拒绝",
      nextAction: "先 fetch origin/main，再同步并重试推送"
    }
  });
  assert.equal(failed.after.status, "交付中");
  assert.equal(failed.after.assignee, "controller");
  assert.equal(failed.after.sessionId, "ctrl-session");
  const presentation = await x.store.presentation("fixture", x.taskId);
  assert.match(presentation.currentProgress, /REMOTE_REJECTED/);
  assert.match(presentation.currentProgress, /远端分支已前进/);
  assert.match(presentation.currentProgress, /fetch origin\/main/);
});

test("待交付任务 without valid independent PASS remains visible but is not claimable", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-NO-PASS", "F-DELIVERY", "product", "P0", "待交付", "开发AI", "—", "—", "—", "—",
      "缺少独测记录", "测试计划.md", "cp/D-NO-PASS.md"]
  ]), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const result = await new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore }).evaluateProject("fixture");
  const candidate = result.candidates.find((item) => item.task_id === "D-NO-PASS");
  assert.ok(candidate, "不能静默隐藏待交付任务");
  assert.equal(candidate.eligible, false);
  assert.ok(candidate.blockers.some((item) => item.includes("缺少有效的最新独立测试PASS")));
});


async function mergeConflictFixture(t, { conflict = true, failure = true } = {}) {
  const x = await deliveryFixture(t, { merged: false, acceptanceScope: "system" });
  await git(x.fixture.projectRoot, "push", "origin", "feature/delivery");
  if (conflict) {
    await fs.writeFile(path.join(x.fixture.projectRoot, "delivery-candidate.js"),
      "export const deliveryCandidate = false;\n", "utf8");
    await git(x.fixture.projectRoot, "add", "delivery-candidate.js");
    await git(x.fixture.projectRoot, "commit", "-m", "main diverges from QA candidate");
    await git(x.fixture.projectRoot, "push", "origin", "main");
  }
  const mainSha = await git(x.fixture.projectRoot, "rev-parse", "HEAD");
  if (failure) {
    await x.store.appendTaskEvent("fixture", x.taskId, {
      operationId: "delivery.rework.attempt.failed.0001",
      eventType: "delivery_attempt_failed",
      actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
      metadata: { failureStage: "merge", candidateSha: x.candidateSha }
    });
  }
  return { ...x, mainSha };
}

test("R1 real Git merge conflict reopens the original developer and invalidates old QA PASS", async t => {
  const x = await mergeConflictFixture(t);
  const result = await x.store.updateTask("fixture", x.taskId, { status: "待开发" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.rework.valid.0001",
    eventType: "delivery_merge_conflict_rework", actorType: "controller_ai",
    actorId: "controller", sessionId: "ctrl-session",
    metadata: { candidateSha: x.candidateSha, mainSha: x.mainSha }
  });
  assert.equal(result.before.status, "交付中");
  assert.equal(result.after.status, "待开发");
  assert.equal(result.after.plannedRole, "开发AI");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
  const history = await x.store.taskHistory("fixture", x.taskId, { all: true });
  const rework = history.at(-1);
  assert.equal(rework.event_type, "delivery_merge_conflict_rework");
  assert.equal(rework.metadata.mergeConflictVerified, true);
  assert.equal(rework.metadata.requiresIndependentRetest, true);
  assert.equal(rework.metadata.originalDeveloperActorId, "developer");
  assert.ok(rework.metadata.conflictFiles.includes("delivery-candidate.js"));
  const { deliveryEvidence } = await import("../server/candidate-evaluator.mjs");
  const context = await x.store.projects.context("fixture");
  assert.equal(deliveryEvidence(history, context.workflow).valid, false, "Old independent PASS is invalidated");
  const now = await x.store.getTask("fixture", x.taskId);
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, {
    status: "开发中", assignee: "other", sessionId: "other-session", sessionWindowName: "other"
  }, {
    expectedRevision: now.snapshot.registryRevision, operationId: "delivery.rework.wrong.dev.0001",
    eventType: "claim", actorType: "developer_ai", actorId: "other", sessionId: "other-session"
  }), e => e.code === "DELIVERY_REWORK_ORIGINAL_DEVELOPER_REQUIRED");
});

test("R2 without a recorded merge failure or with a spoofed controller the state never changes", async t => {
  const x = await mergeConflictFixture(t, { failure: false });
  const run = (actorType, actorId, sessionId, operationId) =>
    x.store.updateTask("fixture", x.taskId, { status: "待开发" }, {
      expectedRevision: x.snapshot.registryRevision, operationId,
      eventType: "delivery_merge_conflict_rework",
      actorType, actorId, sessionId,
      metadata: { candidateSha: x.candidateSha, mainSha: x.mainSha }
    });
  await assert.rejects(() => run("controller_ai", "controller", "ctrl-session", "delivery.rework.no.failure.0001"),
    e => e.code === "DELIVERY_REWORK_FAILURE_EVIDENCE_REQUIRED");
  await assert.rejects(() => run("developer_ai", "developer", "dev-session", "delivery.rework.spoof.0001"),
    e => e.code === "DELIVERY_REWORK_CONTROLLER_REQUIRED");
  assert.equal((await x.store.getTask("fixture", x.taskId)).task.status, "交付中");
});

test("R2 stale main SHA, candidate SHA and absence of conflict fail closed", async t => {
  const x = await mergeConflictFixture(t);
  const run = (candidateSha, mainSha, operationId) =>
    x.store.updateTask("fixture", x.taskId, { status: "待开发" }, {
      expectedRevision: x.snapshot.registryRevision, operationId,
      eventType: "delivery_merge_conflict_rework",
      actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
      metadata: { candidateSha, mainSha }
    });
  await assert.rejects(() => run("a".repeat(40), x.mainSha, "delivery.rework.bad.candidate.0001"),
    e => e.code === "DELIVERY_REWORK_CANDIDATE_MISMATCH");
  await assert.rejects(() => run(x.candidateSha, "b".repeat(40), "delivery.rework.stale.main.0001"),
    e => e.code === "DELIVERY_REWORK_MAIN_STALE");
  assert.equal((await x.store.getTask("fixture", x.taskId)).task.status, "交付中");
  const clean = await mergeConflictFixture(t, { conflict: false });
  await assert.rejects(() => clean.store.updateTask("fixture", clean.taskId, { status: "待开发" }, {
    expectedRevision: clean.snapshot.registryRevision, operationId: "delivery.rework.no.conflict.0001",
    eventType: "delivery_merge_conflict_rework", actorType: "controller_ai",
    actorId: "controller", sessionId: "ctrl-session",
    metadata: { candidateSha: clean.candidateSha, mainSha: clean.mainSha }
  }), e => e.code === "DELIVERY_REWORK_CONFLICT_NOT_VERIFIED");
  assert.equal((await clean.store.getTask("fixture", clean.taskId)).task.status, "交付中");
});


test("R2 STOP and invalidated independent PASS cannot silently return delivery to development", async t => {
  const stopped = await mergeConflictFixture(t);
  await stopped.store.appendTaskEvent("fixture", stopped.taskId, {
    operationId: "delivery.rework.stop.req.0001",
    eventType: "stop_request", actorType: "user", actorId: "user",
    note: "用户要求暂停"
  });
  await assert.rejects(() => stopped.store.updateTask("fixture", stopped.taskId, {status: "待开发"}, {
    expectedRevision: stopped.snapshot.registryRevision,
    operationId: "delivery.rework.stop.reject.0001",
    eventType: "delivery_merge_conflict_rework",
    actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
    metadata: {candidateSha: stopped.candidateSha, mainSha: stopped.mainSha}
  }), e => e.code === "DELIVERY_REWORK_CONTROLLER_REQUIRED");
  assert.equal((await stopped.store.getTask("fixture", stopped.taskId)).task.status, "交付中");

  const stale = await mergeConflictFixture(t);
  await stale.store.appendTaskEvent("fixture", stale.taskId, {
    operationId: "delivery.rework.code.changed.0001",
    eventType: "code_change", actorType: "developer_ai", actorId: "developer",
    sessionId: "dev-session", metadata: { invalidatesTestEvidence: true }
  });
  await assert.rejects(() => stale.store.updateTask("fixture", stale.taskId, {status: "待开发"}, {
    expectedRevision: stale.snapshot.registryRevision,
    operationId: "delivery.rework.stale.qa.0001",
    eventType: "delivery_merge_conflict_rework",
    actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
    metadata: {candidateSha: stale.candidateSha, mainSha: stale.mainSha}
  }), e => e.code === "DELIVERY_REWORK_INDEPENDENT_PASS_REQUIRED");
  assert.equal((await stale.store.getTask("fixture", stale.taskId)).task.status, "交付中");
});

test("R2 concurrent registry revision and wrong project are rejected without mutation", async t => {
  const x = await mergeConflictFixture(t);
  await assert.rejects(() => x.store.updateTask("other-project", x.taskId, { status: "待开发" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.rework.wrong.project.0001",
    eventType: "delivery_merge_conflict_rework", actorType: "controller_ai",
    actorId: "controller", sessionId: "ctrl-session",
    metadata: { candidateSha: x.candidateSha, mainSha: x.mainSha }
  }), e => Boolean(e.code));
  const valid = await x.store.updateTask("fixture", x.taskId, { status: "待开发" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.rework.concurrent.first.0001",
    eventType: "delivery_merge_conflict_rework", actorType: "controller_ai",
    actorId: "controller", sessionId: "ctrl-session",
    metadata: { candidateSha: x.candidateSha, mainSha: x.mainSha }
  });
  assert.equal(valid.after.status, "待开发");
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "待开发" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.rework.concurrent.stale.0001",
    eventType: "delivery_merge_conflict_rework", actorType: "controller_ai",
    actorId: "controller", sessionId: "ctrl-session",
    metadata: { candidateSha: x.candidateSha, mainSha: x.mainSha }
  }), e => e.code === "REVISION_CONFLICT");
});


test("R1 controller HTTP endpoint validates and performs a real conflict rework", async t => {
  const x = await mergeConflictFixture(t);
  const { createTaskboardServer } = await import("../server/http-server.mjs");
  const app = await createTaskboardServer({ rootDir: x.fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const secret = JSON.parse(await fs.readFile(
      path.join(x.fixture.boardRoot, "config", "admin-secret.json"), "utf8")).adminSecret;
    const url = "http://127.0.0.1:" + app.server.address().port +
      "/api/projects/fixture/tasks/" + x.taskId + "/delivery-merge-conflict-rework";
    const body = {
      operationId: "delivery.rework.http.valid.0001",
      expectedRevision: x.snapshot.registryRevision,
      actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session",
      candidateSha: x.candidateSha, mainSha: x.mainSha,
      note: "已独立核验真实Git merge-tree冲突"
    };
    const wrong = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json",
        Authorization: "Bearer " + secret },
      body: JSON.stringify({ ...body, operationId: "delivery.rework.http.bad.0001",
        actorType: "developer_ai", actorId: "developer" })
    });
    assert.equal(wrong.status, 409);
    const response = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json",
        Authorization: "Bearer " + secret }, body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result).slice(0, 350));
    assert.equal(result.after.status, "待开发");
    assert.equal(result.after.sessionId, "");
  } finally {
    await new Promise(resolve => app.server.close(resolve));
  }
});
