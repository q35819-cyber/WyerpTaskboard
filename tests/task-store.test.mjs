import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { TaskStore } from "../server/task-store.mjs";
import { TaskStepCheckpoint } from "../server/task-step-checkpoint.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

test("v2 step evidence gates formal claim and handoff before mutation", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore: store }).init();
  let n = 0;
  const record = async (role, stepId, eventId = null) => {
    const current = await cp.show("fixture", "A-10");
    return cp.record("fixture", "A-10", {
      operationId: "gate.step." + String(++n).padStart(4, "0"),
      expectedSha256: current.sha256, stepId, actorType: role,
      actorId: role === "controller_ai" ? "controller" : "developer",
      sessionId: role === "controller_ai" ? "controller-session" : "developer-session",
      evidence: "真实步骤验证证据 " + stepId, eventId
    });
  };
  await record("controller_ai", "C00_A_REQUIREMENTS");
  const initial = await store.snapshot("fixture");
  const claimPatch = { status: "开发中", assignee: "developer",
    sessionWindowName: "dev", sessionId: "developer-session" };
  const claimOptions = { expectedRevision: initial.registryRevision, operationId: "gate.claim.0001",
    eventType: "claim", actorType: "developer_ai", actorId: "developer",
    sessionId: "developer-session" };
  await assert.rejects(store.updateTask("fixture", "A-10", claimPatch, claimOptions),
    (error) => error.code === "CHECKPOINT_STEP_EVIDENCE_REQUIRED");
  assert.equal((await store.snapshot("fixture")).registryRevision, initial.registryRevision);
  assert.equal(await store.transactions.read(claimOptions.operationId), null);
  for (const id of ["C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP", "C01_SCAN", "C02_TRIAGE"]) {
    await record("controller_ai", id);
  }
  const dispatch = await store.appendTaskEvent("fixture", "A-10", {
    operationId: "gate.dispatch.0001", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller",
    sessionId: "controller-session", note: "正式开发派工"
  });
  await record("controller_ai", "C03_DISPATCH", dispatch.event.event_id);
  const claim = await store.updateTask("fixture", "A-10", claimPatch, claimOptions);
  assert.equal(claim.after.status, "开发中");
  await record("developer_ai", "D01_CLAIM", claim.eventId);
  for (const id of ["D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1", "D06_TEST_2"]) {
    await record("developer_ai", id);
  }
  const beforeHandoff = await store.snapshot("fixture");
  const handoffPatch = { status: "待独测", assignee: "", sessionWindowName: "", sessionId: "" };
  const handoffOptions = { expectedRevision: beforeHandoff.registryRevision,
    operationId: "gate.handoff.0001", eventType: "handoff",
    actorType: "developer_ai", actorId: "developer", sessionId: "developer-session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" } };
  await assert.rejects(store.updateTask("fixture", "A-10", handoffPatch, handoffOptions),
    (error) => error.code === "CHECKPOINT_STEP_EVIDENCE_REQUIRED");
  assert.equal((await store.snapshot("fixture")).registryRevision, beforeHandoff.registryRevision);
  assert.equal(await store.transactions.read(handoffOptions.operationId), null);
  await record("developer_ai", "D07_TEST_3");
  const handoff = await store.updateTask("fixture", "A-10", handoffPatch, handoffOptions);
  assert.equal(handoff.after.status, "待独测");
});

test("snapshot sorts product/P0 before infrastructure/P0", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const snap = await store.snapshot("fixture");
  assert.deepEqual(snap.tasks.slice(0, 2).map((x) => x.id), ["A-10","B-10"]);
  assert.ok(snap.tasks.some((x) => x.id === "T-01"));
});

test("update writes registry, event and committed journal", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const before = await store.snapshot("fixture");
  const result = await store.updateTask("fixture", "B-10", { priority: "P1" }, {
    expectedRevision: before.registryRevision,
    operationId: "op.update.0001",
    eventType: "priority_change",
    actorType: "user",
    actorId: "owner"
  });
  assert.equal(result.after.priority, "P1");
  const after = await store.snapshot("fixture");
  assert.equal(after.tasks.find((x) => x.id === "B-10").priority, "P1");
  const event = await store.events.findByOperationId("fixture", "op.update.0001");
  assert.equal(event.event_type, "priority_change");
  const tx = await store.transactions.read("op.update.0001");
  assert.equal(tx.state, "committed");
  assert.equal((await store.events.verifyProject("fixture")).ok, true);
});

