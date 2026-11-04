import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../server/task-store.mjs";
import { TaskStepCheckpoint, ROLE_STAGE_STEPS } from "../server/task-step-checkpoint.mjs";
import { makeFixture } from "./helpers.mjs";

async function fixture(t) {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const taskStore = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore, flowVersion: "role-steps-v1" }).init();
  return { f, taskStore, cp };
}
let sequence = 1;
async function step(cp, role, id, extra = {}, taskId = "A-10") {
  const before = await cp.show("fixture", taskId);
  const result = await cp.record("fixture", taskId, {
    operationId: "fixture.step." + String(sequence++).padStart(8, "0"),
    expectedSha256: before.sha256, stepId: id, actorType: role,
    actorId: role === "controller_ai" ? "controller" : role === "developer_ai" ? "developer" : "qa",
    sessionId: role + ".session", evidence: "实际执行证据: fixture-" + id, ...extra
  });
  assert.ok(result.sha256 && result.file.endsWith(taskId + ".md"));
  assert.equal(result.state.lastAction.stepId, id);
  return result;
}
async function controllerReady(store, cp, taskId = "A-10") {
  await step(cp, "controller_ai", "C01_SCAN", {}, taskId);
  await step(cp, "controller_ai", "C02_TRIAGE", {}, taskId);
  const event = await store.appendTaskEvent("fixture", taskId, {
    operationId: "fixture.dispatch." + String(sequence++).padStart(8, "0"),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller_ai.session", note: "正式派给合法开发"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: event.event.event_id }, taskId);
  await step(cp, "controller_ai", "C04_VERIFY_NEXT", {}, taskId);
}
async function claimDev(store) {
  const s = await store.snapshot("fixture");
  return store.updateTask("fixture", "A-10", {
    status: "开发中", assignee: "developer", sessionWindowName: "dev", sessionId: "developer_ai.session"
  }, {
    operationId: "fixture.claim." + String(sequence++).padStart(8, "0"),
    expectedRevision: s.registryRevision, eventType: "claim", actorType: "developer_ai",
    actorId: "developer", sessionId: "developer_ai.session"
  });
}

test("one checkpoint per task preserves existing legacy text and enforces controller step order", async (t) => {
  const {f, cp, taskStore} = await fixture(t);
  const legacy = path.join(f.projectRoot, "cp", "A-10.md");
  await fs.writeFile(legacy, "# 老任务断点\n\n重要旧证据保留\n");
  const start = await cp.show("fixture", "A-10");
  assert.equal(start.legacy, true);
  await assert.rejects(step(cp,"controller_ai","C02_TRIAGE"), (e) => e.code === "CHECKPOINT_STEP_ORDER");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM"), (e) => e.code === "CHECKPOINT_PREDECESSOR_REQUIRED");
  await controllerReady(taskStore,cp);
  const content = await fs.readFile(legacy,"utf8");
  assert.ok(content.includes("重要旧证据保留"));
  assert.ok(content.includes("C04_VERIFY_NEXT"));
  assert.equal((await fs.readdir(path.join(f.projectRoot,"cp"))).filter(x=>x==="A-10.md").length,1);
  assert.equal((await cp.show("fixture","A-10")).state.cursors.controller_ai,null);
});
test("FAIL and BLOCK persist but do not advance; conflict and idempotent retry never overwrite",async(t)=>{
  const {cp}=await fixture(t);
  const original=await cp.show("fixture","A-10");
  const request={operationId:"fixture.retry.0001",expectedSha256:original.sha256,stepId:"C01_SCAN",
    actorType:"controller_ai",actorId:"controller",sessionId:"c-session",
    evidence:"真实扫描失败：缺少服务连接",result:"FAIL"};
  const failed=await cp.record("fixture","A-10",request);
  assert.equal(failed.state.cursors.controller_ai,"C01_SCAN");
  const repeat=await cp.record("fixture","A-10",request);
  assert.equal(repeat.duplicate,true);
  assert.equal(repeat.state.records.length,1);
  await assert.rejects(cp.record("fixture","A-10",{...request,operationId:"fixture.retry.0002",result:"PASS"}),
    (e)=>e.code==="CHECKPOINT_REVISION_CONFLICT");
  const done=await step(cp,"controller_ai","C01_SCAN");
  assert.equal(done.state.records.length,2);
  assert.equal(done.state.cursors.controller_ai,"C02_TRIAGE");
  const blocked=await step(cp,"controller_ai","C02_TRIAGE",{result:"BLOCK"});
  assert.equal(blocked.state.cursors.controller_ai,"C02_TRIAGE");
});
test("real claim and handoff events are required; after handoff QA can resume from same task file",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM"),e=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  const claimed=await claimDev(taskStore);
  const dev=await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)) await step(cp,"developer_ai",id);
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION"),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  const s=await taskStore.snapshot("fixture");
  const handoff=await taskStore.updateTask("fixture","A-10", {status:"待独测"}, {
    expectedRevision:s.registryRevision, operationId:"fixture.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  await assert.rejects(step(cp,"developer_ai","D09_MERGE_MAIN"),e=>e.code==="CHECKPOINT_QA_PASS_REQUIRED");
  const qaClaim=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qaclaim.0001",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await step(cp,"test_ai","Q02_TEST");
  assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q03_RESULT");
  const checkpointPath = (await cp.show("fixture","A-10")).file;
  assert.equal(path.isAbsolute(checkpointPath), false);
  assert.equal((await fs.readFile(path.join((await cp.taskStore.projects.context("fixture")).rootRealPath, checkpointPath),"utf8")).includes("正式派给合法开发"),false);
});
test("different task IDs are separate, other-role and invalid events are refused",async(t)=>{
  const {cp}=await fixture(t);
  const one=await cp.show("fixture","A-10"),two=await cp.show("fixture","B-10");
  assert.notEqual(one.file,two.file);
  assert.equal(path.isAbsolute(one.file),false);
  assert.equal(one.file.includes("\\\\"),false);
  await assert.rejects(step(cp,"test_ai","C01_SCAN"),e=>e.code==="CHECKPOINT_ROLE_STEP_INVALID");
  await assert.rejects(cp.show("fixture","../fake"),e=>e.code==="INVALID_TASK_ID");
  await assert.rejects(cp.show("fixture","NONE"),e=>e.code==="TASK_NOT_FOUND");
  await assert.rejects(cp.record("fixture","A-10",{stepId:"C01_SCAN",
    actorType:"controller_ai",actorId:"controller",sessionId:"c",operationId:"fixture.invalid.0001",
    expectedSha256:one.sha256,evidence:"short"}),e=>e.code==="CHECKPOINT_EVIDENCE_REQUIRED");
});
test("substep PROGRESS saves a durable checkpoint and rejects forged developer Session",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  const state=await cp.show("fixture","A-10");
  await assert.rejects(cp.record("fixture","A-10",{
    operationId:"fixture.spoof.0001",expectedSha256:state.sha256,
    stepId:"D02_WORKTREE",actorType:"developer_ai",actorId:"intruder",sessionId:"different-session",
    evidence:"有原始worktree命令输出和退出码",result:"PASS"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{result:"PROGRESS"}),e=>e.code==="CHECKPOINT_SUBSTEP_REQUIRED");
  const progress=await step(cp,"developer_ai","D02_WORKTREE",{result:"PROGRESS",substepId:"WORKTREE_VERIFIED"});
  assert.equal(progress.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(progress.state.lastAction.substepId,"WORKTREE_VERIFIED");
  const done=await step(cp,"developer_ai","D02_WORKTREE");
  assert.equal(done.state.cursors.developer_ai,"D03_WRITE_SCOPE");
});
test("takeover revokes the old developer Session for PASS and PROGRESS; new owner resumes the same cursor", async(t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  await step(cp,"developer_ai","D02_WORKTREE");
  await step(cp,"developer_ai","D03_WRITE_SCOPE");
  const taken=await taskStore.updateTask("fixture","A-10",{
    assignee:"replacement",sessionWindowName:"replacement",sessionId:"replacement-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.takeover.dev.0001",eventType:"takeover",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session"
  });
  assert.ok(taken.eventId);
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT"),
    (e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT",{
    result:"PROGRESS",substepId:"BAD_STALE_PROGRESS"
  }),(e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT",{
    actorId:"replacement",sessionId:"developer_ai.session"
  }),(e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D04_IMPLEMENT",{
    actorId:"replacement",sessionId:"replacement-session"
  });
  assert.equal(resumed.state.lastAction.actorId,"replacement");
  assert.equal(resumed.state.cursors.developer_ai,"D05_TEST_1");
});
test("missing D08 recovers only from a genuine latest handoff bound to the owner before QA claim", async(t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.lost-d08.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.lost-d08.qaclaim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D08_HANDOFF");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:"evt_fake"}),
    (e)=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const accepted=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  const recovered=accepted.state.records.find(r=>r.operationId==="recovered."+handoff.eventId);
  assert.equal(recovered.eventId,handoff.eventId);
  assert.equal(recovered.actorId,"developer");
  assert.match(recovered.note,/历史事件投影恢复/);
  assert.equal(accepted.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(accepted.state.cursors.test_ai,"Q02_TEST");
  await assert.rejects(step(cp,"developer_ai","D09_MERGE_MAIN"),
    (e)=>e.code==="CHECKPOINT_QA_PASS_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).state.records.filter(r=>r.operationId===recovered.operationId).length,1);
});
test("real handoff and latest QA claim restore Q01 when the entire developer checkpoint is absent", async(t) => {
  const {cp,taskStore}=await fixture(t);
  const devClaim=await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-checkpoint.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-checkpoint.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const empty=await cp.show("fixture","A-10");
  assert.equal(empty.state.records.length,0);
  assert.equal(empty.state.cursors.developer_ai,"D01_CLAIM");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:devClaim.eventId}),
    e=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,empty.sha256);
  const recovered=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  assert.equal(recovered.state.cursors.test_ai,"Q02_TEST");
  assert.equal(recovered.state.cursors.developer_ai,"D01_CLAIM");
  assert.equal(recovered.state.records.filter(r=>/^D0[1-8]_/.test(r.stepId)).length,0);
  const marker=recovered.state.records.find(r=>r.operationId==="recovered."+handoff.eventId);
  assert.equal(marker.stepId,"HISTORICAL_HANDOFF");
  assert.equal(marker.result,"RECOVERED");
  assert.equal(marker.eventId,handoff.eventId);
  assert.match(marker.note,/不补造D01-D08/);
  assert.equal(recovered.state.records.length,2);
});
test("existing Q01 FAIL history may be retained during zero-developer-checkpoint recovery", async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-fail.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-fail.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const initial=await step(cp,"test_ai","Q01_ADMISSION",{result:"FAIL"});
  assert.equal(initial.state.cursors.test_ai,"Q01_ADMISSION");
  const recovered=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  assert.equal(recovered.state.records[0].result,"FAIL");
  assert.equal(recovered.state.records[1].stepId,"HISTORICAL_HANDOFF");
  assert.equal(recovered.state.records[1].eventId,handoff.eventId);
  assert.equal(recovered.state.records[2].result,"PASS");
});
test("Q02 history rejects fake controller requeue and real independent FAIL before new Q01", async t => {
  for (const mode of ["fake_requeue", "real_fail"]) {
    const {cp, taskStore} = await fixture(t);
    await claimDev(taskStore);
    await taskStore.updateTask("fixture", "A-10",
      {status: "待独测", assignee: "", sessionWindowName: "", sessionId: ""},
      {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
        operationId: "fixture.qa-negative.handoff." + mode, eventType: "handoff",
        actorType: "developer_ai", actorId: "developer", sessionId: "developer_ai.session",
        metadata: {atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"}});
    const qa1 = await taskStore.updateTask("fixture", "A-10",
      {status: "独测中", assignee: "qa", sessionWindowName: "qa", sessionId: "test_ai.session"},
      {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
        operationId: "fixture.qa-negative.qa1." + mode, eventType: "claim",
        actorType: "test_ai", actorId: "qa", sessionId: "test_ai.session"});
    await step(cp, "test_ai", "Q01_ADMISSION", {eventId: qa1.eventId});
    await step(cp, "test_ai", "Q02_TEST", {result: "BLOCK"});
    const trueBlock = mode === "fake_requeue";
    await taskStore.updateTask("fixture", "A-10",
      {status: trueBlock ? "阻断" : "测试失败待修复",
        assignee: "", sessionWindowName: "", sessionId: ""},
      {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
        operationId: "fixture.qa-negative.result." + mode, eventType: "test_result",
        actorType: "test_ai", actorId: "qa", sessionId: "test_ai.session",
        metadata: {atomicLifecycle: true, testResult: trueBlock ? "blocked" : "fail",
          reportPath: "reports/qa-negative.md"}});
    if (!trueBlock) {
      await taskStore.updateTask("fixture", "A-10", {status: "阻断"}, {
        expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
        operationId: "fixture.qa-negative.fail-block", eventType: "controller_block",
        actorType: "controller_ai", actorId: "controller", sessionId: "controller-session"});
    }
    await taskStore.updateTask("fixture", "A-10", {status: "待复测"}, {
      expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-negative.requeue." + mode,
      eventType: trueBlock ? "fake_requeue" : "controller_requeue",
      actorType: trueBlock ? "developer_ai" : "controller_ai",
      actorId: trueBlock ? "developer" : "controller",
      sessionId: trueBlock ? "developer_ai.session" : "controller-session"});
    const qa2 = await taskStore.updateTask("fixture", "A-10",
      {status: "复测中", assignee: "qa-new", sessionWindowName: "qa-new", sessionId: "qa-new-session"},
      {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
        operationId: "fixture.qa-negative.qa2." + mode, eventType: "claim",
        actorType: "test_ai", actorId: "qa-new", sessionId: "qa-new-session"});
    const before = await cp.show("fixture", "A-10");
    await assert.rejects(step(cp, "test_ai", "Q01_ADMISSION", {
      actorId: "qa-new", sessionId: "qa-new-session", eventId: qa2.eventId
    }), e => e.code === "CHECKPOINT_STEP_ORDER");
    assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
    assert.equal((await cp.show("fixture", "A-10")).state.attempts, before.state.attempts);
  }
});

test("new QA claim after an actual Q02 BLOCK and controller requeue opens Q01 in a new attempt", async t => {
  const {cp, taskStore} = await fixture(t);
  await claimDev(taskStore);
  const handoff = await taskStore.updateTask("fixture", "A-10",
    {status: "待独测", assignee: "", sessionWindowName: "", sessionId: ""},
    {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-retry.handoff", eventType: "handoff", actorType: "developer_ai",
      actorId: "developer", sessionId: "developer_ai.session",
      metadata: {atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"}});
  const qa1 = await taskStore.updateTask("fixture", "A-10",
    {status: "独测中", assignee: "qa", sessionWindowName: "qa", sessionId: "test_ai.session"},
    {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-retry.qa1", eventType: "claim", actorType: "test_ai",
      actorId: "qa", sessionId: "test_ai.session"});
  await step(cp, "test_ai", "Q01_ADMISSION", {eventId: qa1.eventId});
  await step(cp, "test_ai", "Q02_TEST", {result: "BLOCK"});
  const checkpoint = await cp.show("fixture", "A-10");
  assert.equal(checkpoint.state.cursors.test_ai, "Q02_TEST");
  const blocked = await taskStore.updateTask("fixture", "A-10",
    {status: "阻断", plannedRole: "独立测试AI", assignee: "", sessionWindowName: "", sessionId: ""},
    {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-retry.blocked", eventType: "test_result", actorType: "test_ai",
      actorId: "qa", sessionId: "test_ai.session",
      metadata: {atomicLifecycle: true, testResult: "blocked", reportPath: "reports/qa-r1.md"}});
  assert.ok(blocked.eventId);
  const reopen = await taskStore.updateTask("fixture", "A-10", {status: "待复测"},
    {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-retry.controller-requeue", eventType: "controller_requeue",
      actorType: "controller_ai", actorId: "controller", sessionId: "controller-session"});
  assert.ok(reopen.eventId);
  const qa2 = await taskStore.updateTask("fixture", "A-10",
    {status: "复测中", assignee: "qa-new", sessionWindowName: "qa-new", sessionId: "qa-new-session"},
    {expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      operationId: "fixture.qa-retry.qa2", eventType: "claim", actorType: "test_ai",
      actorId: "qa-new", sessionId: "qa-new-session"});
  await assert.rejects(step(cp, "test_ai", "Q01_ADMISSION", {
    actorId: "qa", sessionId: "test_ai.session", eventId: qa2.eventId
  }), e => e.code === "CHECKPOINT_SESSION_MISMATCH");
  const recovered = await step(cp, "test_ai", "Q01_ADMISSION", {
    actorId: "qa-new", sessionId: "qa-new-session", eventId: qa2.eventId
  });
  assert.equal(recovered.state.attempts, checkpoint.state.attempts + 1);
  assert.equal(recovered.state.cursors.test_ai, "Q02_TEST");
  assert.equal(recovered.state.records.filter(r => r.attempt === checkpoint.state.attempts
    && r.stepId === "Q02_TEST" && r.result === "BLOCK").length, 1);
  assert.ok(recovered.state.records.some(r => r.attempt === recovered.state.attempts
    && r.stepId === "Q01_ADMISSION" && r.eventId === qa2.eventId));
  assert.equal(recovered.state.records.filter(r => r.attempt === recovered.state.attempts
    && r.actorType === "developer_ai" && r.result === "PASS").length, 0);
  assert.ok(handoff.eventId);
});
test("independent BLOCK followed by real controller requeue permits new QA to recover unchanged handoff",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionWindowName:"",sessionId:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.qa1",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{result:"FAIL"});
  const blocked=await taskStore.updateTask("fixture","A-10",{
    status:"阻断",plannedRole:"独立测试AI"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.block",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md"}
  });
  assert.ok(blocked.eventId);
  const resumed=await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.controller",eventType:"controller_requeue",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  assert.ok(resumed.eventId);
  const qa2=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"qa2",sessionWindowName:"qa2",sessionId:"qa2-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.qa2",eventType:"claim",
    actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa",sessionId:"test_ai.session",eventId:qa2.eventId
  }), e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const result=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa2",sessionId:"qa2-session",eventId:qa2.eventId
  });
  assert.equal(result.state.cursors.test_ai,"Q02_TEST");
  assert.equal(result.state.records[0].result,"FAIL");
  const marker=result.state.records.find(r=>r.eventId===handoff.eventId);
  assert.equal(marker.stepId,"HISTORICAL_HANDOFF");
  assert.equal(marker.result,"RECOVERED");
  assert.equal(result.state.records.filter(r=>/^D0[1-8]_/.test(r.stepId)).length,0);
});
test("QA recovery refuses BLOCK requeued by non-controller and refuses real failed test verdict",async(t)=>{
  for(const verdict of ["blocked","fail"]){
    const {cp,taskStore}=await fixture(t);
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",{
      status:"待独测",assignee:"",sessionWindowName:"",sessionId:""
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.handoff."+verdict,eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
    });
    await taskStore.updateTask("fixture","A-10",{
      status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.qa."+verdict,eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
    });
    await taskStore.updateTask("fixture","A-10",{
      status:verdict==="blocked"?"阻断":"测试失败待修复",
      ...(verdict==="blocked"?{plannedRole:"独立测试AI"}:{})
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.result."+verdict,eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:verdict,reportPath:"reports/qa-verdict.md"}
    });
    if(verdict==="blocked") {
      await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.requeue",eventType:"fake_requeue",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
      });
    } else {
      // Malformed historical requeue event must never erase a genuine FAIL.
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.block-negative.fake-controller",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
      await taskStore.updateTask("fixture","A-10",{status:"阻断",plannedRole:"开发AI"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.to-block",eventType:"controller_block",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
      await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.retest",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
    }
    const qa=await taskStore.updateTask("fixture","A-10",{
      status:"复测中",assignee:"qa2",sessionWindowName:"qa2",sessionId:"qa2-session"
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.qa2."+verdict,eventType:"claim",
      actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
    });
    const before=await cp.show("fixture","A-10");
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa2",sessionId:"qa2-session",eventId:qa.eventId
    }),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
    assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  }
});
test("partially written developer steps cannot be silently skipped by historical handoff projection",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.partial.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  assert.ok(handoff.eventId);
  const claim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.partial.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:claim.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});
