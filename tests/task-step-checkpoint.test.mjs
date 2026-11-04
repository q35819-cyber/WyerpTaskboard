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
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
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
test("new QA Q01 reopens only with a real controller-requeued Q02 BLOCK or finished Q04", async(t) => {
  for (const finished of [false, true]) {
    const {cp,taskStore}=await fixture(t);
    const label=finished?"finished":"q02block";
    await claimDev(taskStore);
    const handoff=await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",finished?{}:{result:"BLOCK"});
    const testResult=await taskStore.updateTask("fixture","A-10",
      {status:finished?"待交付":"阻断",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".result",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:finished?"pass":"blocked",
          acceptanceScope:"system",deliveryActions:finished?["candidate_merge"]:[],
          reportPath:"reports/qa-"+label+".md"}});
    if(finished) {
      await step(cp,"test_ai","Q03_RESULT",{eventId:testResult.eventId});
      await step(cp,"test_ai","Q04_NEXT");
      assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,null);
      await taskStore.updateTask("fixture","A-10",
        {status:"交付中",assignee:"controller",sessionId:"controller-session",sessionWindowName:"controller"},
        {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
          operationId:"fixture.resume.finished.controller-claim",eventType:"claim",
          actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
      await taskStore.updateTask("fixture","A-10",
        {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
        {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
          operationId:"fixture.resume.finished.delivery-block",eventType:"controller_postmerge_regression_blocked",
          actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    } else {
      assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q02_TEST");
    }
    await taskStore.updateTask("fixture","A-10",{status:"待复测"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".controller-requeue",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"new-qa-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"new-qa-session"});
    // The real legacy ledger contains event_type=true; malformed rows must not crash Q01.
    const readHistory = taskStore.taskHistory.bind(taskStore);
    taskStore.taskHistory = async (...args) => {
      const rows = await readHistory(...args);
      const claimAt = rows.findIndex((e) => e.event_id === qa2.eventId);
      assert.ok(claimAt > 0, "official QA claim is visible in returned history");
      const legacy = [true, null, 17, {}].map((value, i) => ({
        event_id: i === 0 ? "evt_0843ae860946441ef6fc0020" : "fixture-legacy-" + i,
        event_type: value, actor_type: "controller_ai", actor_id: "historical",
        old_status: "其他", new_status: "其他"
      }));
      return [...rows.slice(0, claimAt), ...legacy, ...rows.slice(claimAt)];
    };
    const before=await cp.show("fixture","A-10");
    if(!finished) {
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.resume.q02block.stop",eventType:"stop_request",
        actorType:"user",note:"暂停此独测"});
      await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"new-qa-session",eventId:qa2.eventId
      }),e=>e.code==="CHECKPOINT_STEP_ORDER");
      assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.resume.q02block.resume",eventType:"resume",
        actorType:"user",note:"重新授权后继续"});
    }
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa",sessionId:"test_ai.session",eventId:qa2.eventId
    }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
    assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
    const newStart=await step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa-new",sessionId:"new-qa-session",eventId:qa2.eventId
    });
    assert.equal(newStart.state.attempts,before.state.attempts+1);
    assert.equal(newStart.state.cursors.test_ai,"Q02_TEST");
    assert.equal(newStart.state.records.some(r=>r.attempt===before.state.attempts
      && (finished?r.stepId==="Q04_NEXT"&&r.result==="PASS":r.stepId==="Q02_TEST"&&r.result==="BLOCK")),true);
    assert.equal(newStart.state.records.some(r=>r.attempt===newStart.state.attempts
      && r.stepId==="D08_HANDOFF"&&r.result==="PASS"),false);
    assert.ok(handoff.eventId);
  }
});

test("Q02 recovery rejects fake controller restoration and true QA FAIL without repair", async(t) => {
  for (const mode of ["fake-controller", "unrepaired-fail"]) {
    const {cp,taskStore}=await fixture(t);
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
    const realBlock = mode === "fake-controller";
    await taskStore.updateTask("fixture","A-10",
      {status:realBlock?"阻断":"测试失败待修复",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".result",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:realBlock?"blocked":"fail",
          reportPath:"reports/qa-"+mode+".md",commitSha:"1".repeat(40)}});
    if (!realBlock) {
      await taskStore.updateTask("fixture","A-10",{status:"阻断"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative.fail.controllerblock",eventType:"controller_block",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    }
    await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.q02negative."+mode+".requeue",
      eventType:realBlock?"fake_requeue":"controller_requeue",
      actorType:realBlock?"developer_ai":"controller_ai",
      actorId:realBlock?"developer":"controller",
      sessionId:realBlock?"developer_ai.session":"controller-session"});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"qa-new-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"});
    const previous=await cp.show("fixture","A-10");
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
    }),e=>e.code==="CHECKPOINT_STEP_ORDER");
    assert.equal((await cp.show("fixture","A-10")).sha256,previous.sha256);
    assert.equal((await cp.show("fixture","A-10")).state.attempts,previous.state.attempts);
  }
});

