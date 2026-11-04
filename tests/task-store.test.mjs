import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

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

// P0 bugfix claim priority uses the real TaskStore transaction and registered task states.
test("new ordinary developer claim is refused while a claimable P0 BUG exists", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const row = (id, track, status = "待开发", dependency = "") => [
    id, "F-PRIORITY", track, "P0", status, "开发AI", "—", "—", "—", "—",
    "P0 BUG priority", "plan.md", "trace/" + id, dependency,
    "src/" + id + ".js", "cp/" + id + ".md"
  ];
  await fs.writeFile(f.registryPath, registryText([
    row("NORMAL-10", "product"), row("BUG-10", "bugfix")
  ]), "utf8");
  const store = await new TaskStore(f.boardRoot).init();
  let seq = 0;
  const claim = async (id, actor) => {
    const snap = await store.snapshot("fixture");
    return store.updateTask("fixture", id, {
      status: "开发中", assignee: actor, sessionWindowName: actor, sessionId: actor + "-session"
    }, {
      expectedRevision: snap.registryRevision, operationId: "priority.claim." + (++seq),
      eventType: "claim", actorType: "developer_ai", actorId: actor,
      sessionId: actor + "-session", sessionWindowName: actor
    });
  };
  const before = (await store.snapshot("fixture")).registryRevision;
  await assert.rejects(claim("NORMAL-10", "dev-normal"), (error) =>
    error.code === "BUGFIX_PRIORITY_REQUIRED" && error.status === 409 &&
    error.details.bugTaskId === "BUG-10");
  assert.equal((await store.snapshot("fixture")).registryRevision, before, "blocked claim cannot mutate tasks");
  assert.equal((await claim("BUG-10", "dev-bug")).after.status, "开发中");
  assert.equal((await claim("NORMAL-10", "dev-normal")).after.status, "开发中",
    "after a different developer owns the BUG, ordinary work must not deadlock");
});

test("P0 priority never traps normal claims behind STOP, dependencies or someone else's QA failure", async (t) => {
  const cases = ["stop", "dependency", "other-owner", "hold", "missing-write"];
  for (const kind of cases) {
    const f = await makeFixture();
    t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
    const bugStatus = kind === "hold" ? "HOLD" : kind === "other-owner" ? "测试失败待修复" : "待开发";
    const row = (id, track, status, dependency = "", writes = "src/" + id + ".js") =>
      [id, "F-PRIORITY", track, "P0", status,
        status === "HOLD" ? "" : "开发AI", "—", "—", "—", "—", "priority",
        "plan.md", "trace/" + id, dependency, writes, "cp/" + id + ".md"];
    await fs.writeFile(f.registryPath, registryText([
      row("NORMAL-10", "product", "待开发"),
      row("BUG-10", "bugfix", bugStatus,
        kind === "dependency" ? "MISSING-10完成" : "",
        kind === "missing-write" ? "" : "src/BUG-10.js")
    ]), "utf8");
    const store = await new TaskStore(f.boardRoot).init();
    if (kind === "stop") await store.appendTaskEvent("fixture", "BUG-10", {
      operationId: "priority.bug.stop", eventType: "stop_request",
      actorType: "user", actorId: "user", sessionId: "user", note: "STOP"
    });
    if (kind === "other-owner") await store.appendTaskEvent("fixture", "BUG-10", {
      operationId: "priority.bug.old.dev", eventType: "claim",
      actorType: "developer_ai", actorId: "original-developer", sessionId: "old-session"
    });
    const snap = await store.snapshot("fixture");
    const result = await store.updateTask("fixture", "NORMAL-10", {
      status: "开发中", assignee: "new-developer", sessionWindowName: "normal",
      sessionId: "normal-session"
    }, {
      expectedRevision: snap.registryRevision,
      operationId: "priority.normal." + kind, eventType: "claim",
      actorType: "developer_ai", actorId: "new-developer", sessionId: "normal-session"
    });
    assert.equal(result.after.status, "开发中", kind);
  }
});

test("P0 BUG returned from QA to its original developer keeps repair priority", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const row = (id, track, status) => [id, "F-PRIORITY", track, "P0",
    status, "开发AI", "—", "—", "—", "—", "priority", "plan.md",
    "trace/" + id, "", "src/" + id + ".js", "cp/" + id + ".md"];
  await fs.writeFile(f.registryPath, registryText([
    row("NORMAL-10", "product", "待开发"),
    row("BUG-10", "bugfix", "测试失败待修复")
  ]), "utf8");
  const store = await new TaskStore(f.boardRoot).init();
  await store.appendTaskEvent("fixture", "BUG-10", {
    operationId: "priority.original.claim", eventType: "claim",
    actorType: "developer_ai", actorId: "original-developer", sessionId: "old-session"
  });
  const snap = await store.snapshot("fixture");
  await assert.rejects(store.updateTask("fixture", "NORMAL-10", {
    status: "开发中", assignee: "original-developer",
    sessionId: "new-original-session", sessionWindowName: "repair"
  }, {
    expectedRevision: snap.registryRevision, operationId: "priority.original.normal",
    eventType: "claim", actorType: "developer_ai", actorId: "original-developer",
    sessionId: "new-original-session"
  }), (error) => error.code === "BUGFIX_PRIORITY_REQUIRED" &&
    error.details.bugTaskId === "BUG-10");
});

test("an explicit user urgent priority event can override BUG-first for that ordinary task only", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const row = (id, track) => [id, "F-URGENT", track, "P0", "待开发",
    "开发AI", "—", "—", "—", "—", "priority", "plan.md",
    "trace/" + id, "", "src/" + id + ".js", "cp/" + id + ".md"];
  await fs.writeFile(f.registryPath, registryText([
    row("URGENT-10", "product"), row("REGULAR-10", "product"), row("BUG-10", "bugfix")
  ]), "utf8");
  const store = await new TaskStore(f.boardRoot).init();
  for (const [id, urgent] of [["URGENT-10", true], ["REGULAR-10", false]]) {
    await store.appendTaskEvent("fixture", id, {
      operationId: "priority.user.urgent." + id, eventType: "priority_change",
      actorType: "user", actorId: "owner", sessionId: "user", metadata: { urgent }
    });
  }
  const claim = async (id, actor) => {
    const snapshot = await store.snapshot("fixture");
    return store.updateTask("fixture", id, {
      status: "开发中", assignee: actor, sessionId: actor + "-session",
      sessionWindowName: actor
    }, {
      expectedRevision: snapshot.registryRevision,
      operationId: "priority.urgent.claim." + id,
      actorType: "developer_ai", actorId: actor, sessionId: actor + "-session",
      eventType: "claim"
    });
  };
  assert.equal((await claim("URGENT-10", "dev-urgent")).after.status, "开发中");
  await assert.rejects(claim("REGULAR-10", "dev-regular"), (error) =>
    error.code === "BUGFIX_PRIORITY_REQUIRED" && error.details.bugTaskId === "BUG-10");
});
