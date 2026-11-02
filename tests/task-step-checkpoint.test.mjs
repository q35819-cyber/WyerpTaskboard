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