test("an old Session cannot forge the latest handoff after a developer takeover",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  await taskStore.updateTask("fixture","A-10",{
    assignee:"replacement",sessionId:"replacement-session",sessionWindowName:"replacement"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.takeover.0001",eventType:"takeover",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session"
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.legit.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  // Inject a historical event with the old identity after the authentic handoff.
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.stale-handoff.fake.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.qaclaim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});
test("controller takeover invalidates its former Session without losing the already recorded scan",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await step(cp,"controller_ai","C01_SCAN");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.controller.takeover.0001",eventType:"takeover",
    actorType:"controller_ai",actorId:"controller-new",sessionId:"controller-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"controller_ai","C02_TRIAGE"),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const resumed=await step(cp,"controller_ai","C02_TRIAGE",{
    actorId:"controller-new",sessionId:"controller-new-session"
  });
  assert.equal(resumed.state.cursors.controller_ai,"C03_DISPATCH");
});
test("independent QA takeover revokes old QA before Q02, preserving the predecessor event",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handed=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handed.eventId});
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.claim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await taskStore.updateTask("fixture","A-10",{
    assignee:"qa-new",sessionId:"qa-new-session",sessionWindowName:"qa-new"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.transfer.0001",eventType:"takeover",
    actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q02_TEST"),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const resumed=await step(cp,"test_ai","Q02_TEST",{
    actorId:"qa-new",sessionId:"qa-new-session"
  });
  assert.equal(resumed.state.cursors.test_ai,"Q03_RESULT");
});
test("QA can enter Q01 via latest formal takeover when handoff D08 was not recorded",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const dev=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:dev.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  assert.ok(handoff.eventId);
  const oldClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const takeover=await taskStore.updateTask("fixture","A-10",{
    assignee:"qa-new",sessionId:"qa-new-session",sessionWindowName:"qa-new"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.transfer",eventType:"takeover",
    actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:oldClaim.eventId}),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const accepted=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa-new",sessionId:"qa-new-session",eventId:takeover.eventId
  });
  assert.equal(accepted.state.cursors.test_ai,"Q02_TEST");
  assert.equal(accepted.state.records.filter(e=>e.stepId==="D08_HANDOFF" && e.eventId===handoff.eventId).length,1);
});
test("QA FAIL returns to developer without reusing the prior PASS attempt",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const beforeHandoff=await taskStore.snapshot("fixture");
  const handed=await taskStore.updateTask("fixture","A-10",{status:"待独测"},{
    operationId:"fixture.qa.retry.handoff.0001",expectedRevision:beforeHandoff.registryRevision,
    eventType:"handoff",actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handed.eventId});
  const qaClaim=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qa.retry.claim.0001",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
    });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await step(cp,"test_ai","Q02_TEST");
  const qaFail=await taskStore.updateTask("fixture","A-10",
    {status:"测试失败待修复"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qa.retry.failed.0001",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/independent-qa-fail.md"}
    });
  await step(cp,"test_ai","Q03_RESULT",{eventId:qaFail.eventId});
  assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q04_NEXT");
  await step(cp,"test_ai","Q04_NEXT");
  const result=(await cp.show("fixture","A-10")).state;
  assert.equal(result.attempts,2);
  assert.equal(result.cursors.developer_ai,"D04_IMPLEMENT");
  assert.equal(result.cursors.test_ai,"Q01_ADMISSION");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION"),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
});

