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


test("R1 independent QA FAIL report path and extracted F01/F02 are retained as evidence",()=>{
  const p=task("测试失败待修复"),report="reports/"+p.id+"/QA-Q02-FAIL-20261106.md";
  const e=event(p.status,{event_type:"test_result",actor_type:"test_ai",old_status:"独测中",
    metadata:{testResult:"fail",reportPath:report},note:"唯一独测失败"});
  const result=blockerEvidence(p,[e],[],{reportText:"# 正式QA FAIL\nF01 Windows junction 安全校验\nF02 缺少候选SHA\n"});
  assert.equal(result.reportPath,report);
  assert.equal(result.failureItems.length,2);
  assert.match(result.failureItems.join("\n"),/F01/);
  assert.match(result.failureItems.join("\n"),/F02/);
  assert.equal(result.source,"lifecycle_event");
  assert.equal(result.verifiedCurrentCause,false);
});

test("R2 report traversal, other-task and forged developer QA FAIL are all rejected",()=>{
  const p=task("测试失败待修复"),valid="reports/"+p.id+"/QA-Q02.md";
  for(const candidate of ["reports/OTHER/QA-Q02.md","reports/"+p.id+"/../secret.md",
    "../../secret.md","reports/"+p.id+"/secret.txt","reports/"+p.id+"/x.md?query"]){
    const out=blockerEvidence(p,[event(p.status,{event_type:"test_result",actor_type:"test_ai",
      old_status:"独测中",metadata:{testResult:"fail",reportPath:candidate}})],[],{
      reportText:"F01 should never appear"});
    assert.equal(out.reportPath,null,candidate);
    assert.equal(out.failureItems.length,0,candidate);
  }
  const forged=blockerEvidence(p,[event(p.status,{event_type:"test_result",
    actor_type:"developer_ai",old_status:"独测中",
    metadata:{testResult:"fail",reportPath:valid}})]);
  assert.equal(forged.reportPath,null);
  assert.equal(forged.eventId,null);
});

test("R1 fresh scan with matching project, registry revision, status and task update is current evidence",()=>{
  const now=Date.parse("2026-11-06T06:00:00.000Z"),p=task("阻断",{updatedAt:"2026-11-06T04:00:00Z"});
  const options={projectId:"fixture",registryRevision:"registry-v1",now,
    scanCandidates:[{project_id:"fixture",task_id:p.id,status:p.status,
      task_updated_at:p.updatedAt,registry_revision:"registry-v1",
      detected_at:new Date(now-60000).toISOString(),expires_at:new Date(now+300000).toISOString(),
      stale_at:null,consumed_at:null,blockers:["真实机器阻断：当前无法领取"]}]};
  const out=blockerEvidence(p,[event(p.status)],[],options);
  assert.equal(out.source,"machine_scan");assert.equal(out.verifiedCurrentCause,true);
  assert.match(out.summary,/当前机器扫描：真实机器阻断/);
  assert.equal(out.historicalOnly,false);
});

test("R2 stale, wrong project/task/registry/status, consumed or expired scan cannot become current",()=>{
  const now=Date.parse("2026-11-06T06:00:00.000Z");
  const p=task("阻断",{updatedAt:"2026-11-06T04:00:00Z"});
  const base={project_id:"fixture",task_id:p.id,status:p.status,task_updated_at:p.updatedAt,
    registry_revision:"current-v1",detected_at:new Date(now-60000).toISOString(),
    expires_at:new Date(now+300000).toISOString(),stale_at:null,consumed_at:null,
    blockers:["真实机器阻断"]};
  for(const bad of [
    {...base,project_id:"wrong"}, {...base,task_id:"WRONG"},
    {...base,status:"待开发"},{...base,task_updated_at:"past"},
    {...base,registry_revision:"old"},
    {...base,detected_at:new Date(now-60*60000).toISOString()},
    {...base,detected_at:new Date(now+60000).toISOString()},
    {...base,expires_at:new Date(now-1).toISOString()},
    {...base,stale_at:"2026-11-06"}, {...base,consumed_at:"2026-11-06"},
    {...base,blockers:[]}, {...base,blockers:"forged"}, {...base,blockers:[{unsafe:"object"}]}
  ]){
    const out=blockerEvidence(p,[event("阻断")],[],{
      projectId:"fixture",registryRevision:"current-v1",now,scanCandidates:[bad]});
    assert.equal(out.verifiedCurrentCause,false,JSON.stringify(bad));
    assert.equal(out.source,"lifecycle_event");
    assert.doesNotMatch(out.summary,/当前机器扫描/);
  }
});

