import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture, registryText } from "./helpers.mjs";


async function createMergedGitFixture(fixture) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const git = async (...args) => (await run("git", ["-C", fixture.projectRoot, ...args],
    { encoding: "utf8", windowsHide: true })).stdout.trim();
  await fs.mkdir(path.join(fixture.projectRoot, "reports", "D-PENDING"), { recursive: true });
  await fs.writeFile(path.join(fixture.projectRoot, "reports", "D-PENDING", "qa-pass.md"), "独立QA PASS报告");
  // The live task registry is project runtime state, never tracked application source.
  await fs.writeFile(path.join(fixture.projectRoot, ".gitignore"), "tasks.md\n");
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Takeover Fixture");
  await git("config", "user.email", "takeover@example.test");
  await git("add", "-A");
  await git("commit", "-m", "fixture base");
  await git("switch", "-c", "feature/qa");
  await fs.writeFile(path.join(fixture.projectRoot, "qa-candidate.js"), "export const accepted = true;\n");
  await git("add", "qa-candidate.js");
  await git("commit", "-m", "QA candidate");
  const sha = await git("rev-parse", "HEAD");
  await git("switch", "main");
  await git("merge", "--ff-only", "feature/qa");
  const bare = path.join(fixture.boardRoot, "takeover-remote.git");
  await run("git", ["init", "--bare", "--initial-branch=main", bare],
    { encoding: "utf8", windowsHide: true });
  await git("remote", "add", "origin", bare);
  await git("push", "-u", "origin", "main");
  await run("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"],
    { encoding: "utf8", windowsHide: true });
  return sha;
}
async function setup(t, { pass = true, missingReport = false, mergedGit = false } = {}) {
  const fixture = await makeFixture();
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-PENDING", "F-P0", "infrastructure", "P0", "待交付", "开发AI", "—", "—", "—",
      "2026-10-31T00:00:00Z", "QA PASS等候合并", "测试计划.md", "cp/D-PENDING.md"]
  ]));
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((ok, fail) => {
    app.server.once("error", fail);
    app.server.listen(0, "127.0.0.1", ok);
  });
  t.after(async () => {
    await new Promise((ok) => app.server.close(ok));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const config = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config/admin-secret.json"), "utf8"));
  const bearer = { Authorization: "Bearer " + config.adminSecret, "Content-Type": "application/json" };
  const browser = { Origin: base, "Content-Type": "application/json" };
  const root = "/api/projects/fixture/tasks/D-PENDING";
  const send = async (suffix, body, isUser = false) => {
    const res = await fetch(base + root + suffix, {
      method: "POST", headers: isUser ? browser : bearer, body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
  };
  const get = async () => (await (await fetch(base + root, { headers: bearer })).json());
  const seed = async (operationId, eventType, actorType, actorId, sessionId, metadata) => app.taskStore.appendTaskEvent("fixture", "D-PENDING", {
    operationId, eventType, actorType, actorId, sessionId, metadata
  });
  await seed("delivery.qa.old.handoff", "handoff", "developer_ai", "old-dev", "wc_sess_old", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  });
  await seed("delivery.qa.test.claim", "claim", "test_ai", "qa-dev", "wc_sess_qa", {
    claimedFromStatus: "待独测"
  });
  const sha = mergedGit ? await createMergedGitFixture(fixture) : "b".repeat(40);
  if (pass) {
    await seed("delivery.qa.test.pass", "test_result", "test_ai", "qa-dev", "wc_sess_qa", {
      atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required",
      deliveryActions: ["candidate_merge"], commitSha: sha, headBranch: "feature/qa",
      reportPath: "reports/D-PENDING/qa-pass.md"
    });
  }
  if (!missingReport) {
    await fs.mkdir(path.join(fixture.projectRoot, "reports", "D-PENDING"), { recursive: true });
    await fs.writeFile(path.join(fixture.projectRoot, "reports", "D-PENDING", "qa-pass.md"), "独立QA PASS报告");
  }
  const takeoverBody = (revision) => ({
    operationId: "delivery.takeover.execute.0001", expectedRevision: revision,
    actorType: "developer_ai", actorId: "new-dev", assignee: "新的开发AI",
    sessionId: "wc_sess_new", sessionWindowName: "新开发窗口",
    previousWorktree: "D:/original-worktree", nextWorktree: "D:/new-worktree",
    liveInspection: "已核验原Session与Job，没有未完成写入且dirty成果归档完整",
    note: "用户明确授权交接交付"
  });
  return { fixture, app, root, base, bearer, browser, send, get, sha, takeoverBody };
}
async function allowed(x) {
  return x.send("/takeover/allow", {
    operationId: "delivery.takeover.allow.0001", note: "我允许异常接管 D-PENDING"
  }, true);
}
async function preclaim(x, actorId, sessionId) {
  return x.send("/preclaim-report", {
    operationId: "delivery.preclaim." + actorId, actorType: "developer_ai", actorId, sessionId,
    note: "先核对独测候选与工作区并向用户汇报，准备正式认领"
  });
}
async function claim(x, actorId, sessionId, op) {
  const current = await x.get();
  return x.send("/claim", {
    operationId: op, expectedRevision: current.registryRevision,
    actorType: "developer_ai", actorId, sessionId, assignee: actorId,
    sessionWindowName: "新窗口"
  });
}

test("pending delivery rejects unauthorized takeover; authorized user retains QA, original identity and generation", async (t) => {
  const x = await setup(t);
  let current = await x.get();
  const denied = await x.send("/takeover", x.takeoverBody(current.registryRevision));
  assert.equal(denied.status, 409);
  assert.equal(denied.data.error.code, "TAKEOVER_NOT_ALLOWED");
  const bearerAllow = await x.send("/takeover/allow", {
    operationId: "delivery.takeover.bearer.allow", note: "bearer不能代用户授权"
  });
  assert.equal(bearerAllow.status, 403);
  const yes = await allowed(x);
  assert.equal(yes.status, 200, JSON.stringify(yes.data));
  current = await x.get();
  const result = await x.send("/takeover", x.takeoverBody(current.registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待交付");
  assert.equal(result.data.requiresIndependentRetest, false);
  assert.equal(result.data.generation, 1);
  const events = await x.app.taskStore.taskHistory("fixture", "D-PENDING", { all: true });
  const takeover = events.find((e) => e.event_type === "takeover");
  assert.equal(takeover.metadata.originalDeveloperActorId, "old-dev");
  assert.equal(takeover.metadata.originalDeveloperSessionId, "wc_sess_old");
  assert.equal(takeover.metadata.newDeveloperActorId, "new-dev");
  assert.equal(takeover.metadata.newDeveloperSessionId, "wc_sess_new");
  assert.equal(takeover.metadata.previousWorktree, "D:/original-worktree");
  assert.equal(takeover.metadata.newWorktree, "D:/new-worktree");
  assert.equal(takeover.metadata.candidateSha, x.sha);
  assert.equal(takeover.metadata.independentReportPath, "reports/D-PENDING/qa-pass.md");
  assert.equal(events.filter((e) => e.event_type === "test_result").length, 1);
  const oldReport = await preclaim(x, "old-dev", "wc_sess_old");
  assert.equal(oldReport.status, 200);
  const oldClaim = await claim(x, "old-dev", "wc_sess_old", "delivery.old.claim.after.takeover");
  assert.equal(oldClaim.status, 409);
  assert.equal(oldClaim.data.error.code, "DELIVERY_ORIGINAL_DEVELOPER_REQUIRED");
  assert.equal((await preclaim(x, "new-dev", "wc_sess_new")).status, 200);
  const newClaim = await claim(x, "new-dev", "wc_sess_new", "delivery.new.claim.after.takeover");
  assert.equal(newClaim.status, 200, JSON.stringify(newClaim.data));
  assert.equal(newClaim.data.after.status, "交付中");
  assert.equal(newClaim.data.after.sessionId, "wc_sess_new");
});

test("pending delivery without independent evidence returns to independent testing", async (t) => {
  const x = await setup(t, { pass: false });
  assert.equal((await allowed(x)).status, 200);
  const current = await x.get();
  const result = await x.send("/takeover", x.takeoverBody(current.registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待独测");
  assert.equal(result.data.requiresIndependentRetest, true);
  const spoof = await x.send("/preclaim-report", {
    operationId: "delivery.spoof.preclaim", actorType: "test_ai",
    actorId: "new-dev", sessionId: "wc_sess_new", note: "接管开发者不得伪装成独测"
  });
  assert.equal(spoof.status, 200);
  const spoofClaim = await x.send("/claim", {
    operationId: "delivery.spoof.test.claim", expectedRevision: (await x.get()).registryRevision,
    actorType: "test_ai", actorId: "new-dev", sessionId: "wc_sess_new",
    assignee: "伪装独测", sessionWindowName: "同一个开发窗口"
  });
  assert.equal(spoofClaim.status, 409);
  assert.equal(spoofClaim.data.error.code, "INDEPENDENT_TEST_CONFLICT");
  const actor = await x.send("/preclaim-report", {
    operationId: "delivery.test.preclaim.new.qa", actorType: "test_ai",
    actorId: "fresh-qa", sessionId: "wc_sess_fresh_qa", note: "回到独立测试入口"
  });
  assert.equal(actor.status, 200);
  const now = await x.get();
  const claimQA = await x.send("/claim", {
    operationId: "delivery.test.fresh.qa.claim", expectedRevision: now.registryRevision,
    actorType: "test_ai", actorId: "fresh-qa", sessionId: "wc_sess_fresh_qa",
    assignee: "独立测试", sessionWindowName: "不同独测窗口"
  });
  assert.equal(claimQA.status, 200, JSON.stringify(claimQA.data));
  assert.equal(claimQA.data.after.status, "独测中");
});

test("missing QA report never silently reuses old PASS; stale permission, spoofing and replay fail", async (t) => {
  const x = await setup(t, { missingReport: true });
  assert.equal((await allowed(x)).status, 200);
  const rev = (await x.get()).registryRevision;
  const fake = await x.send("/events", {
    operationId: "delivery.fake.takeover.999", eventType: "takeover",
    actorType: "developer_ai", actorId: "new-dev", sessionId: "wc_sess_new",
    metadata: { deliveryTakeover: true }
  });
  assert.equal(fake.status, 409);
  assert.equal(fake.data.error.code, "TAKEOVER_FORMAL_ROUTE_REQUIRED");
  const first = await x.send("/takeover", x.takeoverBody(rev));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.after.status, "待独测");
  const replay = await x.send("/takeover", {
    ...x.takeoverBody(first.data.registryRevision), operationId: "delivery.takeover.second.execute"
  });
  assert.equal(replay.status, 409);
});

test("authorization revision expires after another task update", async (t) => {
  const x = await setup(t);
  assert.equal((await allowed(x)).status, 200);
  const original = await x.get();
  const priority = await fetch(x.base + x.root, {
    method: "PATCH", headers: x.browser,
    body: JSON.stringify({ operationId: "delivery.priority.changed", eventType: "priority_change",
      patch: { priority: "P1" }, expectedRevision: original.registryRevision })
  });
  assert.equal(priority.status, 200);
  const current = await x.get();
  const stale = await x.send("/takeover", x.takeoverBody(current.registryRevision));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, "TAKEOVER_AUTHORIZATION_STALE");
});
test("authorized replacement completes already-merged candidate; old Session cannot close", async (t) => {
  const x = await setup(t, { mergedGit: true });
  assert.equal((await allowed(x)).status, 200);
  const current = await x.get();
  const takeover = await x.send("/takeover", x.takeoverBody(current.registryRevision));
  assert.equal(takeover.status, 200, JSON.stringify(takeover.data));
  assert.equal(takeover.data.after.status, "待交付");
  assert.equal((await preclaim(x, "new-dev", "wc_sess_new")).status, 200);
  const claimed = await claim(x, "new-dev", "wc_sess_new", "delivery.complete.new.claim");
  assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
  assert.equal(claimed.data.after.status, "交付中");
  const reportPath = "reports/D-PENDING/post-merge.md";
  const report = "结论：PASS\n候选SHA：" + x.sha + "\nmain SHA：" + x.sha + "\n";
  await fs.writeFile(path.join(x.fixture.projectRoot, reportPath), report);
  const attempts = async (actorId, sessionId, operationId) => {
    const now = await x.get();
    const response = await fetch(x.base + x.root, {
      method: "PATCH", headers: x.bearer, body: JSON.stringify({
        operationId, eventType: "delivery_complete", expectedRevision: now.registryRevision,
        actorType: "developer_ai", actorId, sessionId, patch: { status: "已完成" },
        metadata: { postMergeReportPath: reportPath, postMergeRegressionResult: "PASS" }
      })
    });
    return { status: response.status, data: await response.json() };
  };
  const old = await attempts("old-dev", "wc_sess_old", "delivery.complete.old.denied");
  assert.equal(old.status, 409);
  const fresh = await attempts("new-dev", "wc_sess_new", "delivery.complete.new.valid");
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.equal(fresh.data.after.status, "已完成");
  assert.equal(fresh.data.after.assignee, "");
  const events = await x.app.taskStore.taskHistory("fixture", "D-PENDING", { all: true });
  assert.equal(events.at(-1).event_type, "delivery_complete");
  assert.equal(events.at(-1).metadata.candidateCommitSha, x.sha);
});
