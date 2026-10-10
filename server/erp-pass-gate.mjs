import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "./core/atomic-files.mjs";
const REPO=process.env.WTB_ERP_GITHUB_REPO || "example-owner/example-repo", ROUTE="/api/erp-release/pass/verify";
const SHA=/^[a-f0-9]{40}$/, HASH=/^[a-f0-9]{64}$/, ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{3,199}$/;
const BRANCH=/^(?:feature|fix|hotfix|codex|integration)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/;
const OK=new Set(["待交付","交付中","待用户验收","已完成"]), HOLD=new Set(["HOLD","阻断","测试失败待修复","待复测","复测中"]);
export class PassGateError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
function deny(code,status){throw new PassGateError(code,status);}
function digest(v){return crypto.createHash("sha256").update(v).digest("hex");}
function secure(a,b){return typeof a==="string" && typeof b==="string" && a.length>=32 && b.length>=32 && crypto.timingSafeEqual(Buffer.from(digest(a),"hex"),Buffer.from(digest(b),"hex"));}
function branchOk(b){return typeof b==="string"&&BRANCH.test(b)&&!b.includes("..")&&!b.includes("//")&&b!=="codex/p1-p3-candidate";}
function payloadOk(p){if(!p||p.project!=="erp-x20"||!ID.test(p.task_id||"")||!SHA.test(p.commit_sha||"")||!branchOk(p.head_branch)||!ID.test(p.evidence_id||""))deny("invalid_pass_identity",400);return {project:"erp-x20",task_id:p.task_id,commit_sha:p.commit_sha,head_branch:p.head_branch,evidence_id:p.evidence_id};}
function validUrl(raw){try{const u=new URL(raw);return u.protocol==="https:"&&!u.username&&!u.password&&!u.hash&&!u.search&&u.pathname===ROUTE;}catch{return false;}}
function last(a,fn){return [...a].reverse().find(fn);}
export class ErpPassGate{
 constructor({rootDir,taskStore,systemEventLog=null,env=process.env,fetchImpl=fetch,now=()=>Date.now(),githubHead=null}={}){
 this.rootDir=rootDir;this.taskStore=taskStore;this.systemEventLog=systemEventLog;this.env=env;this.fetchImpl=fetchImpl;this.now=now;this.githubHead=githubHead;
 this.path=path.join(rootDir,"data","erp-pass-dispatch-gate","ledger.json");this.ledger={version:1,entries:{}};this.busy=false;}
 get verifyEnabled(){return this.env.WTB_ERP_PASS_DISPATCH_ENABLED==="1"&&validUrl(this.env.WTB_ERP_PASS_VERIFY_URL)&&(this.env.WTB_ERP_PASS_VERIFY_TOKEN||"").length>=32;}
 get dispatchEnabled(){return this.verifyEnabled&&(this.env.WTB_ERP_GITHUB_DISPATCH_TOKEN||"").length>=32;}
 authorized(token){return this.verifyEnabled&&secure(token,this.env.WTB_ERP_PASS_VERIFY_TOKEN);}
 async init(){try{const x=JSON.parse(await fs.readFile(this.path,"utf8"));if(x.version!==1||!x.entries||typeof x.entries!=="object")throw Error("ledger_invalid");this.ledger=x;}catch(e){if(e.code!=="ENOENT")throw e;}return this;}
 async persist(){await fs.mkdir(path.dirname(this.path),{recursive:true});await atomicWriteJson(this.path,this.ledger);}
 async audit(event,p={},reason=null){if(this.systemEventLog)await this.systemEventLog.append({component:"erp-pass-dispatch",event,result:event,details:{task_id:p.task_id||null,evidence_id:p.evidence_id||null,commit_sha:p.commit_sha||null,reason}});}
 async head(branch){if(this.githubHead)return this.githubHead(branch);const u="https://api.github.com/repos/"+REPO+"/branches/"+branch.split("/").map(encodeURIComponent).join("/");const r=await this.fetchImpl(u,{headers:{"User-Agent":"WyerpTaskboard-ERP-PASS","Accept":"application/vnd.github+json"},redirect:"error",signal:AbortSignal.timeout(12000)});if(!r.ok)deny("github_head_unavailable",503);return (await r.json()).commit?.sha;}
 async verify(input){
  const p=payloadOk(input);if(!this.verifyEnabled)deny("gate_disabled",503);
  const {task}=await this.taskStore.getTask("erp-x20",p.task_id);if(!OK.has(task.status)||HOLD.has(task.status))deny("task_not_ready");
  const h=await this.taskStore.taskHistory("erp-x20",p.task_id,{limit:1000});
  const e=h.find(x=>x.event_id===p.evidence_id&&x.event_type==="test_result"),m=e?.metadata;
  if(!e||e.actor_type!=="test_ai"||m?.testResult!=="pass"||m.atomicLifecycle!==true||!["独测中","复测中"].includes(m.testedFromStatus))deny("independent_pass_missing");
  if(last(h,x=>x.event_type==="test_result"&&x.actor_type==="test_ai")?.event_id!==e.event_id)deny("pass_superseded");
  if(m.commitSha!==p.commit_sha||m.headBranch!==p.head_branch||m.technicalGatesComplete!==true||!Array.isArray(m.blockers)||m.blockers.length||m.deliveryDisposition!=="required"||!Array.isArray(m.deliveryActions)||!m.deliveryActions.includes("candidate_merge"))deny("technical_evidence_invalid");
  const t=Date.parse(e.timestamp);if(!Number.isFinite(t)||t>this.now()+60000||this.now()-t>72*3600*1000)deny("pass_expired");
  const i=h.indexOf(e);if(h.slice(i+1).some(x=>["code_change","test_result","test_evidence_revoked"].includes(x.event_type)||x.metadata?.invalidatesTestEvidence===true||HOLD.has(x.new_status)))deny("pass_invalidated");
  const prior=h.slice(0,i),claim=last(prior,x=>x.event_type==="claim"&&x.actor_type==="test_ai"&&x.actor_id===e.actor_id);
  if(!claim||claim.session_id!==e.session_id)deny("tester_claim_invalid");
  const developer=last(prior,x=>x.event_type==="handoff"&&x.actor_type==="developer_ai"&&["开发中","修复中"].includes(x.metadata?.completedFromStatus));
  if(!developer||!developer.actor_id||developer.actor_id===e.actor_id||developer.session_id===e.session_id)deny("not_independent");
  const self=last(prior,x=>x.event_type==="test_result"&&x.actor_type==="developer_ai"&&x.actor_id===developer.actor_id&&x.session_id===developer.session_id&&x.metadata?.testResult==="pass"&&Date.parse(x.timestamp)<=Date.parse(developer.timestamp));
  if(!self||prior.slice(prior.indexOf(self)+1).some(x=>x.event_type==="code_change"||x.metadata?.invalidatesTestEvidence===true))deny("self_test_invalid");
  const testedSha=self.metadata?.commitSha===p.commit_sha&&self.metadata?.headBranch===p.head_branch;
  const published=last(prior,x=>x.event_type==="code_published"&&x.actor_type==="developer_ai"&&x.actor_id===developer.actor_id&&x.metadata?.pushed===true&&x.metadata?.commitSha===p.commit_sha&&x.metadata?.headBranch===p.head_branch&&Date.parse(x.timestamp)>=Date.parse(self.timestamp)&&Date.parse(x.timestamp)<=Date.parse(developer.timestamp));
  if(!testedSha&&!published)deny("self_test_commit_unbound");
  const f=path.resolve(this.rootDir,m.reportPath||"");
  const dirs=[this.rootDir,path.resolve("D:/WyerpReleaseEvidence")];
  if(!HASH.test(m.reportSha256||"")||!dirs.some(d=>{const rel=path.relative(path.resolve(d),f);return !rel.startsWith("..")&&!path.isAbsolute(rel);}))deny("report_binding_missing");
  let report;try{
   const actual=await fs.realpath(f);
   const permitted=[];for(const d of dirs){try{permitted.push(await fs.realpath(d));}catch(error){if(error?.code!=="ENOENT")throw error; /* LOG-IGNORE: optional report evidence directory may not exist in isolated tests */}}
    if(!permitted.some(d=>{const rel=path.relative(d,actual);return !rel.startsWith("..")&&!path.isAbsolute(rel);}))deny("report_path_escape");
   report=await fs.readFile(actual);
  }catch(e){if(e?.code==="report_path_escape")throw e;deny("report_unavailable");}
  if(digest(report)!==m.reportSha256)deny("report_hash_changed");
  const snapshot=await this.taskStore.snapshot("erp-x20");
  if(snapshot.tasks.some(x=>x.parent===p.task_id&&x.priority==="P0"&&!["已完成","待用户验收","已取消"].includes(x.status)))deny("unresolved_child_blocker");
  if(await this.head(p.head_branch)!==p.commit_sha)deny("github_head_changed");
  return {...p,result:"PASS",is_current:true,independent_test:true,development_self_test:"PASS",technical_gates_complete:true,developer_actor_id:developer.actor_id,tester_actor_id:e.actor_id,blockers:[],report_ref:f,tested_at:e.timestamp};
 }