test("a real QA Q02 failure and fresh developer claim reopen D01 without losing the old attempt", async (t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const first=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:first.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)) await step(cp,"developer_ai",id);
  const oldHandoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.old-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
      commitSha:"1".repeat(40)}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:oldHandoff.eventId});
  const firstQA=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.old-qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:firstQA.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"FAIL"});
  const fail=await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.result",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/qa-fail.md",
      commitSha:"1".repeat(40)}
  });
  const newDev=await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.claim",eventType:"claim",
    actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"
  });
  const prior=await cp.show("fixture","A-10");
  assert.equal(prior.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(prior.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.fail-restart.stop",eventType:"stop_request",actorType:"user",note:"暂停返修"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  }), e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,prior.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.fail-restart.resume",eventType:"resume",actorType:"user",note:"正式恢复返修"
  });
  const renewed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  });
  assert.equal(renewed.state.attempts,2);
  assert.equal(renewed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(renewed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(renewed.state.records.some(r=>r.stepId==="Q02_TEST"&&r.result==="FAIL"&&r.attempt===1));
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }), e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)){
    await step(cp,"developer_ai",id,{actorId:"repair",sessionId:"repair-session"});
  }
  const fixed=await taskStore.updateTask("fixture","A-10",{
    status:"待复测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.new-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"repair",sessionId:"repair-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
      commitSha:"2".repeat(40)}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{
    actorId:"repair",sessionId:"repair-session",eventId:fixed.eventId
  });
  const newQA=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"new-qa",sessionWindowName:"new-qa",sessionId:"new-qa-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.new-qa",eventType:"claim",
    actorType:"test_ai",actorId:"new-qa",sessionId:"new-qa-session"
  });
  const passed=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"new-qa",sessionId:"new-qa-session",eventId:newQA.eventId
  });
  assert.equal(passed.state.cursors.test_ai,"Q02_TEST");
  assert.ok(passed.state.records.some(r=>r.stepId==="Q02_TEST"&&r.result==="FAIL"));
  assert.ok(fail.eventId);
});

