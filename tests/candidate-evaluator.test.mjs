import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeFixture, registryText } from "./helpers.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";

const exec = promisify(execFile);
const git = async (dir, ...args) => (await exec("git", ["-C", dir, ...args],
  { encoding: "utf8", windowsHide: true })).stdout.trim();

async function setup(t) {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const rows = [
    ["UP-10", "upstream", "infrastructure", "P0", "待独测", "独立测试AI",
      "—", "—", "—", "—", "等待上游独测", "测试计划.md", "cp/UP-10.md"],
    ["DOWN-10", "downstream", "infrastructure", "P0", "待开发", "开发AI",
      "—", "—", "—", "—", "下游独立预开发", "测试计划.md", "cp/DOWN-10.md"]
  ];
  await fs.writeFile(f.registryPath, registryText(rows).replace("read/DOWN-10.md", "UP-10完成"));
  await git(f.projectRoot, "init", "--initial-branch=main");
  await git(f.projectRoot, "config", "user.name", "Provisional Fixture");
  await git(f.projectRoot, "config", "user.email", "provisional@example.test");
  await git(f.projectRoot, "add", "-A");
  await git(f.projectRoot, "commit", "-m", "fixture");
  const baseSha = await git(f.projectRoot, "rev-parse", "HEAD");
  const worktree = path.join(f.boardRoot, "provisional-isolated-dev");
  await git(f.projectRoot, "worktree", "add", "--detach", worktree, baseSha);
  const store = await new TaskStore(f.boardRoot).init();
  const requirements = await new RequirementStore(f.boardRoot).init();
  const evaluator = new CandidateEvaluator(f.boardRoot, { taskStore: store, requirementStore: requirements });
  const candidate = async () => (await evaluator.evaluateProject("fixture")).candidates
    .find((item) => item.task_id === "DOWN-10");
  const claim = async (actorId = "dev-provisional", sessionId = "session-provisional") => {
    const snapshot = await store.snapshot("fixture");
    return store.updateTask("fixture", "DOWN-10", {
      status: "开发中", assignee: actorId, sessionWindowName: "isolated-worktree", sessionId
    }, {
      expectedRevision: snapshot.registryRevision, operationId: "provisional.claim." + actorId,
      eventType: "claim", actorType: "developer_ai", actorId, sessionId
    });
  };
  return { f, baseSha, worktree, store, evaluator, candidate, claim };
}

async function authorize(f, overrides = {}) {
  const user = await f.store.appendTaskEvent("fixture", "DOWN-10", {
    operationId: "provisional.user.approve.0001", eventType: "user_review",
    actorType: "user", actorId: "real-user", note: "允许独立工作区提前开发",
    metadata: { approveProvisionalDevelopment: true }
  });
  await f.store.appendTaskEvent("fixture", "DOWN-10", {
    operationId: "provisional.controller.reply.0001", eventType: "user_message_reply",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller-session",
    note: "已阅读并按任务范围处理临时授权留言",
    metadata: { replyToEventId: user.event.event_id }
  });
  const metadata = {
    taskId: "DOWN-10", userAuthorizationEventId: user.event.event_id,
    upstreamTaskIds: ["UP-10"], baseSha: f.baseSha,
    worktreeName: path.basename(f.worktree),
    developerActorId: "dev-provisional", developerSessionId: "session-provisional",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...overrides
  };
  const controller = await f.store.appendTaskEvent("fixture", "DOWN-10", {
    operationId: "provisional.controller.authorize.0001",
    eventType: "controller_provisional_dev_authorization",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller-session",
    metadata
  });
  return controller.event.event_id;
}

test("R1: pending upstream blocks normal claim, but real user+controller+worktree grant enables provisional claim", async (t) => {
  const f = await setup(t);
  const before = await f.candidate();
  assert.equal(before.eligible, false);
  assert.match(before.blockers.join(" "), /前置任务/);
  await assert.rejects(f.claim(), (error) => error.code === "CLAIM_DEPENDENCY_NOT_COMPLETED");
  const eventId = await authorize(f);
  const authorized = await f.candidate();
  assert.equal(authorized.eligible, true);
  assert.equal(authorized.provisional, true);
  assert.equal(authorized.provisional_authorization_event_id, eventId);
  assert.equal(authorized.eligible_actor_id, "dev-provisional");
  assert.equal((await f.evaluator.recheck(authorized)).ok, true);
  const result = await f.claim();
  assert.equal(result.after.status, "开发中");
  assert.equal(result.after.sessionId, "session-provisional");
  const events = await f.store.taskHistory("fixture", "DOWN-10", { all: true });
  const claimed = events.findLast((event) => event.event_type === "claim");
  assert.equal(claimed.metadata.provisionalClaim, true);
  assert.equal(claimed.metadata.provisionalAuthorizationEventId, eventId);
  assert.deepEqual((await f.store.getTask("fixture", "DOWN-10")).task.readDependencies, "UP-10完成");
});

