import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../server/task-store.mjs";
import { TaskStepCheckpoint } from "../server/task-step-checkpoint.mjs";
import { makeFixture, registryText } from "./helpers.mjs";


test("task presentation derives exclusive color from real claim, current issue and completed registry", async (t) => {
  const f=await makeFixture();t.after(()=>fs.rm(f.boardRoot,{recursive:true,force:true}));
  const source="WTB-UI-20261107-T1",done="WTB-DONE-20261107-T1",
    blocked="WTB-BLOCKED-20261107-T1",cancel="WTB-CANCEL-20261107-T1";
  const row=(id,status,dep="")=>[id,"F-UI","bugfix","P0",status,"开发AI",
    status==="开发中"?"dev-visual":"—","window",status==="开发中"?"sess-one":"—",
    "2026-11-07T00:00:00Z","scope","plan.md","trace",dep,"web/app.js","done"];
  await fs.writeFile(f.registryPath,registryText([
    row(source,"开发中",done+"完成;"+blocked+"完成;"+cancel+"完成;WTB-MISSING-20261107-T1完成"),
    row(done,"已完成"),row(blocked,"阻断"),row(cancel,"已取消"),
    row("WTB-PENDING-20261107-T1","待开发")
  ]),"utf8");
  const store=await new TaskStore(f.boardRoot).init();
  const find=async (id=source)=>(await store.snapshot("fixture")).tasks.find(x=>x.id===id).presentation;
  assert.equal((await find("WTB-PENDING-20261107-T1")).cardStage,"not_started");
  assert.equal((await find(done)).cardStage,"completed");
  assert.equal((await find(source)).cardStage,"not_started","status alone never proves a claim");
  await store.appendTaskEvent("fixture",source,{
    operationId:"visual.claim",eventType:"claim",actorType:"developer_ai",
    actorId:"dev-visual",sessionId:"sess-one"
  });
  assert.equal((await find(source)).cardStage,"running");
  await assert.rejects(store.appendTaskEvent("fixture",source,{
    operationId:"visual.forged.issue",eventType:"developer_issue_reported",
    actorType:"developer_ai",actorId:"dev-foreign",sessionId:"sess-foreign",
    metadata:{paused:true,failureCode:"OUTSIDE",nextAction:"upstream",relatedTaskIds:[blocked]}
  }),e=>e.code==="DEVELOPER_ISSUE_SESSION_REQUIRED");
  await assert.rejects(store.appendTaskEvent("fixture",source,{
    operationId:"visual.missing.related",eventType:"developer_issue_reported",
    actorType:"developer_ai",actorId:"dev-visual",sessionId:"sess-one",
    metadata:{paused:true,failureCode:"OUTSIDE",nextAction:"upstream",
      relatedTaskIds:["WTB-MISSING-20261107-T1"]}
  }),e=>e.code==="DEVELOPER_ISSUE_EVIDENCE_REQUIRED");
  assert.equal((await find(source)).cardStage,"running","rejected event cannot pause task");
  await store.appendTaskEvent("fixture",source,{
    operationId:"visual.valid.issue",eventType:"developer_issue_reported",
    actorType:"developer_ai",actorId:"dev-visual",sessionId:"sess-one",
    metadata:{paused:true,failureCode:"EXTERNAL_REQUIRED",nextAction:"等待关联BUG正式发布",
      relatedTaskIds:[blocked,done]}
  });
  const active=await find(source);
  assert.equal(active.cardStage,"paused_by_issue");
  assert.equal(active.developmentIssue.failureCode,"EXTERNAL_REQUIRED");
  assert.deepEqual(active.relatedTasks.map(x=>x.status),["已完成","阻断","已取消",null]);
  await store.appendTaskEvent("fixture",source,{
    operationId:"visual.issue.clear",eventType:"developer_issue_resolved",
    actorType:"developer_ai",actorId:"dev-visual",sessionId:"sess-one"
  });
  assert.equal((await find(source)).cardStage,"running");
  assert.equal((await find(source)).developmentIssue,null);
  const standalone=await store.presentation("fixture",source);
  assert.equal(standalone.cardStage,"running");
});
test("historical developer claim never marks released task running", async () => {
  const source=(await fs.readFile(new URL("../server/task-store.mjs", import.meta.url),"utf8")).replace(/\r\n/g,"\n");
  const implementation=source.match(/function taskVisualState\(task, events, statuses\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(implementation,"actual visual projection exists");
  const visual=new Function("cleanHumanText",implementation+";return taskVisualState;")(x=>String(x));
  const claim={event_type:"claim",actor_type:"developer_ai",actor_id:"dev",session_id:"sess",new_status:"开发中"};
  const row=(status,assignee="",sessionId="")=>({id:"WTB-VISUAL-20261108-T1",status,assignee,sessionId});
  for(const status of ["开发中","修复中","独测中","复测中","交付中"])
    assert.equal(visual(row(status,"owner","sess"),[claim],new Map()).cardStage,"running",status);
  const history=[claim,{event_type:"handoff",old_status:"开发中",new_status:"待独测"}];
  for(const status of ["待独测","待复测","待交付","阻断","HOLD"])
    assert.equal(visual(row(status),history,new Map()).cardStage,"not_started",status);
  assert.equal(visual(row("开发中"),[claim],new Map()).cardStage,"not_started","past claim is not current ownership");
  assert.equal(visual(row("已完成"),history,new Map()).cardStage,"completed");
  assert.equal(visual(row("已取消"),history,new Map()).cardStage,"cancelled");
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

test("modern tracked handoff requires current developer D07 PASS before the registry transaction", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore: store }).init();
  const revision = (await store.snapshot("fixture")).registryRevision;
  await store.updateTask("fixture", "A-10", {
    status: "开发中", assignee: "developer", sessionWindowName: "dev", sessionId: "dev-session"
  }, { expectedRevision: revision, operationId: "gate.claim.0001", eventType: "claim",
    actorType: "developer_ai", actorId: "developer", sessionId: "dev-session" });

  const file = await cp.location("fixture", "A-10");
  const proof = (stepId, result = "PASS", attempt = 1) => ({
    stepId, result, attempt, actorType: "developer_ai",
    actorId: "developer", sessionId: "dev-session", evidence: "actual fixture trace",
    operationId: "gate." + stepId
  });
  const checkpoint = async (records, cursor, attempt = 1) => {
    const state = {
      version: 1, projectId: "fixture", taskId: "A-10", flowVersion: "role-steps-v2",
      attempts: attempt, records, cursors: {
        controller_ai: "C00_A_REQUIREMENTS", developer_ai: cursor, test_ai: "Q01_ADMISSION"
      }, lastAction: records.at(-1)
    };
    await fs.writeFile(file, "<!-- TASK_STEP_CHECKPOINT_START v1 -->\n" +
      JSON.stringify(state) + "\n<!-- TASK_STEP_CHECKPOINT_END -->\n");
  };
  const handoff = async (operationId) => store.updateTask("fixture", "A-10", {
    status: "待独测", assignee: "", sessionId: "", sessionWindowName: ""
  }, { expectedRevision: (await store.snapshot("fixture")).registryRevision,
    operationId, eventType: "handoff", actorType: "developer_ai",
    actorId: "developer", sessionId: "dev-session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" } });

  await checkpoint([proof("D04_IMPLEMENT")], "D05_TEST_1");
  await assert.rejects(handoff("gate.handoff.0001"), (error) => error.code === "CHECKPOINT_STAGE_REQUIRED");
  assert.equal((await store.getTask("fixture", "A-10")).task.status, "开发中");
  assert.equal(await store.transactions.read("gate.handoff.0001"), null);
  await checkpoint([proof("D07_TEST_3", "PASS", 1)], "D08_HANDOFF", 2);
  await assert.rejects(handoff("gate.handoff.0002"), (error) => error.code === "CHECKPOINT_STAGE_REQUIRED");
  await checkpoint([proof("D07_TEST_3")], "D08_HANDOFF");
  const passed = await handoff("gate.handoff.0003");
  assert.equal(passed.after.status, "待独测");
  assert.ok(passed.eventId);
});