test("a genuine independent FAIL still reopens D01 when old QA checkpoint steps were never written",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const old=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:old.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const failed=await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.fail",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/qa-fail.md"}
  });
  const newDev=await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"new-dev",sessionId:"new-session",sessionWindowName:"new-dev"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.new-claim",eventType:"claim",
    actorType:"developer_ai",actorId:"new-dev",sessionId:"new-session"
  });
  const oldState=await cp.show("fixture","A-10");
  assert.equal(oldState.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(oldState.state.cursors.test_ai,"Q01_ADMISSION");
  const restored=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:newDev.eventId
  });
  assert.equal(restored.state.attempts,2);
  assert.equal(restored.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(restored.state.records.filter(r=>r.stepId==="Q01_ADMISSION").length,0);
  assert.ok(failed.eventId);
});

test("a formally dispatched and claimed task can start D01 without fabricated old controller steps",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  const current=await cp.show("fixture","A-10");
  const claimed=await claimDev(taskStore);
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,current.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.dev-forged",eventType:"controller_dispatch_p0",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.controller",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  const fresh=await fixture(t);
  const dispatched=await fresh.taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.controller-before-claim",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  const properlyClaimed=await claimDev(fresh.taskStore);
  const approved=await step(fresh.cp,"developer_ai","D01_CLAIM",{eventId:properlyClaimed.eventId});
  assert.equal(approved.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(approved.state.cursors.controller_ai,"C01_SCAN");
  await assert.rejects(step(fresh.cp,"developer_ai","D01_CLAIM",{
    eventId:properlyClaimed.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.ok(dispatched.event.event_id);
  assert.equal(approved.state.records.filter(r=>r.actorType==="controller_ai").length,0);
  const blocked=await fixture(t);
  const original=await fs.readFile(blocked.f.registryPath,"utf8");
  assert.ok(original.includes("read/A-10.md"));
  await fs.writeFile(blocked.f.registryPath,original.replace("read/A-10.md","B-10完成"));
  await blocked.taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dependency.dispatch",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  const blockedClaim=await claimDev(blocked.taskStore);
  const before=await blocked.cp.show("fixture","A-10");
  await assert.rejects(step(blocked.cp,"developer_ai","D01_CLAIM",{
    eventId:blockedClaim.eventId
  }),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await blocked.cp.show("fixture","A-10")).sha256,before.sha256);
});

test("a formally failed candidate cannot reuse the same Git SHA for a new QA admission",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.old-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
      commitSha:"a".repeat(40)}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.qa-claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.failed",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/same-sha-fail.md",
      commitSha:"a".repeat(40)}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"fix",sessionId:"fix-session",sessionWindowName:"fix"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.fix-claim",eventType:"claim",
    actorType:"developer_ai",actorId:"fix",sessionId:"fix-session"
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"待复测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.new-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"fix",sessionId:"fix-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
      commitSha:"a".repeat(40)}
  });
  const qa=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"qa2",sessionId:"qa2-session",sessionWindowName:"qa2"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.qa2",eventType:"claim",
    actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa2",sessionId:"qa2-session",eventId:qa.eventId
  }),e=>e.code==="CHECKPOINT_CANDIDATE_UNCHANGED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});

