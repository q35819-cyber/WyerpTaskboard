import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskboardServer } from "../server/http-server.mjs";
import { staleTakeoverWindow } from "../server/task-store.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

const NOW = Date.parse("2026-11-03T00:00:00.000Z");
const exec = promisify(execFile);
const oldEvent = (minutes, type = "claim") => ({
  event_type: type, timestamp: new Date(NOW - minutes * 60000).toISOString(),
  event_id: "event-old", actor_type: "developer_ai", actor_id: "old-dev", session_id: "old-session"
});

test("24h deadline uses strict greater-than and ignores heartbeats, preclaim and repeated reporting", () => {
  const task = { status: "开发中" };
  for (const minutes of [1439 + 59 / 60, 1440]) {
    assert.equal(staleTakeoverWindow(task, [oldEvent(minutes)], NOW).eligible, false);
  }
  const events = [oldEvent(1440 + 1 / 60000),
    { ...oldEvent(2, "preclaim_report"), event_id: "heartbeat" },
    { ...oldEvent(1, "delivery_attempt_failed"), event_id: "report" }];
  assert.equal(staleTakeoverWindow(task, events, NOW).eligible, true);
  assert.equal(staleTakeoverWindow(task, [{ ...oldEvent(1441), timestamp: "not-a-date" }], NOW).reason, "progress_time_unverified");
  assert.equal(staleTakeoverWindow(task, [oldEvent(1441),
    { ...oldEvent(1, "stop_request"), event_id: "stopped" }], NOW).reason, "user_stop_or_revoke");
  assert.equal(staleTakeoverWindow({ status: "HOLD" }, [oldEvent(2000)], NOW).eligible, false);
});

test("completed cleanup needs a real completion event, cannot reopen or claim twice", () => {
  const task = { status: "已完成" };
  assert.equal(staleTakeoverWindow(task, [oldEvent(1500)], NOW).eligible, false);
  const completed = { ...oldEvent(1500, "delivery_complete"), new_status: "已完成" };
  assert.equal(staleTakeoverWindow(task, [completed], NOW).eligible, true);
  assert.equal(staleTakeoverWindow(task, [completed, oldEvent(1, "cleanup_takeover")], NOW).reason, "cleanup_already_claimed");
});