test("modern QA and controller evidence rejects skipped steps and accepts valid stage proofs", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore: store }).init();
  const file = await cp.location("fixture", "A-10");
  const save = async (role, stepId, cursor, result = "PASS") => {
    const record = { stepId, result, actorType: role, actorId: "qa",
      sessionId: "qa-session", attempt: 1, evidence: "fixture checked" };
    const state = {
      version: 1, projectId: "fixture", taskId: "A-10", flowVersion: "role-steps-v2",
      attempts: 1, records: [record], cursors: {
        controller_ai: role === "controller_ai" ? cursor : "C00_A_REQUIREMENTS",
        developer_ai: "D01_CLAIM", test_ai: role === "test_ai" ? cursor : "Q01_ADMISSION"
      }, lastAction: record
    };
    await fs.writeFile(file, "<!-- TASK_STEP_CHECKPOINT_START v1 -->\n" +
      JSON.stringify(state) + "\n<!-- TASK_STEP_CHECKPOINT_END -->\n");
  };
  const args = { eventType: "test_result", actorType: "test_ai",
    actorId: "qa", sessionId: "qa-session" };
  await save("test_ai", "Q01_ADMISSION", "Q02_TEST");
  await assert.rejects(cp.assertTransitionEvidence("fixture", "A-10", args),
    (error) => error.code === "CHECKPOINT_STAGE_REQUIRED");
  await save("test_ai", "Q02_TEST", "Q03_RESULT");
  await cp.assertTransitionEvidence("fixture", "A-10", args);
  await save("test_ai", "Q02_TEST", "Q02_TEST", "FAIL");
  await cp.assertTransitionEvidence("fixture", "A-10", args);
  const controller = { eventType: "delivery_complete", actorType: "controller_ai",
    actorId: "qa", sessionId: "qa-session" };
  await save("controller_ai", "C05_POSTMERGE", "C06_CLEANUP");
  await assert.rejects(cp.assertTransitionEvidence("fixture", "A-10", controller),
    (error) => error.code === "CHECKPOINT_STAGE_REQUIRED");
  await save("controller_ai", "C06_CLEANUP", "C07_COMPLETE");
  await cp.assertTransitionEvidence("fixture", "A-10", controller);
});