test("portable flow paths stay relative and published template matches canonical steps",async()=>{
  const root=path.resolve("流程文档"), template=path.resolve("templates/webcodex-v1/流程文档");
  async function visit(folder,prefix=""){
    const output=[];
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      const relative=prefix?prefix+"/"+entry.name:entry.name;
      if(entry.isDirectory())output.push(...await visit(path.join(folder,entry.name),relative));
      else if(entry.isFile())output.push(relative);
    }
    return output;
  }
  const canonical=(await visit(root)).sort();
  const copies=(await visit(template)).sort();
  assert.deepEqual(copies,canonical);
  assert.equal(canonical.length,25);
  for(const relative of canonical){
    const original=await fs.readFile(path.join(root,relative),"utf8");
    const copy=await fs.readFile(path.join(template,relative),"utf8");
    assert.equal(copy,original,"out-of-sync portable template: "+relative);
    assert.doesNotMatch(original,/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|Users|mnt|opt|tmp)\/)/,
      "machine-specific absolute path found in "+relative);
  }
  const readme=await fs.readFile(path.resolve("templates/webcodex-v1/README.md"),"utf8");
  assert.doesNotMatch(readme,/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|Users|mnt|opt|tmp)\/)/);
  assert.match(await fs.readFile(path.join(root,"00_统一入口.md"),"utf8"),/相对路径强制规则/);
});

