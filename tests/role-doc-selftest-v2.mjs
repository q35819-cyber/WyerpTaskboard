import fs from "node:fs";
import cp from "node:child_process";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const SRC="tests/role-doc-selftest-v2.mjs";
const ROOT="tests/evidence/role-doc-selftest-r2";
const DOCS=["AGENTS.md","WORKFLOW.md","总控AI.md","开发AI.md","独立测试AI.md","data/taskboard/plans/WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1.md","tests/fixtures/role-doc-selftest/WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1.md"];
const H=b=>crypto.createHash("sha256").update(b).digest("hex");
const RF=f=>fs.readFileSync(f);
const R=f=>RF(f).toString("utf8");
const J=f=>JSON.parse(R(f));
const OUT=(o)=>console.log(JSON.stringify(o));
const NOW=()=>new Date().toISOString();
const ACTOR=process.env.WTB_SELFTEST_ACTOR || "wtb-dev-p1-recovery-20261101-59558da5";
const SESSION=process.env.WTB_SELFTEST_SESSION || "wc_sess_59558da53899414cb784e68bfbecb624";
const CMD=(name,args)=>cp.spawnSync(name,args,{encoding:"utf8",timeout:23000,maxBuffer:12000000});
const SNAP=()=>DOCS.map(file=>({file,bytes:fs.statSync(file).size,sha256:H(RF(file))}));
const TERMS=[
["s01","WORKFLOW.md",["三轮完整自测硬门禁","自测①——规则/逻辑完整性"]],
["s02","WORKFLOW.md",["自测②——现有系统与真实工作范围可执行性","自测③——场景与逆向推演"]],
["s03","WORKFLOW.md",["三轮自测证据格式及防伪校验","核验器必须fail-closed"]],
["s04","WORKFLOW.md",["每轮都须覆盖**全部变更文档**","全部三轮结果失效"]],
["s05","WORKFLOW.md",["实际检查项和命令","真实退出码","证据文件路径"]],
["s06","AGENTS.md",["三轮完整自测硬门禁","总控"]],
["s07","总控AI.md",["三轮规则自测","第一部分【流程检查结果】","第三部分【下一步安排】"]],
["s08","开发AI.md",["开发修改文档后的三轮完整自测","单任务串行"]],
["s09","独立测试AI.md",["文档独立测试与开发三轮自测证据准入","SHA不一致"]],
["s10","开发AI.md",["开发AI-A执行任务A、开发AI-B执行任务B","远端main只能按受控顺序交付"]],
["s11","独立测试AI.md",["跨项目全局互斥","项目ID + 任务ID"]],
["s12","开发AI.md",["AI不得仅凭自己向API正文","旧Session失去该任务后续claim"]],
["s13","独立测试AI.md",["不能凭QA自己在请求体","旧Session恢复在线不得继续"]],
["s14","WORKFLOW.md",["不自动唤醒","逐步推演"]],
["s15",DOCS[5],["依赖门禁","不得等待父P1才能拥有认领门禁"]],
["s16",DOCS[6],["依赖门禁复用子P1内核","通用模板须引用仓库根目录权威"]],
["s17",DOCS[5],["本P1任务最先实现","AGENTS.md","WORKFLOW.md"]],
["s18",DOCS[6],["仅为兼容指针","版本化断点schema/接口"]],
["s19",DOCS[5],["独测F01-F03闭环","Task/Stage/Attempt/Event"]],
["s20","WORKFLOW.md",["隔离的证据副本","第三轮按状态逐步推演"]]
];
const CLI=["c01","c02","c03","c04","c05","c06","c07","c08","c09","c10","c11","c12"];
const SCENARIOS=[
["t01","happy_delivery"],["t02","qa_fail_rework"],["t03","missing_qa"],["t04","no_auth_takeover"],["t05","auth_takeover_old_fenced"],["t06","old_not_fenced"],["t07","wrong_sha"],["t08","empty_report"],["t09","main_advanced"],["t10","regression_required"],["t11","double_claim"],["t12","hold_gate"],["t13","global_qa_queue"],["t14","parallel_resource_conflict"],["t15","continue_idempotent"],["t16","dirty_snapshot"],["t17","qa_same_developer"],["t18","self_asserted_user_authorization"],["t19","old_session_reclaim"]
];
const all=(round)=>round===1?TERMS.map(x=>x[0]):round===2?CLI:SCENARIOS.map(x=>x[0]);