test("same operation id is idempotent and does not duplicate event", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const before = await store.snapshot("fixture");
  const args = {
    expectedRevision: before.registryRevision,
    operationId: "op.idem.0001",
    eventType: "priority_change"
  };
  const first = await store.updateTask("fixture", "B-10", { priority: "P1" }, args);
  const second = await store.updateTask("fixture", "B-10", { priority: "P1" }, args);
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal((await store.events.verifyProject("fixture")).events, 1);
});

test("stale registry revision is rejected", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  await assert.rejects(
    store.updateTask("fixture", "B-10", { priority: "P1" }, {
      expectedRevision: "0".repeat(64),
      operationId: "op.stale.0001"
    }),
    (error) => error.code === "REVISION_CONFLICT" && error.status === 409
  );
});

test("stale registry revision never blocks a user write", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const stale = await store.snapshot("fixture");

  await store.updateTask("fixture", "A-10", { priority: "P1" }, {
    expectedRevision: stale.registryRevision,
    operationId: "op.ai.moves.registry.0001",
    eventType: "priority_change",
    actorType: "developer_ai",
    actorId: "dev-a"
  });

  const result = await store.updateTask("fixture", "B-10", { priority: "P2" }, {
    expectedRevision: stale.registryRevision,
    operationId: "op.user.stale.never.blocked.0001",
    eventType: "priority_change",
    actorType: "user",
    actorId: "owner"
  });
  assert.equal(result.after.priority, "P2");
  const after = await store.snapshot("fixture");
  assert.equal(after.tasks.find((x) => x.id === "A-10").priority, "P1", "AI change must be preserved");
  assert.equal(after.tasks.find((x) => x.id === "B-10").priority, "P2", "user change must win without refresh");
  const event = await store.events.findByOperationId("fixture", "op.user.stale.never.blocked.0001");
  assert.equal(event.actor_type, "user");
  assert.equal(event.metadata.user_revision_rebased, true);
  assert.equal(event.metadata.stale_expected_revision, stale.registryRevision);
});

test("invalid workflow transition is rejected before journal side effects", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const before = await store.snapshot("fixture");
  await assert.rejects(
    store.updateTask("fixture", "B-10", { status: "已完成" }, {
      expectedRevision: before.registryRevision,
      operationId: "op.badflow.0001"
    }),
    (error) => error.code === "INVALID_STATUS_TRANSITION"
  );
  assert.equal(await store.transactions.read("op.badflow.0001"), null);
});


test("TaskStore normalizes status role and ownership invariants", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  let snap = await store.snapshot("fixture");
  let moved = await store.updateTask("fixture", "T-01", {
    status: "独测中", assignee: "tester", sessionWindowName: "独测窗口", sessionId: "sess-store-test"
  }, { expectedRevision: snap.registryRevision, operationId: "op.state.enter.test.0001", eventType: "claim", actorType: "test_ai", actorId: "tester", sessionWindowName: "独测窗口", sessionId: "sess-store-test" });
  assert.equal(moved.after.status, "独测中");
  assert.equal(moved.after.plannedRole, "独立测试AI");

  snap = await store.snapshot("fixture");
  await assert.rejects(() => store.updateTask("fixture", "T-01", { status: "待准备" }, { expectedRevision: snap.registryRevision, operationId: "op.state.leave.test.0001" }), (error) => error.code === "ATOMIC_TEST_RESULT_REQUIRED");
  moved = await store.updateTask("fixture", "T-01", { status: "阻断" }, {
    expectedRevision: snap.registryRevision,
    operationId: "op.state.leave.test.0002",
    eventType: "test_result",
    actorType: "test_ai",
    actorId: "tester",
    sessionId: "sess-store-test",
    metadata: { atomicLifecycle: true, testResult: "blocked", reportPath: "reports/T-01/blocked.md" }
  });
  assert.equal(moved.after.status, "阻断");
  assert.equal(moved.after.plannedRole, "");
  assert.equal(moved.after.assignee, "");
  assert.equal(moved.after.sessionWindowName, "");
  assert.equal(moved.after.sessionId, "");
});

test("TaskStore rejects execution status without identity and conflicting role", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  let snap = await store.snapshot("fixture");
  await assert.rejects(
    store.updateTask("fixture", "A-10", { status: "开发中" }, {
      expectedRevision: snap.registryRevision, operationId: "op.state.no.identity.0001"
    }),
    (error) => error.code === "FORMAL_CLAIM_REQUIRED"
  );
  snap = await store.snapshot("fixture");
  await assert.rejects(
    store.updateTask("fixture", "A-10", { plannedRole: "独立测试AI" }, {
      expectedRevision: snap.registryRevision, operationId: "op.state.bad.role.0001"
    }),
    (error) => error.code === "STATUS_ROLE_MISMATCH"
  );
});

