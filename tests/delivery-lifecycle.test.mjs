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

async function deliveryFixture(t, { merged = true, deliveryActorId = "developer", deliverySessionId = "dev-session" } = {}) {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const taskId = "D-DELIVERY";
  await fs.writeFile(fixture.registryPath, registryText([
    [taskId, "F-DELIVERY", "product", "P0", "交付中", "开发AI", deliveryActorId, "开发窗口", deliverySessionId,
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
      deliveryDisposition: "required",
      deliveryActions: ["candidate_merge"],
      commitSha: candidateSha,
      headBranch: "feature/delivery",
      reportPath: "reports/D-DELIVERY/independent-pass.md"
    }
  });
  await store.appendTaskEvent("fixture", taskId, {
    operationId: "delivery.developer.claim.0001",
    eventType: "claim",
    actorType: "developer_ai",
    actorId: deliveryActorId,
    sessionId: deliverySessionId,
    metadata: { claimedFromStatus: "待交付" }
  });
  const snapshot = await store.snapshot("fixture");
  return { fixture, store, snapshot, taskId, candidateSha, mergeSha, reportPath, bare };
}

test("delivery completion is restricted to the original developer identity and Session", async (t) => {
  const x = await deliveryFixture(t, { deliveryActorId: "replacement-developer", deliverySessionId: "replacement-session" });
  await assert.rejects(() => x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.complete.wrong.owner.0001",
    eventType: "delivery_complete",
    actorType: "developer_ai",
    actorId: "replacement-developer",
    sessionId: "replacement-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_ORIGINAL_DEVELOPER_REQUIRED");
  const current = await x.store.getTask("fixture", x.taskId);
  assert.equal(current.task.status, "交付中");
  assert.equal(current.task.assignee, "replacement-developer");
  assert.equal(current.task.sessionId, "replacement-session");
});

test("delivery closes only after the independently tested candidate is on remote default branch with a bound post-merge PASS report", async (t) => {
  const x = await deliveryFixture(t);
  const result = await x.store.updateTask("fixture", x.taskId, { status: "已完成" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.complete.verified.0001",
    eventType: "delivery_complete",
    actorType: "developer_ai",
    actorId: "developer",
    sessionWindowName: "开发窗口",
    sessionId: "dev-session",
    note: "已合并、推送并完成合并后回归",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(result.after.status, "已完成");
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

test("delivery cannot close by a generic status change or before candidate merge", async (t) => {
  const bypass = await deliveryFixture(t);
  await assert.rejects(() => bypass.store.updateTask("fixture", bypass.taskId, { status: "已完成" }, {
    expectedRevision: bypass.snapshot.registryRevision,
    operationId: "delivery.generic.bypass.0001",
    eventType: "status_change",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session"
  }), (error) => error.code === "DELIVERY_VERIFICATION_REQUIRED");

  const unmerged = await deliveryFixture(t, { merged: false });
  await assert.rejects(() => unmerged.store.updateTask("fixture", unmerged.taskId, { status: "已完成" }, {
    expectedRevision: unmerged.snapshot.registryRevision,
    operationId: "delivery.unmerged.denied.0001",
    eventType: "delivery_complete",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    metadata: { postMergeReportPath: unmerged.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_CANDIDATE_NOT_MERGED");
  const blocked = await unmerged.store.getTask("fixture", unmerged.taskId);
  assert.equal(blocked.task.status, "交付中");
  assert.equal(blocked.task.assignee, "developer");
  assert.equal(blocked.task.sessionId, "dev-session");

  const failureSnapshot = await unmerged.store.snapshot("fixture");
  const failureEvent = await unmerged.store.appendTaskEvent("fixture", unmerged.taskId, {
    expectedRevision: failureSnapshot.registryRevision,
    operationId: "delivery.unmerged.failure.logged.0001",
    eventType: "delivery_attempt_failed",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
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
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    metadata: { postMergeReportPath: unmerged.reportPath, postMergeRegressionResult: "PASS" }
  });
  assert.equal(retried.after.status, "已完成");
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
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
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
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
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
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    metadata: { postMergeReportPath: x.reportPath, postMergeRegressionResult: "PASS" }
  }), (error) => error.code === "DELIVERY_WORKTREE_DIRTY");
});

test("delivery attempt failure is visible and retains the original developer for retry", async (t) => {
  const x = await deliveryFixture(t);
  const failed = await x.store.updateTask("fixture", x.taskId, { status: "交付中" }, {
    expectedRevision: x.snapshot.registryRevision,
    operationId: "delivery.attempt.failed.0001",
    eventType: "delivery_attempt_failed",
    actorType: "developer_ai",
    actorId: "developer",
    sessionId: "dev-session",
    note: "远端推送被拒绝",
    metadata: {
      failureStage: "push",
      failureCode: "REMOTE_REJECTED",
      failureMessage: "远端分支已前进，推送被拒绝",
      nextAction: "先 fetch origin/main，再同步并重试推送"
    }
  });
  assert.equal(failed.after.status, "交付中");
  assert.equal(failed.after.assignee, "developer");
  assert.equal(failed.after.sessionId, "dev-session");
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
