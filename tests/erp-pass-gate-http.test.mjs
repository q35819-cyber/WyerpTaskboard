import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture, registryText } from "./helpers.mjs";
import crypto from "node:crypto";
const URL_PATH="/api/erp-release/pass/verify";
const PASS_TOKEN="t".repeat(48);
async function service(t,options={}){
 const fixture=await makeFixture();
 const app=await createTaskboardServer({rootDir:fixture.boardRoot,host:"127.0.0.1",port:0,erpPassGateOptions:options});
 await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await fs.rm(fixture.boardRoot,{recursive:true,force:true});});
 const base="http://127.0.0.1:"+app.server.address().port;
 const secret=JSON.parse(await fs.readFile(path.join(fixture.boardRoot,"config","admin-secret.json"),"utf8")).adminSecret;
 return {base,secret,app,fixture};
}
function config(){return {WTB_ERP_PASS_DISPATCH_ENABLED:"1",WTB_ERP_PASS_VERIFY_URL:"https://board.example.test"+URL_PATH,WTB_ERP_PASS_VERIFY_TOKEN:PASS_TOKEN,WTB_ERP_GITHUB_DISPATCH_TOKEN:"g".repeat(48)};}
test("disabled verification route is HTTP 503; admin secret cannot bypass dedicated pass token",async t=>{
 const d=await service(t,{env:{}}),x=await fetch(d.base+URL_PATH,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 assert.equal(x.status,503);
 const enabled=await service(t,{env:config()});
 const bare=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 assert.equal(bare.status,401);
 const admin=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Authorization:"Bearer "+enabled.secret},body:"{}"});
 assert.equal(admin.status,401);
 const bad=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Authorization:"Bearer "+PASS_TOKEN,"Content-Type":"application/json"},body:"{}"});
 assert.equal(bad.status,400);
 const origin=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Origin:"https://evil.example",Authorization:"Bearer "+PASS_TOKEN},body:"{}"});
 assert.equal(origin.status,403);
});
test("admin retry endpoint requires browser session and CSRF and cannot retry unknown evidence",async t=>{
 const x=await service(t,{env:config()});
 let r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Authorization:"Bearer "+PASS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({evidence_id:"evt_"+"a".repeat(24)})});
 assert.equal(r.status,401);
 r=await fetch(x.base+"/api/auth/login",{method:"POST",headers:{Origin:x.base,"Content-Type":"application/json"},body:JSON.stringify({secret:x.secret})});
 assert.equal(r.status,200);const csrf=(await r.json()).csrfToken,cookie=r.headers.get("set-cookie").split(";")[0];
 r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Cookie:cookie,Origin:x.base,"Content-Type":"application/json"},body:"{}"});
 assert.equal(r.status,403);
 r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Cookie:cookie,Origin:x.base,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({evidence_id:"evt_"+"a".repeat(24)})});
 assert.equal(r.status,409);
});