test("task plan reader uses registered plan path and rejects traversal", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();

  const plan = await store.readTaskPlan("fixture", "B-10", 0);
  assert.equal(plan.name, "任务看板与AI协作控制开发计划.md");
  assert.match(plan.content, /B-10夹具计划内容/);

  const escapedRows = [
    ["X-01","F-X","product","P0","待开发","开发AI","—","—","—","—","越界计划","../outside.md","cp/X-01.md"]
  ];
  await fs.writeFile(f.registryPath, registryText(escapedRows), "utf8");
  await assert.rejects(
    () => store.readTaskPlan("fixture", "X-01", 0),
    (error) => error.code === "PATH_TRAVERSAL_REJECTED"
  );
});


test("presentation marks only the latest user message as replied", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const first = await store.appendTaskEvent("fixture", "B-10", {
    operationId: "reply.stamp.user.0001",
    eventType: "user_review",
    actorType: "user",
    actorId: "owner",
    note: "第一条留言"
  });
  let presentation = await store.presentation("fixture", "B-10");
  assert.equal(presentation.latestUserMessage.eventId, first.event.event_id);
  assert.equal(presentation.latestUserMessage.replied, false);
  assert.equal(presentation.latestUserMessage.replyCount, 0);

  await store.appendTaskEvent("fixture", "B-10", {
    operationId: "reply.stamp.ai.0001",
    eventType: "user_message_reply",
    actorType: "developer_ai",
    actorId: "dev-1",
    note: "已经处理",
    metadata: { replyToEventId: first.event.event_id }
  });
  presentation = await store.presentation("fixture", "B-10");
  assert.equal(presentation.latestUserMessage.replied, true);
  assert.equal(presentation.latestUserMessage.replyCount, 1);
  assert.equal(presentation.latestUserMessage.latestReply.actorType, "developer_ai");
  assert.equal(presentation.latestUserMessage.latestReply.note, "已经处理");

  const second = await store.appendTaskEvent("fixture", "B-10", {
    operationId: "reply.stamp.user.0002",
    eventType: "user_review",
    actorType: "user",
    actorId: "owner",
    note: "后来又补充一条新留言"
  });
  presentation = await store.presentation("fixture", "B-10");
  assert.equal(presentation.latestUserMessage.eventId, second.event.event_id);
  assert.equal(presentation.latestUserMessage.replied, false);
  assert.equal(presentation.latestUserMessage.replyCount, 0);
  assert.equal(presentation.latestUserMessage.latestReply, null);
});

test("test resource lifecycle projects preserved, observed, stale and cleaned states", async (t) => {
  const f = await makeFixture(); t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  await store.appendTaskEvent("fixture", "B-10", {
    operationId: "resource.preserve.0001",
    eventType: "test_resource_preserved",
    actorType: "test_ai",
    actorId: "tester-1",
    sessionId: "test-session",
    note: "保留临时服务",
    metadata: {
      resourceId: "svc-61943",
      resourceType: "port",
      locator: "127.0.0.1:61943 / PID 2344",
      purpose: "复现失败现场",
      handoffTarget: "developer_ai",
      cleanupCondition: "开发确认已复现后清理",
      cleanupBy: "2020-01-01T00:00:00.000Z",
      evidencePath: "测试报告/B-10/resource.md",
      safetyStatus: "safe"
    }
  });
  let state = await store.testResourceState("fixture", "B-10");
  assert.equal(state.activeCount, 1);
  assert.equal(state.staleCount, 1);
  assert.equal(state.active[0].status, "待开发观察");

  await store.appendTaskEvent("fixture", "B-10", {
    operationId: "resource.observe.0001",
    eventType: "test_resource_observed",
    actorType: "developer_ai",
    actorId: "dev-1",
    sessionId: "dev-session",
    note: "已复现问题",
    metadata: { resourceId: "svc-61943", result: "reproduced" }
  });
  state = await store.testResourceState("fixture", "B-10");
  assert.equal(state.active[0].status, "开发已复现");
  assert.equal(state.active[0].observed.result, "reproduced");

  await store.appendTaskEvent("fixture", "B-10", {
    operationId: "resource.cleaned.0001",
    eventType: "test_resource_cleaned",
    actorType: "developer_ai",
    actorId: "dev-1",
    sessionId: "dev-session",
    note: "已安全停止临时服务",
    metadata: { resourceId: "svc-61943" }
  });
  state = await store.testResourceState("fixture", "B-10");
  assert.equal(state.activeCount, 0);
  assert.equal(state.items[0].status, "已清理");
});