 async enqueue(project,e){
  if(project!=="erp-x20"||e?.event_type!=="test_result"||e.actor_type!=="test_ai"||e.metadata?.testResult!=="pass")return false;
  const m=e.metadata||{};
  if(!SHA.test(m.commitSha||"")||!branchOk(m.headBranch)){await this.audit("missing_test_sha",{task_id:e.task_id,evidence_id:e.event_id},"no_immutable_binding");return false;}
  if(this.ledger.entries[e.event_id])return false;
  this.ledger.entries[e.event_id]={state:"pending",attempts:0,payload:{project:"erp-x20",task_id:e.task_id,commit_sha:m.commitSha,head_branch:m.headBranch,evidence_id:e.event_id}};
  await this.persist();await this.audit("queued",this.ledger.entries[e.event_id].payload);return true;
 }
 async onTestResult(project,taskId,id){
  if(project!=="erp-x20"||!id)return;
  const h=await this.taskStore.taskHistory(project,taskId,{limit:1000});
  const e=h.find(x=>x.event_id===id);
  if(await this.enqueue(project,e))await this.drain();
 }
 async defaultWorkflow(){
  const headers={Authorization:"Bearer "+this.env.WTB_ERP_GITHUB_DISPATCH_TOKEN,Accept:"application/vnd.github+json","User-Agent":"WyerpTaskboard-ERP-PASS"};
  const opts={headers,redirect:"error",signal:AbortSignal.timeout(12000)};
  const repo=await this.fetchImpl("https://api.github.com/repos/"+REPO,opts);
  if(!repo.ok)deny("github_repository_unavailable",503);
  const branch=(await repo.json()).default_branch;
  if(typeof branch!=="string"||!branch)deny("github_default_unknown");
  const workflow=await this.fetchImpl("https://api.github.com/repos/"+REPO+"/contents/.github/workflows/erp-beta-release-integration.yml?ref="+encodeURIComponent(branch),opts);
  if(!workflow.ok)deny("github_default_workflow_missing");
 }
 async drain(){
  if(this.busy||!this.dispatchEnabled)return;
  this.busy=true;
  try{for(const entry of Object.values(this.ledger.entries)){
   if(entry.state!=="pending")continue;
   let receipt;
   try{receipt=await this.verify(entry.payload);await this.defaultWorkflow();}
   catch(e){entry.state="blocked";entry.reason=e.code||"preflight_unavailable";await this.persist();await this.audit("blocked",entry.payload,entry.reason);continue;}
   entry.state="sending";entry.attempts++;entry.sentAt=new Date(this.now()).toISOString();
   await this.persist(); // never auto-replay if network state is unknown
   try{
    const response=await this.fetchImpl("https://api.github.com/repos/"+REPO+"/dispatches",{
     method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
     headers:{Authorization:"Bearer "+this.env.WTB_ERP_GITHUB_DISPATCH_TOKEN,Accept:"application/vnd.github+json","Content-Type":"application/json","User-Agent":"WyerpTaskboard-ERP-PASS"},
     body:JSON.stringify({event_type:"erp-independent-test-passed",client_payload:{task_id:receipt.task_id,commit_sha:receipt.commit_sha,head_branch:receipt.head_branch,evidence_id:receipt.evidence_id}})
    });
    if(response.status!==204)deny("github_dispatch_rejected",response.status);
    entry.state="accepted";entry.acceptedAt=new Date(this.now()).toISOString();await this.audit("accepted",entry.payload);
   }catch(e){entry.state="uncertain";entry.reason=e.code||"network_or_timeout";await this.audit("uncertain_no_auto_retry",entry.payload,entry.reason);}
   await this.persist();
  }}finally{this.busy=false;}
 }
 // Explicit retry only when no request was sent; never replay a possibly delivered POST.
 async retryBlocked(id){const e=this.ledger.entries[id];if(!e||e.state!=="blocked")return false;e.state="pending";delete e.reason;await this.persist();await this.audit("retry_preflight_only",e.payload);await this.drain();return true;}
}