function inspectTerm(file,term){
 const lines=R(file).split(/\r?\n/),i=lines.findIndex(s=>s.includes(term));
 return {file,line:i<0?null:i+1,term,excerpt:i<0?"":lines[i].trim().slice(0,240),sourceSHA256:H(RF(file)),valid:i>=0};
}
function runExternal(name,args,expect=(x)=>x.status===0){
 const r=CMD(name,args);
 return {command:[name,...args],exitCode:r.status,stdoutSHA256:H(Buffer.from(r.stdout||"")),stderrSHA256:H(Buffer.from(r.stderr||"")),stdout:r.stdout||"",stderr:(r.stderr||"").slice(0,2500),ok:expect(r)};
}
function simulate(id){
 const map={t01:"happy_delivery",t02:"qa_fail_rework",t03:"missing_qa",t04:"no_auth_takeover",t05:"auth_takeover_old_fenced",t06:"old_not_fenced",t07:"wrong_sha",t08:"empty_report",t09:"main_advanced",t10:"regression_required",t11:"double_claim",t12:"hold_gate",t13:"global_qa_queue",t14:"parallel_resource_conflict",t15:"continue_idempotent",t16:"dirty_snapshot",t17:"qa_same_developer",t18:"self_asserted_user_authorization",t19:"old_session_reclaim"};
 const type=map[id];const A="developer-A", B="developer-B", Q="one-qa",sha1="a".repeat(40),sha2="b".repeat(40);
 const s={projectId:"wyerp-taskboard",taskId:"SIM-"+id,status:type==="hold_gate"?"HOLD":"待开发",stage:"dev",attempt:0,owner:null,ownerSession:null,qaOwner:null,qaSession:null,candidateSHA:null,qaPassSHA:null,reportSHA:null,merged:false,regressed:false,mainBase:"main0",mainNow:"main0",lastCheckpoint:null,dirty:["preserved-user-file"],events:[],version:0};
 const steps=[];
 function apply(op,o={}){
  const before={status:s.status,stage:s.stage,owner:s.owner,ownerSession:s.ownerSession,qaOwner:s.qaOwner,attempt:s.attempt,candidateSHA:s.candidateSHA,qaPassSHA:s.qaPassSHA,mainNow:s.mainNow,merged:s.merged,dirty:[...s.dirty]};
  let ok=false,reason="DENIED",actor=o.actor||A,session=o.session||"session-"+actor;
  const ownerMatches=()=>s.owner===actor&&s.ownerSession===session;
  if(op==="dev_claim"){ok=(s.status==="待开发"||s.status==="测试失败待修复")&&!s.owner&&(!o.conflict);if(ok){s.owner=actor;s.ownerSession=session;s.status=s.status==="待开发"?"开发中":"修复中";s.attempt+=1}}
  if(op==="checkpoint"){ok=ownerMatches();if(ok)s.lastCheckpoint=o.step||"STEP-01"}
  if(op==="handoff"){ok=ownerMatches()&&!!s.lastCheckpoint&&/^[a-f0-9]{40}$/.test(o.sha||"");if(ok){s.candidateSHA=o.sha;s.status="待独测";s.owner=null;s.ownerSession=null;s.qaPassSHA=null;s.reportSHA=null;s.stage="qa";s.lastCheckpoint=null}}
  if(op==="qa_claim"){ok=s.status==="待独测"&&!s.qaOwner&&actor!==A&&o.sha===s.candidateSHA;if(ok){s.qaOwner=actor;s.qaSession=session;s.status="独测中"}}
  if(op==="qa_result"){ok=s.status==="独测中"&&s.qaOwner===actor&&s.qaSession===session&&o.sha===s.candidateSHA&&o.validReport!==false;if(ok){s.qaOwner=null;s.qaSession=null;if(o.pass){s.qaPassSHA=s.candidateSHA;s.reportSHA="report-"+o.sha.slice(0,8);s.status="待交付";s.stage="delivery"}else{s.qaPassSHA=null;s.reportSHA=null;s.status="测试失败待修复";s.stage="dev"}}}
  if(op==="delivery_claim"){ok=s.status==="待交付"&&o.actor===A&&s.qaPassSHA===s.candidateSHA&&!!s.reportSHA;if(ok){s.owner=actor;s.ownerSession=session;s.status="交付中"}}
  if(op==="merge"){ok=s.status==="交付中"&&ownerMatches()&&s.qaPassSHA===s.candidateSHA&&s.mainNow===s.mainBase;if(ok)s.merged=true}
  if(op==="regress"){ok=s.status==="交付中"&&ownerMatches()&&s.merged&&o.passed===true;if(ok)s.regressed=true}
  if(op==="close"){ok=s.status==="交付中"&&ownerMatches()&&s.merged&&s.regressed;if(ok){s.status="已完成";s.owner=null;s.ownerSession=null}}
  if(op==="takeover"){ok=!!o.userApproval&&o.authorizationSource==="server_verified_user_event"&&o.boundTask===s.taskId&&o.oldFenced===true&&s.owner!==null&&!!o.newActor&&o.newActor!==s.owner&&o.newSession!==s.ownerSession;if(ok){s.owner=o.newActor;s.ownerSession=o.newSession;s.version+=1}}
  if(op==="continue"){ok=ownerMatches()&&s.status==="开发中";if(ok)s.lastCheckpoint=s.lastCheckpoint||"STEP-CONTINUE"}
  if(op==="move_main"){ok=true;s.mainNow="main1"}
  if(op==="resource_claim"){const k=o.resource||"common";ok=!s.events.some(x=>x.op==="resource_claim"&&x.ok&&x.resource===k&&x.actor!==actor)}
  if(op==="qa_global_claim"){ok=!s.events.some(x=>x.op==="qa_global_claim"&&x.ok&&!s.events.some(y=>y.op==="qa_global_release"&&y.taskId===x.taskId));}
  if(op==="qa_global_release")ok=s.events.some(x=>x.op==="qa_global_claim"&&x.ok&&x.taskId===o.taskId);
  if(op==="restart"){ok=!!s.lastCheckpoint&&s.dirty.includes("preserved-user-file");}
  if(ok)reason="ACCEPTED";
  const event={eventId:"sim-"+(steps.length+1),op,actor,session,taskId:o.taskId||s.taskId,resource:o.resource||null,candidateSHA:o.sha||s.candidateSHA,accepted:ok,reason,pre:before,post:{status:s.status,stage:s.stage,owner:s.owner,ownerSession:s.ownerSession,qaOwner:s.qaOwner,qaSession:s.qaSession,attempt:s.attempt,candidateSHA:s.candidateSHA,qaPassSHA:s.qaPassSHA,mainNow:s.mainNow,merged:s.merged,dirty:[...s.dirty]},expectedAccepted:o.expect!==false};
  s.events.push({op,ok,actor,taskId:o.taskId||s.taskId,resource:o.resource||null});
  steps.push(event);
  return event;
 }
 const claim={actor:A,session:"session-"+A},qaClaim={actor:Q,session:"session-"+Q,sha:sha1},report={...qaClaim,pass:true};
 const begin=()=>{apply("dev_claim",claim);apply("checkpoint",{...claim,step:"DEV-01"});apply("handoff",{...claim,sha:sha1})};
 const qaReady=()=>{begin();apply("qa_claim",qaClaim)};
 const pass=()=>{qaReady();apply("qa_result",report)};
 if(type==="happy_delivery"){pass();apply("delivery_claim",claim);apply("merge",claim);apply("regress",{...claim,passed:true});apply("close",claim)}
 if(type==="qa_fail_rework"){qaReady();apply("qa_result",{...qaClaim,pass:false});apply("dev_claim",claim);apply("checkpoint",{...claim,step:"DEV-REPAIR"});apply("handoff",{...claim,sha:sha2});apply("qa_claim",{...qaClaim,sha:sha2});apply("qa_result",{...report,sha:sha2})}
 if(type==="missing_qa"){begin();apply("delivery_claim",{...claim,expect:false})}
 if(type==="no_auth_takeover"){apply("dev_claim",claim);apply("checkpoint",{...claim,step:"PRE-AUTH"});apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,oldFenced:true,userApproval:false,expect:false})}
 if(type==="auth_takeover_old_fenced"){apply("dev_claim",claim);apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,oldFenced:true,userApproval:true,authorizationSource:"server_verified_user_event"});apply("continue",{...claim,expect:false});apply("checkpoint",{actor:B,session:"session-B",step:"DEV-RESUME"})}
 if(type==="old_not_fenced"){apply("dev_claim",claim);apply("checkpoint",{...claim,step:"OLD-OWNED"});apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,userApproval:true,authorizationSource:"server_verified_user_event",oldFenced:false,expect:false})}
 if(type==="wrong_sha"){begin();apply("qa_claim",{...qaClaim,sha:sha2,expect:false});apply("qa_claim",qaClaim)}
 if(type==="empty_report"){qaReady();apply("qa_result",{...report,validReport:false,expect:false});apply("qa_result",report)}
 if(type==="main_advanced"){pass();apply("delivery_claim",claim);apply("move_main");apply("merge",{...claim,expect:false})}
 if(type==="regression_required"){pass();apply("delivery_claim",claim);apply("merge",claim);apply("close",{...claim,expect:false});apply("regress",{...claim,passed:true});apply("close",claim)}
 if(type==="double_claim"){apply("dev_claim",claim);apply("dev_claim",{actor:B,session:"session-B",expect:false});apply("checkpoint",{...claim,step:"ORIGINAL-KEEPS-RIGHT"})}
 if(type==="hold_gate"){apply("dev_claim",{...claim,expect:false});apply("qa_claim",{...qaClaim,expect:false});apply("delivery_claim",{...claim,expect:false})}
 if(type==="global_qa_queue"){apply("qa_global_claim",{actor:Q,session:"session-Q",taskId:"projectA/task1"});apply("qa_global_claim",{actor:Q,session:"session-Q",taskId:"projectB/task2",expect:false});apply("qa_global_release",{actor:Q,session:"session-Q",taskId:"projectA/task1"});apply("qa_global_claim",{actor:Q,session:"session-Q",taskId:"projectB/task2"})}
 if(type==="parallel_resource_conflict"){apply("resource_claim",{actor:A,resource:"file-one"});apply("resource_claim",{actor:B,resource:"file-one",expect:false});apply("resource_claim",{actor:B,resource:"file-two"})}
 if(type==="continue_idempotent"){apply("dev_claim",claim);apply("checkpoint",{...claim,step:"DEV-01"});apply("handoff",{...claim,sha:sha1});apply("continue",{...claim,expect:false})}
 if(type==="dirty_snapshot"){apply("dev_claim",claim);apply("checkpoint",{...claim,step:"DEV-01"});apply("restart");apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,userApproval:true,authorizationSource:"server_verified_user_event",oldFenced:true})}
 if(type==="qa_same_developer"){begin();apply("qa_claim",{...claim,sha:sha1,expect:false});apply("qa_claim",qaClaim)}
 if(type==="self_asserted_user_authorization"){apply("dev_claim",claim);apply("checkpoint",claim);apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,userApproval:true,oldFenced:true,authorizationSource:"body_userApproved",expect:false})}
 if(type==="old_session_reclaim"){apply("dev_claim",claim);apply("checkpoint",claim);apply("takeover",{...claim,newActor:B,newSession:"session-B",boundTask:s.taskId,userApproval:true,oldFenced:true,authorizationSource:"server_verified_user_event"});apply("checkpoint",{...claim,expect:false});apply("checkpoint",{actor:B,session:"session-B"})}
 const passed=steps.length>=1&&steps.every(x=>x.accepted===x.expectedAccepted)&&!steps.some(x=>x.op==="takeover"&&x.accepted&&x.post.dirty.length!==x.pre.dirty.length);
 return {type:"design_simulation",scenario:type,projectId:s.projectId,taskId:s.taskId,trace:steps,finalState:{status:s.status,stage:s.stage,attempt:s.attempt,owner:s.owner,qaOwner:s.qaOwner,candidateSHA:s.candidateSHA,qaPassSHA:s.qaPassSHA,dirty:s.dirty},passed,sourceDocuments:SNAP()};
}
function checkOne(id){
 let kind="static",proof=[],nested=[],trace=null,passed=false;
 const term=TERMS.find(x=>x[0]===id);
 if(term){proof=term[2].map(t=>inspectTerm(term[1],t));passed=proof.every(x=>x.valid)}
 else if(CLI.includes(id)){
  kind="cli";
  const get=(args,pred)=>{const d=runExternal("node",["cli/taskctl.mjs",...args]);nested.push(d);return d.ok&&(pred?pred(JSON.parse(d.stdout)):true)};
  const fileProof=(f,needle,should=true)=>{const x=inspectTerm(f,needle);proof.push(x);return should?x.valid:!x.valid};
  if(id==="c01")passed=get(["help"],h=>["projects","list","get","guard"].every(x=>h.usage.some(v=>v.startsWith("taskctl "+x))));
  if(id==="c02")passed=get(["projects"],a=>a.projects.length>=2)&&fileProof("独立测试AI.md","过滤无权项目");
  if(id==="c03")passed=get(["get","--project","wyerp-taskboard","--task","WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1"],t=>["开发中","修复中","待独测","独测中","待复测","复测中","待交付","交付中","已完成"].includes(t.status)&&t.writeTargets.split(";").includes("AGENTS.md"));
  if(id==="c04")passed=get(["get","--project","wyerp-taskboard","--task","WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1"],t=>t.status==="HOLD");
  if(id==="c05")passed=get(["get","--project","wyerp-taskboard","--task","WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1"],t=>["server/candidate-evaluator.mjs","server/task-scanner.mjs","server/scan-store.mjs","server/adapters/markdown-task-registry-v1.mjs"].every(x=>t.writeTargets.split(";").includes(x)));
  if(id==="c06")passed=fileProof("server/candidate-evaluator.mjs","hardDependencyBlockers")&&fileProof(DOCS[5],"dependsOn");
  if(id==="c07")passed=fileProof("server/adapters/markdown-task-registry-v1.mjs","readDependencies")&&fileProof(DOCS[5],"重启后读回一致");
  if(id==="c08"){const d=runExternal("git",["-c","core.autocrlf=false","diff","--check"]);const staged=runExternal("git",["-c","core.autocrlf=false","diff","--cached","--check"]);nested.push(d,staged);passed=d.ok&&staged.ok}
  if(id==="c09"){const d=runExternal("node",["tests/role-doc-spec-review.mjs"]);nested.push(d);try{let x=JSON.parse(d.stdout);passed=d.ok&&x.static.passed===40&&x.scenarios.passed===15}catch{}}
  if(id==="c10"){const d=runExternal("node",["tests/role-doc-r4-contract.mjs"]);nested.push(d);try{let x=JSON.parse(d.stdout);passed=d.ok&&x.passed===26}catch{}}
  if(id==="c11")passed=get(["help"],h=>h.usage.some(v=>v.startsWith("taskctl context")))&&fileProof(DOCS[5],"context --task");
  if(id==="c12")passed=DOCS.every(f=>{const s=RF(f),pr={file:f,bytes:s.length,sha256:H(s),lineCount:R(f).split(/\r?\n/).length};proof.push(pr);return s.length>200});
 }
 else if(SCENARIOS.some(x=>x[0]===id)){kind="design_simulation";trace=simulate(id);passed=trace.passed}
 else return {id,pass:false,error:"unknown_check"};
 return {id,kind,passed,proof,nested,trace,docCoverage:SNAP()};
}
function summary(out){return {id:out.id,kind:out.kind,passed:out.passed,proof:out.proof,commands:out.nested,trace:out.trace,docCoverage:out.docCoverage}};
function fileSHA(f){return H(RF(f))}
function expectedCheck(id){return ["node",SRC,"check",id]}
// Live CLI results naturally change between developer handoff, QA and
// delivery; do not require the same raw task/status timestamp to replay.
// Validate the ORIGINAL output and CURRENT replay against a fixed contract,
// while pinning the command argv and original developer identity.
function validLiveDrift(id, observed, replay, freeze) {
 const dynamic=new Set(["c03","c05","c09","c10"]);
 if(!dynamic.has(id)||!replay.passed||!observed.passed)return false;
 const a=observed.commands||[],b=replay.commands||[];
 if(a.length!==b.length||!a.length||a.some((x,i)=>JSON.stringify(x.command)!==JSON.stringify(b[i].command)
     ||x.exitCode!==0||x.ok!==true))return false;
 const allowed=new Set(["开发中","修复中","待独测","独测中","待复测","复测中","待交付","交付中","已完成"]);
 try {
  const raw=JSON.parse(a[0].stdout);
  if(id==="c03"||id==="c05"){
   if(raw.id!=="WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1"||!allowed.has(raw.status))return false;
   if(["开发中","修复中","交付中"].includes(raw.status) &&
     raw.sessionId!==freeze.session)return false;
   const scope=String(raw.writeTargets||"").split(";");
   const required=id==="c03"?["AGENTS.md"]:
     ["server/candidate-evaluator.mjs","server/task-scanner.mjs","server/scan-store.mjs","server/adapters/markdown-task-registry-v1.mjs"];
   return required.every(x=>scope.includes(x));
  }
  if(id==="c09")return raw.static?.passed===40&&raw.scenarios?.passed===15&&
    Array.isArray(raw.static?.failures)&&raw.static.failures.length===0&&
    raw.live?.[1]?.id==="WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1"&&
    allowed.has(raw.live[1].status)&&raw.live?.[2]?.status==="HOLD";
  if(id==="c10")return raw.checks===26&&raw.passed===26&&Array.isArray(raw.failed)&&
    raw.failed.length===0&&allowed.has(raw.subStatus)&&raw.parentStatus==="HOLD"&&
    raw.contextImplemented===true;
 }catch{return false}
 return false;
}
function validateRound(dir,n,freeze,errors){
 const file=path.join(dir,"round"+n+".json"),side=file+".sha256";
 if(!fs.existsSync(file)||!fs.existsSync(side)){errors.push("missing round "+n);return null}
 if(R(side).trim()!==fileSHA(file))errors.push("report hash mismatch round "+n);
 let r;try{r=J(file)}catch{errors.push("invalid JSON round "+n);return null}
 const keys=all(n);
 if(r.round!==n||r.pass!==true||r.result!=="PASS"||r.total!==keys.length||r.passed!==keys.length||r.checks?.length!==keys.length||r.failures?.length!==0)errors.push("invalid aggregate round "+n);
 if(r.freezeSHA256!==fileSHA(path.join(dir,"freeze.json"))||JSON.stringify(r.docs)!==JSON.stringify(freeze.docs)||r.scriptSHA256!==freeze.scriptSHA256)errors.push("round frozen mismatch "+n);
 if(r.reviewerActor!==freeze.actor||r.reviewerSession!==freeze.session||
    freeze.actor!==ACTOR||freeze.session!==SESSION||
    !/^wc_sess_[A-Za-z0-9_]+$/.test(String(freeze.session||"")))errors.push("reviewer actor/session not bound to frozen developer identity round "+n);
 const seen=new Set();
 for(const ch of r.checks||[]){
  if(!ch||typeof ch.id!=="string"||seen.has(ch.id)||!keys.includes(ch.id)){errors.push("unexpected check in round "+n);continue}
  seen.add(ch.id);
  if(ch.pass!==true||ch.status!=="PASS"||ch.exitCode!==0||ch.command?.length!==4||ch.command[0]!=="node"||ch.command[1]!==SRC||ch.command[2]!=="check"||ch.command[3]!==ch.id||ch.kind!==(n===1?"static":n===2?"cli":"design_simulation"))errors.push("invalid check result "+ch.id);
  if(!/^[a-f0-9]{64}$/.test(ch.stdoutSHA256||"")||H(Buffer.from(ch.stdout||""))!==ch.stdoutSHA256||!Array.isArray(ch.docCoverage)||JSON.stringify(ch.docCoverage)!==JSON.stringify(freeze.docs))errors.push("missing or altered source evidence "+ch.id);
  let observed;try{observed=JSON.parse(ch.stdout)}catch{errors.push("invalid stdout evidence "+ch.id);continue}
  if(observed.id!==ch.id||observed.passed!==true||observed.kind!==ch.kind)errors.push("stdout disagrees "+ch.id);
  // A self-consistent fake stdout + fake SHA is not evidence. Re-evaluate the
  // known check ID using this frozen script, NEVER execute a command supplied
  // by an untrusted report. Compare the complete independent result, including
  // nested process exit codes and the full multi-step actor/session trace.
  const replay=summary(checkOne(ch.id));
  if(!replay.passed||(JSON.stringify(observed)!==JSON.stringify(replay)&&
      !validLiveDrift(ch.id,observed,replay,freeze)))
   errors.push("replayed command/output/state identity differs "+ch.id);
  if(ch.kind==="static"){
   if(!observed.proof?.length||!observed.proof.every(x=>x.valid&&x.line>0&&fs.existsSync(x.file)&&fileSHA(x.file)===x.sourceSHA256&&R(x.file).split(/\r?\n/)[x.line-1].includes(x.term)))errors.push("invalid static evidence "+ch.id);
  }
  if(ch.kind==="cli"){
   if(ch.id==="c12"){if(observed.proof.length!==DOCS.length||!observed.proof.every(x=>fs.existsSync(x.file)&&fileSHA(x.file)===x.sha256))errors.push("invalid file coverage "+ch.id)}
   else if(!["c06","c07","c12"].includes(ch.id)&&!observed.commands?.length)errors.push("missing real command "+ch.id);
   if(observed.commands?.some(x=>x.exitCode!==0||x.ok!==true||!Array.isArray(x.command)||H(Buffer.from(x.stdout||""))!==x.stdoutSHA256||H(Buffer.from(x.stderr||""))!==x.stderrSHA256))errors.push("bad external command evidence "+ch.id);
  }
  if(ch.kind==="design_simulation"){
   if(!observed.trace?.trace||observed.trace.trace.length<3||observed.trace.trace.some(x=>!x.eventId||!x.op||!x.pre||!x.post||!x.actor||!x.session||x.accepted!==x.expectedAccepted)||observed.trace.passed!==true||observed.trace.sourceDocuments?.length!==DOCS.length)errors.push("missing state transition trace "+ch.id);
  }
 }
 if(seen.size!==keys.length)errors.push("missing check IDs round "+n);
 return r;
}
function verify(dir,fixture){
 const errors=[],f=path.join(dir,"freeze.json");
 if(!fs.existsSync(f)){errors.push("missing freeze");return errors}
 let freeze;try{freeze=J(f)}catch{errors.push("invalid freeze");return errors}
 if(freeze.scriptSHA256!==fileSHA(SRC))errors.push("script hash mismatch");
 if(JSON.stringify(freeze.docs)!==JSON.stringify(SNAP()))errors.push("source SHA changed");
 const rounds=[1,2,3].map(n=>validateRound(dir,n,freeze,errors));
 if(rounds.every(Boolean)){
  const cat=rounds.map(x=>x.checks.map(c=>c.id).join("|"));
  if(new Set(cat).size!==3)errors.push("duplicate round types");
 }
 if(!fixture){
  const n=path.join(dir,"negative-results.json"),s=n+".sha256";
  if(!fs.existsSync(n)||!fs.existsSync(s)||R(s).trim()!==fileSHA(n)){errors.push("missing or altered negative report")}
  else{const a=J(n);if(a.length<6||a.some(x=>!x.rejected||x.exitCode===0||x.exitCode===null))errors.push("negative validator not fail-closed")}
 }
 return errors;
}
function writeReport(n){
 const dir=ROOT,freeze=J(path.join(dir,"freeze.json"));
 const problems=verify(dir,true).filter(e=>!e.startsWith("missing round")&&!e.startsWith("invalid")&&!e.startsWith("missing check IDs"));
 if(freeze.scriptSHA256!==fileSHA(SRC)||JSON.stringify(freeze.docs)!==JSON.stringify(SNAP()))throw Error("freeze/script changed");
 if(n>1){const errors=[];validateRound(dir,n-1,freeze,errors);if(errors.length)throw Error("prior round invalid: "+errors.join("|"))}
 const checks=[];
 for(const id of all(n)){
  const cmd=expectedCheck(id);const r=CMD(cmd[0],cmd.slice(1));
  let parsed;try{parsed=JSON.parse(r.stdout)}catch{}
  const pass=r.status===0&&parsed?.passed===true&&parsed.id===id;
  checks.push({id,kind:n===1?"static":n===2?"cli":"design_simulation",status:pass?"PASS":"FAIL",pass,command:cmd,exitCode:r.status,stdout:r.stdout||"",stderr:(r.stderr||"").slice(0,2500),stdoutSHA256:H(Buffer.from(r.stdout||"")),stderrSHA256:H(Buffer.from(r.stderr||"")),docCoverage:SNAP(),evidence:parsed?{file:parsed.proof?.[0]?.file||null,lines:parsed.proof?.map(x=>x.line).filter(Boolean)||[],commandCount:parsed.commands?.length||0,traceEvents:parsed.trace?.trace?.length||0}:null});
  if(!pass)break;
 }
 const ok=checks.length===all(n).length&&checks.every(x=>x.pass);
 const report={round:n,result:ok?"PASS":"FAIL",pass:ok,total:all(n).length,passed:checks.filter(x=>x.pass).length,failures:checks.filter(x=>!x.pass).map(x=>x.id),docs:freeze.docs,freezeSHA256:fileSHA(path.join(dir,"freeze.json")),scriptSHA256:freeze.scriptSHA256,reportPath:path.join(dir,"round"+n+".json"),reviewerActor:ACTOR,reviewerSession:SESSION,completedAt:NOW(),checks};
 const dest=path.join(dir,"round"+n+".json");fs.writeFileSync(dest,JSON.stringify(report,null,2)+"\n");fs.writeFileSync(dest+".sha256",fileSHA(dest)+"\n");
 OUT({round:n,result:report.result,checks:checks.length,passed:report.passed,report:dest,reportSHA256:fileSHA(dest),errors:report.failures});
 if(!ok)process.exitCode=2;
}
function negatives(){
 const data=[],base=ROOT,ids=["inner_failed","fake_exit","fake_script","missing_round","modified_report","missing_command","missing_trace","changed_doc_sha","fake_cli_output_rehashed","fake_cli_command_rehashed","fake_takeover_identity_rehashed","fake_reviewer_identity","fake_takeover_authorization_rehashed","fake_live_identity_rehashed"];
 for(const id of ids){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),"wtb-review-v2-"));
  try{
   for(const f of ["freeze.json","round1.json","round1.json.sha256","round2.json","round2.json.sha256","round3.json","round3.json.sha256"])fs.copyFileSync(path.join(base,f),path.join(d,f));
   const rw=(f,fn,hashToo=false)=>{const loc=path.join(d,f),x=J(loc);fn(x);fs.writeFileSync(loc,JSON.stringify(x,null,2)+"\n");if(hashToo)fs.writeFileSync(loc+".sha256",fileSHA(loc)+"\n")};
   if(id==="inner_failed")rw("round1.json",a=>{a.checks[2].pass=false;a.checks[2].status="FAIL"},true);
   if(id==="fake_exit")rw("round1.json",a=>{a.checks[2].exitCode=9},true);
   if(id==="fake_script")rw("freeze.json",a=>{a.scriptSHA256="0".repeat(64)});
   if(id==="missing_round")fs.unlinkSync(path.join(d,"round2.json"));
   if(id==="modified_report")rw("round2.json",a=>{a.pass=false});
   if(id==="missing_command")rw("round2.json",a=>{delete a.checks[1].command},true);
   if(id==="missing_trace")rw("round3.json",a=>{let x=JSON.parse(a.checks[0].stdout);x.trace.trace=[];a.checks[0].stdout=JSON.stringify(x);a.checks[0].stdoutSHA256=H(Buffer.from(a.checks[0].stdout))},true);
   if(id==="changed_doc_sha")rw("freeze.json",a=>{a.docs[0].sha256="f".repeat(64)});
   // These cases are self-consistent for all old checks: internal JSON,
   // stdout SHA256 and outer sidecar are all recomputed after the forgery.
   // Only independently replaying a known check and binding the actor/Session
   // to the frozen identity can detect the substituted evidence.
   if(id==="fake_cli_output_rehashed")rw("round2.json",a=>{
     const c=a.checks.find(x=>x.id==="c02"),o=JSON.parse(c.stdout);
     o.commands[0].stdout='{"projects":[{"id":"forged"}]}';
     o.commands[0].stdoutSHA256=H(Buffer.from(o.commands[0].stdout));
     c.stdout=JSON.stringify(o);c.stdoutSHA256=H(Buffer.from(c.stdout));
   },true);
   if(id==="fake_cli_command_rehashed")rw("round2.json",a=>{
     const c=a.checks.find(x=>x.id==="c02"),o=JSON.parse(c.stdout);
     o.commands[0].command=["node","-e","console.log('fake PASS')"];
     c.stdout=JSON.stringify(o);c.stdoutSHA256=H(Buffer.from(c.stdout));
   },true);
   if(id==="fake_takeover_identity_rehashed")rw("round3.json",a=>{
     const c=a.checks.find(x=>x.id==="t05"),o=JSON.parse(c.stdout);
     const takeover=o.trace.trace.find(x=>x.op==="takeover");
     takeover.actor="attacker-with-no-authority";
     takeover.session="session-attacker";
     c.stdout=JSON.stringify(o);c.stdoutSHA256=H(Buffer.from(c.stdout));
   },true);
   if(id==="fake_reviewer_identity")rw("round1.json",a=>{
     a.reviewerActor="attacker-developer";a.reviewerSession="wc_sess_forged";
   },true);
   if(id==="fake_live_identity_rehashed")rw("round2.json",a=>{
     const c=a.checks.find(x=>x.id==="c03"),o=JSON.parse(c.stdout);
     const fake=JSON.parse(o.commands[0].stdout);
     fake.sessionId="wc_sess_attacker";
     o.commands[0].stdout=JSON.stringify(fake);
     o.commands[0].stdoutSHA256=H(Buffer.from(o.commands[0].stdout));
     c.stdout=JSON.stringify(o);c.stdoutSHA256=H(Buffer.from(c.stdout));
   },true);
   if(id==="fake_takeover_authorization_rehashed")rw("round3.json",a=>{
     const c=a.checks.find(x=>x.id==="t04"),o=JSON.parse(c.stdout);
     const takeover=o.trace.trace.find(x=>x.op==="takeover");
     takeover.accepted=true;takeover.expectedAccepted=true;
     takeover.post.owner="attacker-developer";
     c.stdout=JSON.stringify(o);c.stdoutSHA256=H(Buffer.from(c.stdout));
   },true);
   const res=CMD("node",[SRC,"verify-fixture",d]);
   let denial=null;
   try { denial=JSON.parse(res.stdout||""); }catch{}
   const reasonByCase={
    inner_failed:"invalid check result",fake_exit:"invalid check result",
    fake_script:"script hash mismatch",missing_round:"missing round",
    modified_report:"report hash mismatch",missing_command:"invalid check result",
    missing_trace:"missing state transition trace",changed_doc_sha:"source SHA changed",
    fake_cli_output_rehashed:"replayed command/output/state identity differs",
    fake_cli_command_rehashed:"replayed command/output/state identity differs",
    fake_takeover_identity_rehashed:"replayed command/output/state identity differs",
    fake_reviewer_identity:"reviewer actor/session not bound",
    fake_takeover_authorization_rehashed:"replayed command/output/state identity differs",
    fake_live_identity_rehashed:"replayed command/output/state identity differs"
   };
   const errors=Array.isArray(denial?.errors)?denial.errors:[];
   const rejected=res.status===2&&denial?.phase==="verify-fixture"&&denial.pass===false&&
     errors.some(e=>String(e).includes(reasonByCase[id]));
   data.push({test:id,command:["node",SRC,"verify-fixture","<isolated temp copy>"],
     exitCode:res.status,rejected,matchedReason:reasonByCase[id],observedReasons:errors.slice(0,6),
     stdoutSHA256:H(Buffer.from(res.stdout||"")),stderrSHA256:H(Buffer.from(res.stderr||"")),
     stdout:(res.stdout||"").slice(0,650)});
  }finally{fs.rmSync(d,{recursive:true,force:true})}
 }
 const f=path.join(ROOT,"negative-results.json");fs.writeFileSync(f,JSON.stringify(data,null,2)+"\n");fs.writeFileSync(f+".sha256",fileSHA(f)+"\n");
 const pass=data.every(x=>x.rejected);
 OUT({phase:"negative",total:data.length,passed:data.filter(x=>x.rejected).length,allTamperedEvidenceRejected:pass,report:f,sha:fileSHA(f)});
 if(!pass)process.exitCode=2;
}
const mode=process.argv[2];
try{
 if(mode==="check"){const out=summary(checkOne(process.argv[3]));OUT(out);if(!out.passed)process.exitCode=2}
 else if(mode==="freeze"){
  fs.mkdirSync(ROOT,{recursive:true});
  for(const f of fs.readdirSync(ROOT).filter(f=>/^(round[123]\.json(\.sha256)?|negative-results\.json(\.sha256)?|freeze\.json)$/.test(f)))fs.unlinkSync(path.join(ROOT,f));
  const frozen={name:"R2 independent-QA-failure repair: triple document selftest",createdAt:NOW(),docs:SNAP(),scriptPath:SRC,scriptSHA256:fileSHA(SRC),actor:ACTOR,session:SESSION};
  const f=path.join(ROOT,"freeze.json");fs.writeFileSync(f,JSON.stringify(frozen,null,2)+"\n");
  OUT({phase:"freeze",docs:frozen.docs,freezeSHA256:fileSHA(f),scriptSHA256:frozen.scriptSHA256});
 }
 else if(["1","2","3"].includes(mode))writeReport(Number(mode));
 else if(mode==="negative")negatives();
 else if(mode==="verify"||mode==="verify-fixture"){const dir=mode==="verify-fixture"?process.argv[3]:ROOT;const errors=verify(dir,mode==="verify-fixture");OUT({phase:mode,pass:errors.length===0,errors,docs:SNAP().length});if(errors.length)process.exitCode=2}
 else {console.error("Modes: freeze | 1 | 2 | 3 | negative | verify | verify-fixture DIR | check ID");process.exitCode=2}
}catch(e){console.error("FAIL CLOSED: "+(e?.stack||String(e)));process.exitCode=2}