test("R2: spoofed Session, wrong base or worktree, expired and revoked authorization never grant claim", async (t) => {
  const f = await setup(t);
  const approval = await authorize(f);
  assert.ok(approval);
  await assert.rejects(f.claim("another-dev", "another-session"),
    (error) => error.code === "CLAIM_DEPENDENCY_NOT_COMPLETED");
  await f.store.appendTaskEvent("fixture", "DOWN-10", {
    operationId: "provisional.user.revoked.0001",
    eventType: "user_provisional_dev_revoked", actorType: "user", actorId: "real-user"
  });
  assert.equal((await f.candidate()).eligible, false);
  await assert.rejects(f.claim(), (error) => error.code === "CLAIM_DEPENDENCY_NOT_COMPLETED");
});

test("R2: bad worktree and expiration independently fail before any registry mutation", async (t) => {
  for (const overrides of [
    { worktreeName: "not-a-real-worktree" },
    { expiresAt: "2001-01-01T00:00:00.000Z" },
    { baseSha: "b".repeat(40) },
    { upstreamTaskIds: ["UNRELATED-10"] },
    { userAuthorizationEventId: "evt_forged_authorization" }
  ]) {
    const f = await setup(t);
    await authorize(f, overrides);
    assert.equal((await f.candidate()).eligible, false);
    await assert.rejects(f.claim(), (error) => error.code === "CLAIM_DEPENDENCY_NOT_COMPLETED");
    assert.equal((await f.store.getTask("fixture", "DOWN-10")).task.status, "待开发");
  }
});

test("R3: unfinished upstream cannot use provisional claim to reach QA or completion", async (t) => {
  const f = await setup(t);
  await authorize(f);
  await f.claim();
  const status = await f.store.snapshot("fixture");
  await assert.rejects(f.store.updateTask("fixture", "DOWN-10", {
    status: "待独测"
  }, {
    expectedRevision: status.registryRevision,
    operationId: "provisional.handoff.blocked.0001",
    eventType: "handoff", actorType: "developer_ai",
    actorId: "dev-provisional", sessionId: "session-provisional",
    metadata: {
      atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
    }
  }), (error) => error.code === "PROVISIONAL_UPSTREAM_NOT_COMPLETE");
  assert.equal((await f.store.getTask("fixture", "DOWN-10")).task.status, "开发中");
});


test("R1: a pending requirement does not erase otherwise eligible developer and QA candidates", async (t) => {
  const f = await setup(t);
  await authorize(f);
  f.evaluator.requirementStore.pending = async () => ({
    pendingCount: 2, waitingUserCount: 0, items: [
      { id: "REQ-ONE", status: "待AI拆解" },
      { id: "REQ-TWO", status: "待AI拆解" }
    ]
  });
  const scan = await f.evaluator.evaluateProject("fixture");
  assert.equal(scan.watch.pending_requirements, 2, "unprocessed requests remain visible to controller");
  const dev = scan.candidates.find(item => item.task_id === "DOWN-10");
  const qa = scan.candidates.find(item => item.task_id === "UP-10");
  assert.ok(dev);
  assert.ok(qa);
  assert.equal(dev.eligible, true, "unrelated pending requirements cannot remove legal developer candidate");
  assert.equal(dev.provisional, true);
  assert.equal(dev.blockers.some(item => item.includes("待AI拆解")), false);
  assert.equal(qa.blockers.some(item => item.includes("待AI拆解")), false,
    "independent QA remains subject to real QA evidence, not unrelated request intake");
});

test("R2: pending requirement never weakens STOP, hard dependencies or identity gates", async (t) => {
  const f = await setup(t);
  f.evaluator.requirementStore.pending = async () => ({ pendingCount: 1, waitingUserCount: 0 });
  const upstream = await f.candidate();
  assert.equal(upstream.eligible, false);
  assert.match(upstream.blockers.join(" "), /前置任务/);
  await authorize(f);
  const eligible = await f.candidate();
  assert.equal(eligible.eligible, true);
  await f.store.appendTaskEvent("fixture", "DOWN-10", {
    operationId: "pending.req.stop.20261106.0001",
    eventType: "stop_request", actorType: "user", actorId: "real-user",
    note: "User STOP must still block the claim"
  });
  const stopped = await f.candidate();
  assert.equal(stopped.eligible, false);
  assert.match(stopped.blockers.join(" "), /stop_request/);
});