test("TaskStore rule-read receipts are session-bound, cannot be forged, and expire with document edits", async(t)=>{
  const f=await makeFixture();
  t.after(()=>fs.rm(f.boardRoot,{recursive:true,force:true}));
  const root=f.projectRoot;
  const paths=["流程文档/00_流程与重大更新日志.md","流程文档/00_统一入口.md",
    "流程文档/开发/00_角色入口.md","流程文档/独测/00_角色入口.md",
    "流程文档/总控/00_角色入口.md","流程文档/07_全软件BUG强制修复与闭环续接规范.md",
    "流程文档/02_增删改操作日志规范.md",
    "流程文档/04_逐步聊天汇报与证据校验规范.md",
    "流程文档/05_BUG修复三问与关联任务验收规范.md",
    "流程文档/06_全任务依赖审计与阻断优先调度规范.md",
    "流程文档/开发/D01_CLAIM_正式领取任务.md",
    "流程文档/独测/Q01_ADMISSION_独立测试准入.md",
    "流程文档/总控/C00_A_REQUIREMENTS_需求记录与讨论.md",
    ".agents/skills/ponytail/SKILL.md",
    "data/taskboard/checkpoints/00_跨角色共享待办_总控维护.md"];
  const filepath=(relative)=>path.join(root,relative);
  for(const p of paths){
    const fpath=filepath(p);
    await fs.mkdir(path.dirname(fpath),{recursive:true});
    await fs.writeFile(fpath,"# authoritative "+p+"\n"+"full line\n".repeat(400));
  }
  const store=await new TaskStore(f.boardRoot).init();
  const actor={actorType:"developer_ai",actorId:"dev-unit",sessionId:"wc_sess_unit"};
  const controllerActor={actorType:"controller_ai",actorId:"ctl-unit",sessionId:"wc_sess_controller"};
  const testActor={actorType:"test_ai",actorId:"qa-unit",sessionId:"wc_sess_test"};
  await assert.rejects(store.appendTaskEvent("fixture","A-10",{
    operationId:"rule.controller.dispatch.block.0001",eventType:"controller_dispatch",
    actorType:controllerActor.actorType,actorId:controllerActor.actorId,sessionId:controllerActor.sessionId
  }),e=>e.code==="RULE_READ_REQUIRED");
  await assert.rejects(store.appendTaskEvent("fixture","A-10",{
    operationId:"rule.test.result.block.0001",eventType:"test_result",
    actorType:testActor.actorType,actorId:testActor.actorId,sessionId:testActor.sessionId
  }),e=>e.code==="RULE_READ_REQUIRED");
  await assert.rejects(store.appendTaskEvent("fixture","A-10",{
    operationId:"rule.developer.publish.block.0001",eventType:"code_published",
    actorType:actor.actorType,actorId:actor.actorId,sessionId:actor.sessionId
  }),e=>e.code==="RULE_READ_REQUIRED");
  await assert.rejects(store.updateTask("fixture","A-10",{
    status:"开发中",assignee:"dev-unit",sessionWindowName:"dev-unit",sessionId:actor.sessionId
  },{
    operationId:"rule.developer.transition.block.0001",
    expectedRevision:(await store.snapshot("fixture")).registryRevision,
    eventType:"claim",actorType:actor.actorType,actorId:actor.actorId,sessionId:actor.sessionId
  }),e=>e.code==="RULE_READ_REQUIRED");
  assert.equal((await store.ruleStatus("fixture","A-10",actor)).valid,false);
  const copiedTask={...(await store.getTask("fixture","A-10")).task,id:"C-10"};
  await assert.rejects(store.createTask("fixture",copiedTask,{
    operationId:"rule.task.created.denied.0001",
    expectedRevision:(await store.snapshot("fixture")).registryRevision,
    actorType:controllerActor.actorType,actorId:controllerActor.actorId,
    sessionId:controllerActor.sessionId
  }),e=>e.code==="RULE_READ_REQUIRED");
  const list=await store.ruleCheckList("fixture","A-10",actor.actorType);
  assert.ok(list.documents.length>=7);
  const qa=await store.ruleCheckList("fixture","A-10","test_ai");
  const controller=await store.ruleCheckList("fixture","A-10","controller_ai");
  assert.ok(qa.documents.some(d=>d.path==="流程文档/独测/Q01_ADMISSION_独立测试准入.md"));
  assert.ok(controller.documents.some(d=>d.path==="流程文档/总控/C00_A_REQUIREMENTS_需求记录与讨论.md"));
  assert.notEqual(list.fingerprint,qa.fingerprint);
  assert.notEqual(qa.fingerprint,controller.fingerprint);
  await assert.rejects(store.ruleVerify("fixture","A-10",actor,{}),
    error=>error.code==="RULE_READ_INCOMPLETE");
  await assert.rejects(store.appendTaskEvent("fixture","A-10",{
    operationId:"rule.forged.event.0001",eventType:"rule_read_verified",
    actorType:"developer_ai",actorId:actor.actorId,sessionId:actor.sessionId,
    metadata:{fingerprint:list.fingerprint}
  }),e=>e.code==="RULE_READ_SERVER_ROUTE_REQUIRED");
  await assert.rejects(store.updateTask("fixture","A-10",{status:"开发中"},{
    operationId:"rule.forged.update.0001",
    expectedRevision:(await store.snapshot("fixture")).registryRevision,
    eventType:"rule_read_verified",actorType:"developer_ai",actorId:actor.actorId
  }),e=>e.code==="RULE_READ_SERVER_ROUTE_REQUIRED");
  for(const d of list.documents)for(let i=0;i<d.chunks;i++){
    const chunk=await store.ruleReadChunk("fixture","A-10",actor,d.index,i);
    assert.equal(chunk.index,i);
  }
  const answers={parallel_different_tasks:"allow_isolated",parallel_same_task:"deny_duplicate",
    stale_takeover:"revoke_old_session",incomplete_dependency_or_stop:"deny_claim",
    independent_qa:"unique_qa_only",final_merge:"controller_after_qa_pass",
    green_completed_dependency:"skip_green_check_workflow",
    missing_or_cyclic_dependency:"deny_unresolved",role_duty:"develop_only_own_task"};
  await assert.rejects(store.ruleVerify("fixture","A-10",actor,
    {...answers,final_merge:"developer_anytime"}),e=>e.code==="RULE_READ_SCENARIO_FAILED");
  assert.equal((await store.ruleVerify("fixture","A-10",actor,answers)).valid,true);
  assert.equal((await store.ruleStatus("fixture","A-10",actor)).valid,true);
  await store.appendTaskEvent("fixture","A-10",{
    operationId:"rule.developer.publish.allowed.0001",eventType:"code_published",
    actorType:actor.actorType,actorId:actor.actorId,sessionId:actor.sessionId
  });
  assert.equal((await store.ruleStatus("fixture","A-10",actor)).valid,true);
  for(const [roleActor,eventType] of [
    [controllerActor,"controller_dispatch"],[testActor,"test_result"]
  ]){
    const current=await store.ruleCheckList("fixture","A-10",roleActor.actorType);
    for(const doc of current.documents)for(let index=0;index<doc.chunks;index++)
      await store.ruleReadChunk("fixture","A-10",roleActor,doc.index,index);
    const roleAnswers={...answers,role_duty:roleActor.actorType==="controller_ai"
      ?"dispatch_and_merge_after_qa":"test_independently"};
    await assert.rejects(store.ruleVerify("fixture","A-10",roleActor,answers),
      e=>e.code==="RULE_READ_SCENARIO_FAILED");
    assert.equal((await store.ruleVerify("fixture","A-10",roleActor,roleAnswers)).valid,true);
    await store.appendTaskEvent("fixture","A-10",{
      operationId:"rule.role.allowed."+eventType+".0001",eventType,
      actorType:roleActor.actorType,actorId:roleActor.actorId,sessionId:roleActor.sessionId
    });
  }
  assert.equal((await store.ruleStatus("fixture","A-10",actor)).valid,true);
  await store.createTask("fixture",copiedTask,{
    operationId:"rule.task.created.allowed.0001",
    expectedRevision:(await store.snapshot("fixture")).registryRevision,
    actorType:controllerActor.actorType,actorId:controllerActor.actorId,
    sessionId:controllerActor.sessionId,metadata:{ruleReadContextTaskId:"A-10"}
  });
  assert.equal((await store.getTask("fixture","C-10")).task.status,"待开发");
  assert.equal((await store.ruleStatus("fixture","A-10",
    {...actor,sessionId:"wc_sess_else"})).valid,false);
  await fs.appendFile(filepath("流程文档/00_统一入口.md"),"\n# changed\n");
  assert.equal((await store.ruleStatus("fixture","A-10",actor)).valid,false);
});