test("a genuine QA FAIL reopens Q01 after repaired handoff but rejects reused candidate SHA",async(t)=>{
  for (const unchanged of [false,true]) {
    const {cp,taskStore}=await fixture(t);
    const label=unchanged?"same":"new";
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
          commitSha:"1".repeat(40)}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",{result:"FAIL"});
    await taskStore.updateTask("fixture","A-10",
      {status:"测试失败待修复",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".fail",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/real-fail.md",
          commitSha:"1".repeat(40)}});
    await taskStore.updateTask("fixture","A-10",
      {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".devclaim",eventType:"claim",
        actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
    await taskStore.updateTask("fixture","A-10",
      {status:"待复测",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".repaired",eventType:"handoff",
        actorType:"developer_ai",actorId:"repair",sessionId:"repair-session",
        metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
          commitSha:unchanged?"1".repeat(40):"2".repeat(40)}});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"qa-new-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"});
    const before=await cp.show("fixture","A-10");
    if(unchanged) {
      await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
      }),e=>e.code==="CHECKPOINT_STEP_ORDER");
      assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
    } else {
      const done=await step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
      });
      assert.equal(done.state.attempts,before.state.attempts+1);
      assert.equal(done.state.cursors.test_ai,"Q02_TEST");
      assert.equal(done.state.records.some(r=>r.attempt===before.state.attempts
        && r.stepId==="Q02_TEST" && r.result==="FAIL"),true);
    }
  }
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

test("controller-authorized QA BLOCK return reopens D01 without erasing old Q02 or letting old Session write",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"controller_hold_qa",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"controller_return_dev_for_qa_gate",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.dispatch",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session",
    note:"正式解阻派工回原开发修复步骤门禁"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.stop",eventType:"stop_request",actorType:"user",note:"用户停止"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.resume",eventType:"resume",actorType:"user",note:"用户恢复"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"developer",sessionId:"developer_ai.session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  });
  assert.equal(resumed.state.attempts,before.state.attempts+1);
  assert.equal(resumed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(resumed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(resumed.state.records.some(x=>x.attempt===before.state.attempts
    && x.stepId==="Q02_TEST" && x.result==="BLOCK"));
  assert.ok(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="D01_CLAIM" && x.eventId===repair.eventId));
  assert.equal(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="Q01_ADMISSION"),false);
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
});
test("user-command authorized QA BLOCK return reopens D01 without erasing old Q02 or letting old Session write",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"developer_user_directed_bugfix_hold",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"developer_user_directed_bugfix_requeue",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.stop",eventType:"stop_request",actorType:"user",note:"用户停止"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.resume",eventType:"resume",actorType:"user",note:"用户恢复"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"developer",sessionId:"developer_ai.session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  });
  assert.equal(resumed.state.attempts,before.state.attempts+1);
  assert.equal(resumed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(resumed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(resumed.state.records.some(x=>x.attempt===before.state.attempts
    && x.stepId==="Q02_TEST" && x.result==="BLOCK"));
  assert.ok(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="D01_CLAIM" && x.eventId===repair.eventId));
  assert.equal(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="Q01_ADMISSION"),false);
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
});
test("spoofed user-command bugfix transitions cannot reopen D01",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"developer_user_directed_bugfix_hold",
      actorType:"developer_ai",actorId:"intruder",sessionId:"fake-session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"developer_user_directed_bugfix_requeue",
      actorType:"developer_ai",actorId:"intruder",sessionId:"fake-session"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});

test("QA BLOCK return cannot restart developer D01 with forged or late controller dispatch",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const first=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:first.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.qaclaim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md"}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.hold",eventType:"controller_hold",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.return",eventType:"controller_return_developer",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.block-no-dispatch.spoof",eventType:"controller_dispatch_p0",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    note:"伪造调度"});
  const dev=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"new-dev",sessionWindowName:"new-dev",sessionId:"new-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"new-dev",sessionId:"new-session"});
  const checkpoint=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:dev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,checkpoint.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.block-no-dispatch.too-late",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session",
    note:"开发已经认领后的迟到派工不得回溯补授权"});
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:dev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,checkpoint.sha256);
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
  const before=await blocked.cp.show("fixture","A-10");
  await assert.rejects(claimDev(blocked.taskStore),
    e=>e.code==="CLAIM_DEPENDENCY_NOT_COMPLETED");
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
