import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ErpPassGate } from "../server/erp-pass-gate.mjs";
const SHA="f".repeat(40), B="fix/erp-pass-unit-20261008", ID="ERP-PASS-DEMO-T1", NOW=Date.now();
const ENV={WTB_ERP_PASS_DISPATCH_ENABLED:"1",WTB_ERP_PASS_VERIFY_URL:"https://board.example.test/api/erp-release/pass/verify",WTB_ERP_PASS_VERIFY_TOKEN:"v".repeat(48),WTB_ERP_GITHUB_DISPATCH_TOKEN:"g".repeat(48),WTB_ERP_GITHUB_REPO:"example-owner/erp-x20"};
let nonce=0;
function ev(type,actor,metadata={},step=0,extra={}){return {event_id:"evt_"+String(++nonce).padStart(10,"0"),event_type:type,actor_type:actor[0],actor_id:actor[1],session_id:actor[2],timestamp:new Date(NOW-100000+step*1000).toISOString(),metadata,...extra};}
async function setup(t,{enabled=true,fetcher}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"wtb-erp-pass-"));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const content="Independent PASS fixed SHA verified";
 await fs.writeFile(path.join(root,"qa-report.md"),content);
 const hash=crypto.createHash("sha256").update(content).digest("hex");
 const dev=["developer_ai","dev-1","dev-session"],tester=["test_ai","test-2","test-session"];
 const history=[
 ev("test_result",dev,{testResult:"pass",commitSha:SHA,headBranch:B},0),
 ev("handoff",dev,{completedFromStatus:"开发中"},1),
 ev("claim",tester,{},2),
 ev("test_result",tester,{atomicLifecycle:true,testResult:"pass",testedFromStatus:"独测中",deliveryDisposition:"required",deliveryActions:["candidate_merge"],commitSha:SHA,headBranch:B,technicalGatesComplete:true,blockers:[],reportPath:"qa-report.md",reportSha256:hash},3,{task_id:ID})
 ];
 const task={status:"待交付",id:ID};
 const store={async getTask(p,id){if(p!=="erp-x20"||id!==ID)throw Error("not_found");return {task};},async taskHistory(){return history;},async snapshot(){return {tasks:[]};}};
 const calls=[];
 const fake=fetcher||(async(url,opt={})=>{
  calls.push({url,method:opt.method||"GET",body:opt.body});
  if(url.includes("/dispatches"))return {status:204};
  if(url.includes("/contents/"))return {ok:true,status:200};
  if(url.endsWith("/erp-x20"))return {ok:true,json:async()=>({default_branch:"codex/p1-p3-candidate"})};
  throw Error("unexpected "+url);
 });
 const env=enabled?{...ENV}:{};
 const gate=await new ErpPassGate({rootDir:root,taskStore:store,env,fetchImpl:fake,githubHead:async()=>SHA,now:()=>NOW}).init();
 const payload={project:"erp-x20",task_id:ID,commit_sha:SHA,head_branch:B,evidence_id:history.at(-1).event_id};
 return {gate,history,task,root,payload,calls,env};
}
test("valid trusted PASS has matching developer/tester, SHA and report",async t=>{
 const x=await setup(t),r=await x.gate.verify(x.payload);
 assert.equal(r.result,"PASS");assert.equal(r.is_current,true);
 assert.equal(r.developer_actor_id,"dev-1");assert.equal(r.tester_actor_id,"test-2");
 assert.equal(x.gate.authorized("v".repeat(48)),true);assert.equal(x.gate.authorized("fake"),false);
});
test("missing config denies validation and dispatch",async t=>{
 const x=await setup(t,{enabled:false});await assert.rejects(x.gate.verify(x.payload),{code:"gate_disabled"});
 assert.equal(x.gate.dispatchEnabled,false);assert.equal(x.gate.authorized("v".repeat(48)),false);
});
test("FAIL/HOLD/forged/expired/changed PASS all refuse release",async t=>{
 const cases=[
 ["fail",x=>x.history.at(-1).metadata.testResult="fail"],
 ["HOLD",x=>x.task.status="HOLD"],
 ["role",x=>x.history.at(-1).actor_type="developer_ai"],
 ["SHA",x=>x.history.at(-1).metadata.commitSha="a".repeat(40)],
 ["branch",x=>x.history.at(-1).metadata.headBranch="fix/other"],
 ["event",x=>x.payload.evidence_id="evt_notfound"],
 ["same developer",x=>x.history.at(-1).actor_id="dev-1"],
 ["same session",x=>x.history.at(-1).session_id="dev-session"],
 ["missing claim",x=>x.history.splice(2,1)],
 ["missing selftest",x=>x.history.splice(0,1)],
 ["technical",x=>x.history.at(-1).metadata.technicalGatesComplete=false],
 ["no release action",x=>x.history.at(-1).metadata.deliveryActions=[]],
 ["blocker",x=>x.history.at(-1).metadata.blockers=["P0"]],
 ["digest",x=>x.history.at(-1).metadata.reportSha256="1".repeat(64)],
 ["missing report",x=>x.history.at(-1).metadata.reportSha256=""],
 ["unsafe report",x=>x.history.at(-1).metadata.reportPath="../../other"],
 ["superseded",x=>x.history.push(ev("test_result",["test_ai","test-2","test-session"],{testResult:"fail"},4))],
 ["code change",x=>x.history.push(ev("code_change",["developer_ai","dev-1","dev-session"],{invalidatesTestEvidence:true},4))],
 ["expired",x=>x.history.at(-1).timestamp=new Date(NOW-74*3600000).toISOString()],
 ["unknown task",x=>x.payload.task_id="OTHER-TASK"]
 ];
 for(const [name,mutate]of cases){const x=await setup(t);mutate(x);await assert.rejects(x.gate.verify(x.payload),undefined,name);}
 const drift=await setup(t);drift.gate.githubHead=async()=>("0".repeat(40));
 await assert.rejects(drift.gate.verify(drift.payload),{code:"github_head_changed"});
});

