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

test("P0 QA evidence parity: reject missing proof before releasing developer and accept committed modern proof", async t => {
  const crypto = await import("node:crypto");
  const { createTaskboardServer, developerQaProof } = await import("../server/http-server.mjs");
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const taskId = "B-10", actorId = "worker", sessionId = "wc_sess_test";
  const bare = path.join(f.boardRoot, "remote.git");
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", bare]);
  await git(f.projectRoot, "init", "--initial-branch=main");
  await git(f.projectRoot, "config", "user.name", "QA Proof Fixture");
  await git(f.projectRoot, "config", "user.email", "qa-proof@example.test");
  await git(f.projectRoot, "add", "-A");
  await git(f.projectRoot, "commit", "-m", "base");
  await git(f.projectRoot, "remote", "add", "origin", bare);
  await git(f.projectRoot, "push", "-u", "origin", "main");
  await execFileAsync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(f.projectRoot, "checkout", "-b", "feature/qa-proof");
  const reportPath = "reports/B-10/developer-R1-R3.md";
  const report = "B-10\nR1 PASS\nR2 PASS\nR3 PASS\n整仓 62 files 0 fail\n";
  await fs.mkdir(path.dirname(path.join(f.projectRoot, reportPath)), { recursive: true });
  await fs.writeFile(path.join(f.projectRoot, reportPath), report, "utf8");
  await git(f.projectRoot, "add", "-A");
  await git(f.projectRoot, "commit", "-m", "QA evidence candidate");
  const sha = await git(f.projectRoot, "rev-parse", "HEAD");
  await git(f.projectRoot, "push", "-u", "origin", "feature/qa-proof");
  const reportSha256 = crypto.createHash("sha256").update(report).digest("hex");
  const claimed = await store.appendTaskEvent("fixture", taskId, {
    operationId: "qa.proof.developer.claim", eventType: "claim",
    actorType: "developer_ai", actorId, sessionId
  });
  const checkpoint = {
    version: 1, projectId: "fixture", taskId, flowVersion: "role-steps-v2",
    cursors: { controller_ai: "C00_A_REQUIREMENTS", developer_ai: "D08_HANDOFF", test_ai: "Q01_ADMISSION" },
    attempts: 1,
    records: ["D01_CLAIM","D02_WORKTREE","D03_WRITE_SCOPE","D04_IMPLEMENT",
      "D05_TEST_1","D06_TEST_2","D07_TEST_3"].map(stepId => ({
      stepId, result: "PASS", actorType: "developer_ai", actorId, sessionId, attempt: 1,
      eventId: stepId === "D01_CLAIM" ? claimed.event.event_id : null,
      evidence: stepId === "D07_TEST_3" ? "npm test 62 files 0 failed R3 PASS" : "fixture evidence"
    })),
    lastAction: { stepId: "D07_TEST_3", result: "PASS" }
  };
  await fs.mkdir(path.join(f.projectRoot, "cp"), { recursive: true });
  await fs.writeFile(path.join(f.projectRoot, "cp", taskId + ".md"),
    "<!-- TASK_STEP_CHECKPOINT_START v1 -->\n" + JSON.stringify(checkpoint) +
    "\n<!-- TASK_STEP_CHECKPOINT_END -->\n");
  const app = await createTaskboardServer({ rootDir: f.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => new Promise(resolve => app.server.close(resolve)));
  const secret = JSON.parse(await fs.readFile(path.join(f.boardRoot, "config", "admin-secret.json"), "utf8")).adminSecret;
  const url = "http://127.0.0.1:" + app.server.address().port +
    "/api/projects/fixture/tasks/" + taskId;
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const request = async (id, metadata) => {
    const before = await (await fetch(url, { headers })).json();
    const response = await fetch(url + "/complete-execution", {
      method: "POST", headers, body: JSON.stringify({
        operationId: id, expectedRevision: before.registryRevision,
        actorType: "developer_ai", actorId, sessionId, metadata
      })
    });
    return { status: response.status, body: await response.json() };
  };
  const rejected = await request("qa.proof.missing", {});
  assert.equal(rejected.status, 409, JSON.stringify(rejected.body).slice(0, 350));
  assert.equal(rejected.body.error.code, "DEVELOPER_QA_EVIDENCE_INCOMPLETE");
  assert.match(JSON.stringify(rejected.body.error.details), /commitSha|自测|报告/);
  const unchanged = await (await fetch(url, { headers })).json();
  assert.equal(unchanged.status, "开发中");
  assert.equal(unchanged.sessionId, sessionId);
  const developerSelfTests = { R1: { exitCode: 0, passes: 4 },
    R2: { exitCode: 0, passes: 5 },
    R3: { exitCode: 0, files: 62, failedFiles: 0 } };
  const proof = { commitSha: sha, headBranch: "feature/qa-proof",
    reportPath, reportSha256, developerSelfTests };
  const badRemote = await request("qa.proof.fake.sha", { ...proof, commitSha: "a".repeat(40) });
  assert.equal(badRemote.status, 409);
  assert.match(JSON.stringify(badRemote.body.error.details), /远端origin/);
  const missingR3 = await request("qa.proof.r3.missing", {
    ...proof, developerSelfTests: { ...developerSelfTests, R3: { files: 0, failedFiles: 0, exitCode: 0 } }
  });
  assert.equal(missingR3.status, 409);
  assert.match(JSON.stringify(missingR3.body.error.details), /R3/);
  const verified = await request("qa.proof.valid", proof);
  assert.equal(verified.status, 200, JSON.stringify(verified.body).slice(0, 450));
  assert.equal(verified.body.after.status, "待独测");
  assert.equal(verified.body.after.assignee, "");
  assert.equal(verified.body.after.sessionId, "");
  const finished = await store.getTask("fixture", taskId);
  const eligible = await developerQaProof({
    taskStore: store, rootDir: f.boardRoot, projectId: "fixture", taskId, task: finished.task,
    expectedStatus: "待独测", expectedUpdatedAt: finished.task.updatedAt,
    expectedRevision: finished.snapshot.registryRevision
  });
  assert.equal(eligible.eligible, true, JSON.stringify(eligible.blockers));
  assert.equal(eligible.candidateSha, sha);
  const { ScanStore } = await import("../server/scan-store.mjs");
  const scanStore = await new ScanStore(f.boardRoot).init();
  await scanStore.writeState({ version: 1, candidates: {
    qaFixture: {
      detection_id: "det_fixture_qa", project_id: "fixture", task_id: taskId,
      track: "infrastructure", priority: "P0", status: "待独测",
      planned_role: "独立测试AI", eligible_role: "test_ai",
      eligible: true, blockers: [], reason: "等待独测", dedupe_key: "fixture_qa",
      task_updated_at: finished.task.updatedAt,
      registry_revision: finished.snapshot.registryRevision,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      consumed_at: null, stale_at: null
    }
  } });
  const qaStatus = await (await fetch("http://127.0.0.1:" +
    app.server.address().port + "/api/task-scan/status", { headers })).json();
  assert.equal(qaStatus.qaCandidates.length, 1);
  assert.equal(qaStatus.qaCandidates[0].eligible, true);
  assert.equal(qaStatus.qaCandidates[0].candidateSha, sha);
  assert.equal(qaStatus.qaCandidates[0].blockers.length, 0);
  const stoppedStore = Object.create(store);
  stoppedStore.stopState = async () => ({ stopRequested: true });
  const stopped = await developerQaProof({
    taskStore: stoppedStore, rootDir: f.boardRoot, projectId: "fixture",
    taskId, task: finished.task
  });
  assert.equal(stopped.eligible, false);
  assert.match(stopped.blockers.join(" "), /STOP/);
  const activeStore = Object.create(store);
  activeStore.testResourceState = async () => ({ activeCount: 1 });
  const active = await developerQaProof({
    taskStore: activeStore, rootDir: f.boardRoot, projectId: "fixture",
    taskId, task: finished.task
  });
  assert.equal(active.eligible, false);
  assert.match(active.blockers.join(" "), /资源/);
  const outdated = await developerQaProof({
    taskStore: store, rootDir: f.boardRoot, projectId: "fixture", taskId, task: finished.task,
    expectedStatus: "待独测", expectedUpdatedAt: "2020-01-01T00:00:00Z"
  });
  assert.equal(outdated.eligible, false);
  assert.match(outdated.blockers.join(" "), /过期/);
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "qa.proof.code.changed", eventType: "code_change",
    actorType: "developer_ai", actorId, sessionId,
    metadata: { invalidatesTestEvidence: true }
  });
  const invalidated = await developerQaProof({
    taskStore: store, rootDir: f.boardRoot, projectId: "fixture", taskId,
    task: (await store.getTask("fixture", taskId)).task
  });
  assert.equal(invalidated.eligible, false);
  assert.match(invalidated.blockers.join(" "), /变更/);
  const afterChange = await (await fetch("http://127.0.0.1:" +
    app.server.address().port + "/api/task-scan/status", { headers })).json();
  assert.equal(afterChange.qaCandidates[0].eligible, false);
  assert.match(afterChange.qaCandidates[0].blockers.join(" "), /变更/);
});