test("HTTP: standing user authority can hand stale active work to a new developer once", async t => {
  const fx = await makeFixture();
  const git = (...args) => exec("git", ["-C", fx.projectRoot, ...args], { encoding: "utf8", windowsHide: true });
  await fs.writeFile(path.join(fx.projectRoot, ".gitignore"), "tasks.md\n", "utf8");
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Takeover fixture");
  await git("config", "user.email", "takeover-fixture@example.test");
  await git("add", ".gitignore");
  await git("commit", "-m", "fixture baseline");
  const nextWorktree = path.join(fx.boardRoot, "new-isolated");
  await git("worktree", "add", "--detach", nextWorktree, "HEAD");
  const app = await createTaskboardServer({ rootDir: fx.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(fx.boardRoot, { recursive: true, force: true });
  });
  const auth = JSON.parse(await fs.readFile(fx.boardRoot + "/config/admin-secret.json", "utf8")).adminSecret;
  const headers = { Authorization: "Bearer " + auth, "Content-Type": "application/json" };
  const base = "http://127.0.0.1:" + app.server.address().port;
  const url = base + "/api/projects/fixture/tasks/B-10";
  const current = async () => (await (await fetch(url, { headers })).json());
  await app.taskStore.events.append("fixture", {
    operation_id: "stale.fixture.claim.001", project_id: "fixture", task_id: "B-10",
    event_type: "claim", timestamp: "2020-01-01T00:00:00.000Z",
    actor_type: "developer_ai", actor_id: "old-dev", session_id: "old-session",
    new_status: "开发中"
  });
  const before = await current();
  const body = {
    operationId: "stale.fixture.takeover.001", expectedRevision: before.registryRevision,
    actorType: "developer_ai", actorId: "new-dev", assignee: "new-dev",
    sessionId: "wc_sess_new", sessionWindowName: "new-window",
    previousWorktree: fx.projectRoot, nextWorktree,
    liveInspection: "verified no active Job; old source is preserved"
  };
  const wrongRole = await fetch(url + "/takeover", {
    method: "POST", headers, body: JSON.stringify({
      ...body, operationId: "stale.fixture.wrong-role.001", actorType: "test_ai"
    })
  });
  assert.equal(wrongRole.status, 409);
  assert.equal((await wrongRole.json()).error.code, "STALE_TAKEOVER_IDENTITY_INVALID");
  const bogusWorktree = await fetch(url + "/takeover", {
    method: "POST", headers, body: JSON.stringify({
      ...body, operationId: "stale.fixture.wrong-worktree.001",
      nextWorktree: path.join(fx.boardRoot, "not-registered")
    })
  });
  assert.equal(bogusWorktree.status, 409);
  assert.equal((await bogusWorktree.json()).error.code, "STALE_TAKEOVER_WORKTREE_INVALID");
  await app.taskStore.events.append("fixture", {
    operation_id: "stale.fixture.live.job.001", project_id: "fixture", task_id: "B-10",
    event_type: "test_resource_preserved", timestamp: new Date().toISOString(),
    metadata: { resourceId: "still-active-job", resourceType: "process", safetyStatus: "risk" }
  });
  const activeJob = await fetch(url + "/takeover", {
    method: "POST", headers, body: JSON.stringify({ ...body, operationId: "stale.fixture.active-job.001" })
  });
  assert.equal(activeJob.status, 409);
  assert.equal((await activeJob.json()).error.code, "STALE_TAKEOVER_ACTIVE_RESOURCE");
  await app.taskStore.events.append("fixture", {
    operation_id: "stale.fixture.job.cleaned.001", project_id: "fixture", task_id: "B-10",
    event_type: "test_resource_cleaned", timestamp: new Date().toISOString(),
    metadata: { resourceId: "still-active-job" }
  });
  const reply = await fetch(url + "/takeover", {
    method: "POST", headers, body: JSON.stringify(body)
  });
  assert.equal(reply.status, 200, JSON.stringify(await reply.json()));
  const after = await current();
  assert.equal(after.status, "开发中");
  assert.equal(after.assignee, "new-dev");
  assert.equal(after.sessionId, "wc_sess_new");
  const repeated = await fetch(url + "/takeover", {
    method: "POST", headers, body: JSON.stringify({ ...body, operationId: "stale.fixture.takeover.002",
      expectedRevision: after.registryRevision, actorId: "different-dev", assignee: "different-dev", sessionId: "another-session" })
  });
  assert.equal(repeated.status, 409);
});

