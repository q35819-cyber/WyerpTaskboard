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
  await fs.writeFile(path.join(fixture.projectRoot, ".gitignore"), "tasks.md\nreports/\n");
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
async function setup(t, { pass = true, missingReport = false, mergedGit = true, passShaOverride = null } = {}) {
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
      deliveryActions: ["candidate_merge"], commitSha: passShaOverride ?? sha, headBranch: "feature/qa",
      reportPath: "reports/D-PENDING/qa-pass.md"
    });
  }
  if (!missingReport) {
    await fs.mkdir(path.join(fixture.projectRoot, "reports", "D-PENDING"), { recursive: true });
    await fs.writeFile(path.join(fixture.projectRoot, "reports", "D-PENDING", "qa-pass.md"), "结论：PASS\n候选SHA：" + (passShaOverride ?? sha) + "\n");
  } else {
    await fs.rm(path.join(fixture.projectRoot, "reports", "D-PENDING", "qa-pass.md"), { force: true });
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

test("a QA report with explicit FAIL verdict cannot reuse historic PASS", async (t) => {
  const x = await setup(t, { mergedGit: true });
  await fs.writeFile(path.join(x.fixture.projectRoot, "reports/D-PENDING/qa-pass.md"),
    "结论：FAIL\n说明：此前PASS已失效，不可用于交付\n候选SHA：" + x.sha + "\n");
  assert.equal((await allowed(x)).status, 200);
  const result = await x.send("/takeover", x.takeoverBody((await x.get()).registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待独测");
  assert.equal(result.data.requiresIndependentRetest, true);
});

test("a BLOCKED QA verdict cannot reuse historic PASS", async (t) => {
  const x = await setup(t, { mergedGit: true });
  await fs.writeFile(path.join(x.fixture.projectRoot, "reports/D-PENDING/qa-pass.md"),
    "结论：BLOCKED\n原测试状态：PASS，现因证据损坏无法确认\n候选SHA：" + x.sha + "\n");
  assert.equal((await allowed(x)).status, 200);
  const result = await x.send("/takeover", x.takeoverBody((await x.get()).registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待独测");
  assert.equal(result.data.requiresIndependentRetest, true);
});

test("contradictory explicit final verdict must not preserve an older PASS", async (t) => {
  const x = await setup(t, { mergedGit: true });
  await fs.writeFile(path.join(x.fixture.projectRoot, "reports/D-PENDING/qa-pass.md"),
    "## 结论：PASS\n初测通过，但后来发现失效\n**最终结论：FAIL**\n候选SHA：" + x.sha + "\n");
  assert.equal((await allowed(x)).status, 200);
  const result = await x.send("/takeover", x.takeoverBody((await x.get()).registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待独测");
  assert.equal(result.data.requiresIndependentRetest, true);
});

test("a historic PASS mention without any explicit QA verdict cannot authorize delivery", async (t) => {
  const x = await setup(t, { mergedGit: true });
  await fs.writeFile(path.join(x.fixture.projectRoot, "reports/D-PENDING/qa-pass.md"),
    "历史测试PASS，待复核\n候选SHA：" + x.sha + "\n");
  assert.equal((await allowed(x)).status, 200);
  const result = await x.send("/takeover", x.takeoverBody((await x.get()).registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待独测");
  assert.equal(result.data.requiresIndependentRetest, true);
});

test("explicit bold Markdown QA PASS with matching SHA remains valid", async (t) => {
  const x = await setup(t, { mergedGit: true });
  await fs.writeFile(path.join(x.fixture.projectRoot, "reports/D-PENDING/qa-pass.md"),
    "## **结论：PASS**。\n候选SHA：" + x.sha + "\n");
  assert.equal((await allowed(x)).status, 200);
  const result = await x.send("/takeover", x.takeoverBody((await x.get()).registryRevision));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.after.status, "待交付");
  assert.equal(result.data.requiresIndependentRetest, false);
});