test("R2 full normal 1600-character note retained, secrets stay redacted",()=>{
  const note="任务原始详情含恢复条件。".repeat(160);
  assert.ok(note.length>1600);
  const out=blockerEvidence(task("阻断"),[event("阻断",{note})]);
  assert.equal(out.originalNote,note);
  assert.doesNotMatch(out.originalNote,/已截断/);
  const sensitive=blockerEvidence(task("阻断"),[event("阻断",{
    note:note+"\npassword: secret-value"} )]);
  assert.doesNotMatch(sensitive.originalNote,/secret-value/);
});


test("R1 HTTP card and detail use actual QA report with F01/F02, valid scan only",async t=>{
  const path=(await import("node:path")).default;
  const f=await makeFixture();
  const reg=await fsAsync.readFile(f.registryPath,"utf8");
  const modified=reg.replace("| B-10 | F-022 | infrastructure | P0 | 开发中 |",
    "| B-10 | F-022 | infrastructure | P0 | 测试失败待修复 |");
  assert.notEqual(modified,reg);
  await fsAsync.writeFile(f.registryPath,modified,"utf8");
  const report="reports/B-10/QA-Q02-FAIL.md";
  await fsAsync.writeFile(path.join(f.projectRoot,report),
    "# 正式独测 FAIL\nF01 Windows junction路径违规\nF02 证据SHA不匹配\n","utf8");
  const app=await createTaskboardServer({rootDir:f.boardRoot,port:0});
  t.after(async()=>{
    if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));
    await fsAsync.rm(f.boardRoot,{recursive:true,force:true});
  });
  const eventBase={project_id:"fixture",task_id:"B-10",
    event_type:"test_result",actor_type:"test_ai",actor_id:"qa",
    session_id:"qa-session",old_status:"独测中",new_status:"测试失败待修复"};
  await app.taskStore.events.append("fixture",{
    ...eventBase,operation_id:"blocker.qa.http.test.001",
    note:"正式Q02独测FAIL",metadata:{testResult:"fail",reportPath:report}
  });
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  const root="http://127.0.0.1:"+app.server.address().port;
  const read=async()=>{
    const resp=await fetch(root+"/api/projects/fixture/tasks/B-10");
    assert.equal(resp.status,200);
    return resp.json();
  };
  const original=await read();
  assert.equal(original.blockerEvidence.reportPath,report);
  assert.match(original.blockerEvidence.failureItems.join("\n"),/F01/);
  assert.match(original.blockerEvidence.failureItems.join("\n"),/F02/);
  assert.equal(original.blockerEvidence.verifiedCurrentCause,false);
  const now=Date.now();
  const scan={project_id:"fixture",task_id:"B-10",status:"测试失败待修复",
    task_updated_at:original.updatedAt,registry_revision:original.registryRevision,
    detected_at:new Date(now-60000).toISOString(),
    expires_at:new Date(now+360000).toISOString(),
    blockers:["当前机器扫描确认阻断"],stale_at:null,consumed_at:null};
  app.scanStore.list=async()=>[scan];
  const live=await read();
  assert.equal(live.blockerEvidence.source,"machine_scan");
  assert.equal(live.blockerEvidence.verifiedCurrentCause,true);
  assert.equal(live.blockerEvidence.reportPath,report);
  const cards=await (await fetch(root+"/api/projects/fixture/tasks")).json();
  assert.equal(cards.tasks.find(x=>x.id==="B-10").blockerEvidence.source,"machine_scan");
  app.scanStore.list=async()=>[{...scan,registry_revision:"WRONG"}];
  const stale=await read();
  assert.equal(stale.blockerEvidence.source,"lifecycle_event");
  assert.equal(stale.blockerEvidence.verifiedCurrentCause,false);
  await app.taskStore.events.append("fixture",{
    ...eventBase,operation_id:"blocker.qa.http.test.002",
    note:"恶意跨目录报告不得读取",
    metadata:{testResult:"fail",reportPath:"reports/B-10/../B-10/secret.md"}
  });
  const invalid=await read();
  assert.equal(invalid.blockerEvidence.reportPath,null);
  assert.equal(invalid.blockerEvidence.failureItems.length,0);
});