test("HTTP: completed task grants cleanup-only ownership after remote merge; dirty workspace refuses", async t => {
  const fx = await makeFixture();
  await fs.writeFile(fx.registryPath, registryText([
    ["C-CLEANUP", "F-CLEANUP", "infrastructure", "P0", "已完成", "", "", "", "",
      "2020-01-01T00:00:00Z", "已完成但工作区未清理", "测试计划.md", "cp/C-CLEANUP.md"]
  ]), "utf8");
  await fs.writeFile(path.join(fx.projectRoot, ".gitignore"), "tasks.md\n", "utf8");
  const git = (...args) => exec("git", ["-C", fx.projectRoot, ...args], { encoding: "utf8", windowsHide: true });
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Cleanup fixture");
  await git("config", "user.email", "cleanup-fixture@example.test");
  await git("add", "-A");
  await git("commit", "-m", "merged fixture");
  const candidateSha = (await git("rev-parse", "HEAD")).stdout.trim();
  const bare = path.join(fx.boardRoot, "origin.git");
  await exec("git", ["init", "--bare", "--initial-branch=main", bare], { encoding: "utf8", windowsHide: true });
  await git("remote", "add", "origin", bare);
  await git("push", "origin", "main");
  await exec("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const nextWorktree = path.join(fx.boardRoot, "cleanup-worker");
  await git("worktree", "add", "--detach", nextWorktree, "HEAD");
  const app = await createTaskboardServer({ rootDir: fx.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(fx.boardRoot, { recursive: true, force: true });
  });
  await app.taskStore.events.append("fixture", {
    operation_id: "cleanup.fixture.completed.001", project_id: "fixture", task_id: "C-CLEANUP",
    event_type: "delivery_complete", timestamp: "2020-01-01T00:00:00.000Z",
    actor_type: "controller_ai", actor_id: "old-controller", session_id: "old-session",
    new_status: "已完成", metadata: { candidateCommitSha: candidateSha }
  });
  const secret = JSON.parse(await fs.readFile(path.join(fx.boardRoot, "config", "admin-secret.json"), "utf8")).adminSecret;
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const route = "http://127.0.0.1:" + app.server.address().port +
    "/api/projects/fixture/tasks/C-CLEANUP";
  const current = async () => (await (await fetch(route, { headers })).json());
  const before = await current();
  const body = {
    operationId: "cleanup.fixture.claim.001", expectedRevision: before.registryRevision,
    actorType: "controller_ai", actorId: "new-controller", sessionId: "new-session",
    previousWorktree: fx.projectRoot, nextWorktree,
    liveInspection: "checked worktrees; no active jobs or open PR", note: "only claim cleanup ownership"
  };
  await fs.writeFile(path.join(fx.projectRoot, "unsaved.txt"), "uncommitted material", "utf8");
  const dirty = await fetch(route + "/takeover", { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(dirty.status, 409);
  assert.equal((await dirty.json()).error.code, "STALE_CLEANUP_WORKTREE_UNSAFE");
  await fs.rm(path.join(fx.projectRoot, "unsaved.txt"));
  const ok = await fetch(route + "/takeover", {
    method: "POST", headers, body: JSON.stringify({ ...body, operationId: "cleanup.fixture.claim.002" })
  });
  const result = await ok.json();
  assert.equal(ok.status, 200, JSON.stringify(result));
  assert.equal(result.cleanupOnly, true);
  assert.equal(result.deletionAuthorized, false);
  const after = await current();
  assert.equal(after.status, "已完成");
  const history = await app.taskStore.taskHistory("fixture", "C-CLEANUP", { all: true });
  const cleanup = history.filter(x => x.event_type === "cleanup_takeover");
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].metadata.cleanupOnly, true);
  assert.equal(cleanup[0].metadata.deletionAuthorized, false);
  assert.equal(await fs.stat(fx.projectRoot).then(x => x.isDirectory()), true);
  const replay = await fetch(route + "/takeover", {
    method: "POST", headers, body: JSON.stringify({ ...body, operationId: "cleanup.fixture.claim.003",
      expectedRevision: after.registryRevision, actorId: "another-controller", sessionId: "another-session" })
  });
  assert.equal(replay.status, 409);
});

test("HTTP: stale QA-passed delivery retains fixed candidate for a new controller, without merging", async t => {
  const fx = await makeFixture();
  await fs.writeFile(fx.registryPath, registryText([
    ["D-STALE", "F-STALE", "infrastructure", "P0", "待交付", "总控AI", "", "", "",
      "2020-01-01T00:00:00Z", "QA PASS候选等总控交付", "测试计划.md", "cp/D-STALE.md"]
  ]), "utf8");
  await fs.writeFile(path.join(fx.projectRoot, ".gitignore"), "tasks.md\nreports/\n", "utf8");
  const git = (...args) => exec("git", ["-C", fx.projectRoot, ...args], { encoding: "utf8", windowsHide: true });
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Delivery stale fixture");
  await git("config", "user.email", "stale-qa@example.test");
  await git("add", "-A");
  await git("commit", "-m", "initial");
  const bare = path.join(fx.boardRoot, "origin.git");
  await exec("git", ["init", "--bare", "--initial-branch=main", bare], { windowsHide: true });
  await git("remote", "add", "origin", bare);
  await git("push", "origin", "main");
  await exec("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git("switch", "-c", "feature/stale-qa");
  await fs.writeFile(path.join(fx.projectRoot, "candidate.js"), "export default true;\n");
  await git("add", "candidate.js");
  await git("commit", "-m", "candidate");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  await git("push", "origin", "feature/stale-qa");
  await git("switch", "main");
  const newWorktree = path.join(fx.boardRoot, "controller-new");
  await git("worktree", "add", "--detach", newWorktree, "main");
  await fs.mkdir(path.join(fx.projectRoot, "reports", "D-STALE"), { recursive: true });
  const qaReport = "reports/D-STALE/qa-pass.md";
  await fs.writeFile(path.join(fx.projectRoot, qaReport), "结论：PASS\n候选SHA：" + sha + "\n");
  const app = await createTaskboardServer({ rootDir: fx.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(fx.boardRoot, { recursive: true, force: true });
  });
  const seed = async (op, type, actorType, actorId, sessionId, metadata, status) =>
    app.taskStore.events.append("fixture", {
      operation_id: op, project_id: "fixture", task_id: "D-STALE",
      event_type: type, timestamp: "2020-01-01T00:00:00.000Z",
      actor_type: actorType, actor_id: actorId, session_id: sessionId, metadata, new_status: status
    });
  await seed("delivery.stale.handoff.001", "handoff", "developer_ai", "old-dev", "old-dev-session",
    { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }, "待独测");
  await seed("delivery.stale.qa.claim.001", "claim", "test_ai", "old-qa", "old-qa-session",
    { claimedFromStatus: "待独测" }, "独测中");
  await seed("delivery.stale.qa.pass.001", "test_result", "test_ai", "old-qa", "old-qa-session", {
    atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required",
    deliveryActions: ["candidate_merge"], commitSha: sha,
    headBranch: "feature/stale-qa", reportPath: qaReport
  }, "待交付");
  const secret = JSON.parse(await fs.readFile(path.join(fx.boardRoot, "config", "admin-secret.json"), "utf8")).adminSecret;
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const url = "http://127.0.0.1:" + app.server.address().port + "/api/projects/fixture/tasks/D-STALE";
  const current = async () => (await (await fetch(url, { headers })).json());
  const before = await current();
  const response = await fetch(url + "/takeover", { method: "POST", headers, body: JSON.stringify({
    operationId: "delivery.stale.controller.001", expectedRevision: before.registryRevision,
    actorType: "controller_ai", actorId: "new-controller", assignee: "controller",
    sessionId: "controller-session", sessionWindowName: "controller-window",
    previousWorktree: fx.projectRoot, nextWorktree: newWorktree,
    liveInspection: "no active Job, isolated controller worktree verified"
  }) });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.requiresIndependentRetest, false);
  assert.equal(result.after.status, "待交付");
  const events = await app.taskStore.taskHistory("fixture", "D-STALE", { all: true });
  const takeover = events.find(x => x.event_type === "takeover");
  assert.equal(takeover.metadata.candidateSha, sha);
  assert.equal(takeover.metadata.standingUserAuthorization, true);
  assert.equal(events.filter(x => x.event_type === "test_result").length, 1);
  assert.equal((await git("rev-parse", "main")).stdout.trim() !== sha, true);
  const report = await fetch(url + "/preclaim-report", { method: "POST", headers, body: JSON.stringify({
    operationId: "delivery.stale.preclaim.001", actorType: "controller_ai",
    actorId: "new-controller", sessionId: "controller-session", note: "reviewed fixed QA candidate"
  }) });
  assert.equal(report.status, 200);
  const after = await current();
  const claim = await fetch(url + "/claim", { method: "POST", headers, body: JSON.stringify({
    operationId: "delivery.stale.claim.001", expectedRevision: after.registryRevision,
    actorType: "controller_ai", actorId: "new-controller", assignee: "controller",
    sessionId: "controller-session", sessionWindowName: "controller-window"
  }) });
  assert.equal(claim.status, 200, JSON.stringify(await claim.json()));
  assert.equal((await current()).status, "交付中");
});