test("v2 cursor enters C00, permits optional environment check and bypasses delivery-only C04 after ordinary dispatch", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  const start = await cp.show("fixture", "A-10");
  assert.equal(start.state.flowVersion, "role-steps-v2");
  assert.equal(start.state.cursors.controller_ai, "C00_A_REQUIREMENTS");
  assert.equal(start.state.cursors.developer_ai, "D01_CLAIM");
  await assert.rejects(step(cp, "controller_ai", "C01_SCAN"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP"]) {
    await step(cp, "controller_ai", id);
  }
  assert.equal((await cp.show("fixture", "A-10")).state.cursors.controller_ai, "C01_SCAN");
  const env = await step(cp, "controller_ai", "C00_D_ENVIRONMENT");
  assert.equal(env.state.cursors.controller_ai, "C01_SCAN");
  await assert.rejects(step(cp, "controller_ai", "C00_D_ENVIRONMENT"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  await step(cp, "controller_ai", "C01_SCAN");
  await step(cp, "controller_ai", "C02_TRIAGE");
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.001", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  const result = await step(cp, "controller_ai", "C03_DISPATCH", {
    eventId: dispatch.event.event_id
  });
  assert.equal(result.state.cursors.controller_ai, "C08_NEXT");
  await assert.rejects(step(cp, "controller_ai", "C04_MERGE_MAIN"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  await step(cp, "controller_ai", "C08_NEXT");
  assert.equal((await cp.show("fixture", "A-10")).state.cursors.controller_ai, null);
  assert.equal((await cp.show("fixture", "A-10")).state.records
    .filter((entry) => ["C04_MERGE_MAIN", "C05_POSTMERGE", "C06_CLEANUP", "C07_COMPLETE"]
      .includes(entry.stepId)).length, 0, "no fabricated delivery steps");
});

test("v2 developer moves D08 handoff to D09_NEXT without assuming QA PASS or developer merge ownership", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) await step(cp, "controller_ai", id);
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.002", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: dispatch.event.event_id });
  await step(cp, "controller_ai", "C08_NEXT");
  const claimed = await claimDev(taskStore);
  await step(cp, "developer_ai", "D01_CLAIM", { eventId: claimed.eventId });
  for (const id of ["D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3"]) await step(cp, "developer_ai", id);
  const handoff = await taskStore.updateTask("fixture", "A-10", { status: "待独测" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.handoff.002", eventType: "handoff",
    actorType: "developer_ai", actorId: "developer", sessionId: "developer_ai.session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }
  });
  const handed = await step(cp, "developer_ai", "D08_HANDOFF", { eventId: handoff.eventId });
  assert.equal(handed.state.cursors.developer_ai, "D09_NEXT");
  await assert.rejects(step(cp, "developer_ai", "D09_MERGE_MAIN"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  await assert.rejects(step(cp, "developer_ai", "D10_POSTMERGE"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  const done = await step(cp, "developer_ai", "D09_NEXT");
  assert.equal(done.state.cursors.developer_ai, null);
  assert.equal((await taskStore.getTask("fixture", "A-10")).task.status, "待独测");
});

test("v1 checkpoints remain on their original cursor sequence when reopened by v2 runtime", async (t) => {
  const { f, cp: legacy, taskStore } = await fixture(t);
  await step(legacy, "controller_ai", "C01_SCAN");
  await step(legacy, "controller_ai", "C02_TRIAGE");
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.old.dispatch.003", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  const third = await step(legacy, "controller_ai", "C03_DISPATCH", {
    eventId: dispatch.event.event_id
  });
  const v2 = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  assert.equal((await v2.show("fixture", "A-10")).state.flowVersion, "role-steps-v1");
  const resumed = await step(v2, "controller_ai", "C04_VERIFY_NEXT");
  assert.equal(resumed.state.cursors.controller_ai, null);
  assert.equal(resumed.state.records.length, third.state.records.length + 1);
  assert.equal(resumed.state.flowVersion, "role-steps-v1");
  await assert.rejects(step(v2, "controller_ai", "C08_NEXT"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  const newTask = await v2.show("fixture", "T-01");
  assert.equal(newTask.state.flowVersion, "role-steps-v2");
  assert.equal(newTask.state.cursors.controller_ai, "C00_A_REQUIREMENTS");
});

test("new checkpoint rejects unknown step versions and forged old cursor before writing anything", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  assert.throws(() => new TaskStepCheckpoint(f.boardRoot, { taskStore, flowVersion: "untrusted-version" }),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
  await step(cp, "controller_ai", "C00_A_REQUIREMENTS");
  const shown = await cp.show("fixture", "A-10");
  const filename = path.join(f.projectRoot, shown.file);
  const raw = await fs.readFile(filename, "utf8");
  const malformed = raw.replace('"controller_ai": "C00_B_MAIN_VERSION"',
    '"controller_ai": "D09_MERGE_MAIN"');
  assert.notEqual(malformed, raw);
  await fs.writeFile(filename, malformed, "utf8");
  await assert.rejects(cp.show("fixture", "A-10"),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
  await assert.rejects(step(cp, "controller_ai", "C00_B_MAIN_VERSION"),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
});

test("v2 real QA PASS plus new controller delivery claim reopens C00 then gates C04/C07", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) await step(cp, "controller_ai", id);
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.004", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: dispatch.event.event_id });
  await step(cp, "controller_ai", "C08_NEXT");
  const claimed = await claimDev(taskStore);
  await step(cp, "developer_ai", "D01_CLAIM", { eventId: claimed.eventId });
  for (const id of ["D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3"]) await step(cp, "developer_ai", id);
  const handoff = await taskStore.updateTask("fixture", "A-10", { status: "待独测" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.handoff.004", eventType: "handoff",
    actorType: "developer_ai", actorId: "developer", sessionId: "developer_ai.session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }
  });
  await step(cp, "developer_ai", "D08_HANDOFF", { eventId: handoff.eventId });
  await step(cp, "developer_ai", "D09_NEXT");
  await taskStore.updateTask("fixture", "A-10", {
    status: "独测中", assignee: "qa", sessionWindowName: "qa", sessionId: "qa-session"
  }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.qa-claim.004", eventType: "claim",
    actorType: "test_ai", actorId: "qa", sessionId: "qa-session"
  });
  const qa = await taskStore.updateTask("fixture", "A-10", { status: "待交付" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.qa-result.004", eventType: "test_result",
    actorType: "test_ai", actorId: "qa", sessionId: "qa-session",
    metadata: {
      atomicLifecycle: true, testResult: "pass", reportPath: "reports/qa.md",
      deliveryDisposition: "required", deliveryActions: ["candidate_merge"],
      commitSha: "a".repeat(40), headBranch: "candidate/qa"
    }
  });
  assert.equal(qa.after.status, "待交付");
  const newController = await taskStore.updateTask("fixture", "A-10", {
    status: "交付中", assignee: "controller-2",
    sessionWindowName: "controller-2", sessionId: "controller-2-session"
  }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.controller-claim.004", eventType: "claim",
    actorType: "controller_ai", actorId: "controller-2", sessionId: "controller-2-session"
  });
  assert.equal(newController.after.status, "交付中");
  const before = await cp.show("fixture", "A-10");
  assert.equal(before.state.cursors.controller_ai, null);
  await assert.rejects(step(cp, "controller_ai", "C00_A_REQUIREMENTS", {
    actorId: "forged-controller", sessionId: "forged-session"
  }), (error) => error.code === "CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  const reopened = await step(cp, "controller_ai", "C00_A_REQUIREMENTS", {
    actorId: "controller-2", sessionId: "controller-2-session"
  });
  assert.equal(reopened.state.attempts, 2);
  assert.equal(reopened.state.records.filter((e) => e.stepId === "C08_NEXT" && e.attempt === 1).length, 1);
  for (const id of ["C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) {
    await step(cp, "controller_ai", id, { actorId: "controller-2", sessionId: "controller-2-session" });
  }
  const deliveryDispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.005", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller-2", sessionId: "controller-2-session"
  });
  const c03 = await step(cp, "controller_ai", "C03_DISPATCH", {
    actorId: "controller-2", sessionId: "controller-2-session", eventId: deliveryDispatch.event.event_id
  });
  assert.equal(c03.state.cursors.controller_ai, "C04_MERGE_MAIN");
  await step(cp, "controller_ai", "C04_MERGE_MAIN",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  await step(cp, "controller_ai", "C05_POSTMERGE",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  await step(cp, "controller_ai", "C06_CLEANUP",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  const beforeClose = await cp.show("fixture", "A-10");
  await assert.rejects(step(cp, "controller_ai", "C07_COMPLETE", {
    actorId: "controller-2", sessionId: "controller-2-session"
  }), (error) => error.code === "CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture", "A-10")).sha256, beforeClose.sha256);
});