test("PASS dispatch once even with concurrent calls; persisted ledger survives restart",async t=>{
 const x=await setup(t);
 assert.equal(await x.gate.enqueue("erp-x20",x.history.at(-1)),true);
 assert.equal(await x.gate.enqueue("erp-x20",x.history.at(-1)),false);
 await Promise.all([x.gate.drain(),x.gate.drain(),x.gate.drain()]);
 const posts=x.calls.filter(y=>y.url.endsWith("/dispatches"));
 assert.equal(posts.length,1);
 assert.deepEqual(JSON.parse(posts[0].body),{event_type:"erp-independent-test-passed",
  client_payload:{task_id:ID,commit_sha:SHA,head_branch:B,evidence_id:x.payload.evidence_id}});
 assert.equal(x.gate.ledger.entries[x.payload.evidence_id].state,"accepted");
 const recovered=await new ErpPassGate({rootDir:x.root,taskStore:x.gate.taskStore,env:x.env,fetchImpl:x.gate.fetchImpl,githubHead:async()=>SHA,now:()=>NOW}).init();
 await recovered.drain();assert.equal(x.calls.filter(y=>y.url.endsWith("/dispatches")).length,1);
});
test("missing default-branch workflow blocks POST; retry only pre-send failures",async t=>{
 let active=false,posts=0;
 const x=await setup(t,{fetcher:async(url)=>{
  if(url.endsWith("/erp-x20"))return {ok:true,json:async()=>({default_branch:"codex/p1-p3-candidate"})};
  if(url.includes("/contents/"))return {ok:active,status:active?200:404};
  if(url.endsWith("/dispatches")){posts++;return {status:204};}
  throw Error("unexpected");
 }});
 await x.gate.enqueue("erp-x20",x.history.at(-1));await x.gate.drain();
 assert.equal(x.gate.ledger.entries[x.payload.evidence_id].state,"blocked");
 assert.equal(posts,0);active=true;
 assert.equal(await x.gate.retryBlocked(x.payload.evidence_id),true);
 assert.equal(posts,1);assert.equal(x.gate.ledger.entries[x.payload.evidence_id].state,"accepted");
});
test("network timeout and GitHub 403 never automatically repeat uncertain dispatch",async t=>{
 for(const scenario of ["timeout","reject"]){
  let posts=0;const x=await setup(t,{fetcher:async(url)=>{
   if(url.endsWith("/erp-x20"))return {ok:true,json:async()=>({default_branch:"codex/p1-p3-candidate"})};
   if(url.includes("/contents/"))return {ok:true,status:200};
   if(url.endsWith("/dispatches")){posts++;if(scenario==="timeout")throw Error("timeout");return {status:403};}
   throw Error("unexpected");
  }});
  await x.gate.enqueue("erp-x20",x.history.at(-1));await x.gate.drain();
  assert.equal(x.gate.ledger.entries[x.payload.evidence_id].state,"uncertain");
  assert.equal(await x.gate.retryBlocked(x.payload.evidence_id),false);
  await x.gate.drain();assert.equal(posts,1);
 }
});
test("missing config queues but never sends; old legacy PASS without SHA is ignored",async t=>{
 const x=await setup(t,{enabled:false});assert.equal(await x.gate.enqueue("erp-x20",x.history.at(-1)),true);
 await x.gate.drain();assert.equal(x.calls.length,0);
 const old=await setup(t);delete old.history.at(-1).metadata.commitSha;
 assert.equal(await old.gate.enqueue("erp-x20",old.history.at(-1)),false);
});

test("developer selftest before approved commit/push may be bound by later explicit published evidence",async t=>{
 const x=await setup(t),self=x.history[0];
 delete self.metadata.commitSha;delete self.metadata.headBranch;
 await assert.rejects(x.gate.verify(x.payload),{code:"self_test_commit_unbound"});
 x.history.splice(1,0,ev("code_published",["developer_ai","dev-1","dev-session"],{commitSha:SHA,headBranch:B,pushed:true},0.5));
 assert.equal((await x.gate.verify(x.payload)).result,"PASS");
 x.history[1].metadata.pushed=false;
 await assert.rejects(x.gate.verify(x.payload),{code:"self_test_commit_unbound"});
});
test("direct child unresolved P0 blocks otherwise valid PASS",async t=>{
 const x=await setup(t);
 x.gate.taskStore.snapshot=async()=>({tasks:[{parent:ID,priority:"P0",status:"测试失败待修复"}]});
 await assert.rejects(x.gate.verify(x.payload),{code:"unresolved_child_blocker"});
});

test("audit records accepted/blocked/uncertain states without leaking credentials",async t=>{
 const x=await setup(t),records=[];
 x.gate.systemEventLog={append:async ev=>{records.push(ev);}};
 await x.gate.enqueue("erp-x20",x.history.at(-1));await x.gate.drain();
 assert.ok(records.some(e=>e.event==="queued"));assert.ok(records.some(e=>e.event==="accepted"));
 assert.equal(JSON.stringify(records).includes(x.env.WTB_ERP_GITHUB_DISPATCH_TOKEN),false);
 const y=await setup(t,{enabled:false}),second=[];y.gate.systemEventLog={append:async e=>second.push(e)};
 await y.gate.enqueue("erp-x20",y.history.at(-1));await y.gate.drain();
 assert.ok(second.some(e=>e.event==="queued"));assert.ok(!second.some(e=>e.event==="accepted"));
});