test("ERP candidate_merge rejects old unbound PASS before status update, valid evidence queues without dispatch when disabled",async t=>{
 const x=await service(t,{env:{}});
 x.app.taskStore.projects.projects.set("erp-x20",{...x.app.taskStore.projects.get("fixture"),id:"erp-x20"});
 const id="ERP-GATE-001",session="qa-session";
 await fs.writeFile(x.fixture.registryPath,registryText([
  [id,"ERP-ROOT","bugfix","P1","独测中","独立测试AI","tester","独测窗口",session,"2026-10-12T00:00:00Z","可信Release证据测试","测试计划.md","cp/ERP-GATE-001.md"]
 ]),"utf8");
 const url=x.base+"/api/projects/erp-x20/tasks/"+id;
 const headers={Authorization:"Bearer "+x.secret,"Content-Type":"application/json"};
 const read=async()=>{const r=await fetch(url,{headers});assert.equal(r.status,200);return r.json();};
 const submit=async(operationId,metadata)=>{
  const before=await read();
  return fetch(url+"/test-result",{method:"POST",headers,body:JSON.stringify({
   operationId,expectedRevision:before.registryRevision,actorType:"test_ai",actorId:"tester",sessionId:session,
   testResult:"pass",deliveryDisposition:"required",deliveryActions:["candidate_merge"],
   reportPath:"reports/ERP-GATE-001/pass.md",metadata
  })});
 };
 const before=await read();
 let response=await submit("erp-gate.unbound",undefined);
 assert.equal(response.status,409);
 assert.equal((await response.json()).error.code,"ERP_PASS_EVIDENCE_REQUIRED");
 assert.equal((await read()).status,"独测中");
 const dir=path.join(x.fixture.boardRoot,"reports","ERP-GATE-001");await fs.mkdir(dir,{recursive:true});
 const report=path.join(dir,"pass.md");await fs.writeFile(report,"immutable QA report");
 const md={commitSha:"a".repeat(40),headBranch:"fix/erp-qa-gate",
  technicalGatesComplete:true,blockers:[],reportSha256:crypto.createHash("sha256").update("immutable QA report").digest("hex")};
 response=await submit("erp-gate.bad-hash",{...md,reportSha256:"b".repeat(64)});
 assert.equal(response.status,409);
 assert.equal((await read()).status,"独测中");
 response=await submit("erp-gate.bound",md);
 assert.equal(response.status,200);
 assert.equal((await response.json()).after.status,"待交付");
 assert.equal(Object.values(x.app.erpPassGate.ledger.entries).filter(e=>e.state==="pending").length,1);
 assert.equal(x.app.erpPassGate.dispatchEnabled,false);
 assert.equal(before.status,"独测中");
});

test("ERP code_published requires active developer execution and exact pushed commit binding",async t=>{
 const x=await service(t,{env:{}});
 x.app.taskStore.projects.projects.set("erp-x20",{...x.app.taskStore.projects.get("fixture"),id:"erp-x20"});
 const id="ERP-CODE-001",session="developer-session";
 await fs.writeFile(x.fixture.registryPath,registryText([
  [id,"ERP-ROOT","bugfix","P1","开发中","开发AI","developer","开发窗口",session,"2026-10-12T00:00:00Z","Git提交证据测试","测试计划.md","cp/ERP-CODE-001.md"]
 ]),"utf8");
 await x.app.taskStore.appendTaskEvent("erp-x20",id,{
  operationId:"fixture-claim",eventType:"claim",actorType:"developer_ai",
  actorId:"developer",sessionId:session,sessionWindowName:"开发窗口",metadata:{}
 });
 const url=x.base+"/api/projects/erp-x20/tasks/"+id+"/events";
 const headers={Authorization:"Bearer "+x.secret,"Content-Type":"application/json"};
 const post=async(operationId,actorId,metadata)=>fetch(url,{method:"POST",headers,
  body:JSON.stringify({operationId,eventType:"code_published",actorType:"developer_ai",
    actorId,sessionId:session,metadata})});
 const sha="1".repeat(40),branch="fix/erp-code-bound";
 let response=await post("erp-published.unbound","developer",{pushed:true});
 assert.equal(response.status,409);
 assert.equal((await response.json()).error.code,"ERP_CODE_PUBLISHED_BINDING_REQUIRED");
 response=await post("erp-published.wrong-actor","intruder",{commitSha:sha,headBranch:branch,pushed:true});
 assert.equal(response.status,409);
 response=await post("erp-published.bound","developer",{commitSha:sha,headBranch:branch,pushed:true});
 assert.equal(response.status,200);
 const events=await x.app.taskStore.taskHistory("erp-x20",id,{limit:30});
 const record=events.find(e=>e.event_type==="code_published");
 assert.equal(record.actor_id,"developer");
 assert.equal(record.metadata.commitSha,sha);
 assert.equal(record.metadata.headBranch,branch);
 assert.equal(record.metadata.pushed,true);
});
