import test from "node:test";
import assert from "node:assert/strict";
import { blockerEvidence } from "../server/blocker-evidence.mjs";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";
import fsAsync from "node:fs/promises";
const task=(status,more={})=>({id:"WTB-P0-CARD-20261106-T1",status,...more});
const event=(status,over={})=>({
  project_id:"wyerp-taskboard",task_id:"WTB-P0-CARD-20261106-T1",event_id:"evt_123",
  event_type:"developer_step_cursor_blocked",old_status:"开发中",new_status:status,
  timestamp:"2026-11-06T00:00:00Z",actor_type:"developer_ai",
  note:"真正CHECKPOINT_STEP_ORDER，等待系统修复游标",metadata:{},...over
});
test("R1 latest blocker transition records code, source and real dependency",()=>{
  const p=task("阻断",{readDependencies:"WTB-P0-UPSTREAM-20261106-T1完成"});
  const history=[event("阻断",{event_id:"evt_old",note:"CLAIM_CONFLICT"}),
    event("阻断",{event_id:"evt_new"}),event("阻断",{event_id:"evt_later",old_status:"阻断",note:"已安排处理"})];
  const data=blockerEvidence(p,history,[{id:"WTB-P0-UPSTREAM-20261106-T1",status:"开发中"}]);
  assert.equal(data.eventId,"evt_new");assert.equal(data.recordedCode,"CHECKPOINT_STEP_ORDER");
  assert.match(data.summary,/未完成前置/);assert.match(data.recovery,/系统核验/);
  assert.equal(data.verifiedCurrentCause,false);
});
test("R1 independent QA FAIL retains the actual latest QA report",()=>{
  const h=[event("测试失败待修复",{
    event_type:"test_result",old_status:"独测中",actor_type:"test_ai",
    metadata:{testResult:"fail",reportPath:"reports/qa-fail.md"},note:"F01 junction ACL violation"})];
  const out=blockerEvidence(task("测试失败待修复"),h,[]);
  assert.equal(out.eventType,"test_result");assert.match(out.recovery,/原开发/);
  assert.equal(out.source,"lifecycle_event");
});
test("R1 HOLD derives only from formal lifecycle event",()=>{
  const out=blockerEvidence(task("HOLD"),[
    event("HOLD",{event_id:"evt_hold",event_type:"controller_hold_split_parent_pending_child_delivery",
      actor_type:"controller_ai",old_status:"待准备",note:"暂停待子任务交付"})]);
  assert.equal(out.eventId,"evt_hold");assert.match(out.recovery,/子项/);
});
test("R2 developer PASS cannot masquerade as independent QA FAIL",()=>{
  const out=blockerEvidence(task("测试失败待修复"),[
    event("测试失败待修复",{event_type:"test_result",actor_type:"developer_ai",metadata:{testResult:"pass"}})
  ]);
  assert.equal(out.source,"unverified");assert.match(out.summary,/请核验/);
});
test("R2 stale status event and wrong task are rejected",()=>{
  const out=blockerEvidence(task("阻断"),[
    event("阻断",{task_id:"WTB-P1-FOREIGN-20261106-T1"}),
    event("待开发",{old_status:"阻断"})
  ]);
  assert.equal(out.eventId,null);
});
test("R2 no event never fabricates a blocker or proof",()=>{
  const out=blockerEvidence(task("阻断"),[],[]);
  assert.equal(out.source,"unverified");assert.equal(out.verifiedCurrentCause,false);
  assert.match(out.summary,/缺少可信/);
});
test("R2 redact secrets, emails and phone numbers from human notes",()=>{
  for(const note of ["password:abcd","Authorization: Bearer abc","test@example.com","13812345678"]){
    const out=blockerEvidence(task("阻断"),[event("阻断",{note})]);
    assert.doesNotMatch(out.originalNote,/abcd|Bearer abc|example.com|13812345678/);
  }
});
test("R2 current non-abnormal statuses must not keep historical blocker badge",()=>{
  assert.equal(blockerEvidence(task("待开发"),[event("阻断")]),null);
});

test("R1 actual HTTP task snapshot and detail expose matching lifecycle evidence", async t => {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if(app.server.listening)await new Promise(resolve => app.server.close(resolve));
    await fsAsync.rm(fixture.boardRoot,{recursive:true,force:true});
  });
  const current = await app.taskStore.getTask("fixture","B-10");
  const changed = await app.taskStore.updateTask("fixture","B-10",
    { status:"阻断", assignee:"", sessionId:"", sessionWindowName:"" },{
      expectedRevision:current.snapshot.registryRevision,
      operationId:"blocker.evidence.http.test.0001",
      eventType:"temporary_block",actorType:"developer_ai",
      actorId:"qa-fixture",sessionId:"qa-fixture-session",
      note:"CHECKPOINT_STEP_ORDER failed",metadata:{conditions:[{kind:"required_file_exists",path:"read/B-10.md"}]}
    });
  const base="http://127.0.0.1:"+app.server.address().port;
  const list=await (await fetch(base+"/api/projects/fixture/tasks")).json();
  const card=list.tasks.find(x=>x.id==="B-10");
  assert.equal(card.blockerEvidence.eventId,changed.eventId);
  assert.equal(card.blockerEvidence.recordedCode,"CHECKPOINT_STEP_ORDER");
  const detail=await (await fetch(base+"/api/projects/fixture/tasks/B-10")).json();
  assert.equal(detail.blockerEvidence.eventId,changed.eventId);
  assert.equal(detail.blockerEvidence.verifiedCurrentCause,false);
});
