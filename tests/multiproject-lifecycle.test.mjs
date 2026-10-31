import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

let serial=0;
async function setup(t){
 const fixture=await makeFixture(),root=fixture.boardRoot;
 const baseProject=fixture.projectRoot;
 const configFile=path.join(root,"config","projects.json"),config=JSON.parse(await fs.readFile(configFile,"utf8"));
 const template=config.projects[0],projects=[];
 for(const id of ["A","B","C"]){
  const dir=id==="A"?baseProject:path.join(root,"managed-"+id);
  if(id!=="A")await fs.cp(baseProject,dir,{recursive:true});
  const row=["COMMON-TASK","F-COMMON","infrastructure","P0","待开发","开发AI","—","—","—","2026-10-08T00:00:00Z","正常多项目开发工作流","任务看板与AI协作控制开发计划.md","cp/B-10.md"];
  await fs.writeFile(path.join(dir,"tasks.md"),registryText([row]));
  projects.push({...template,id,name:"Fixture "+id,root:dir,gitAvailable:id==="A"});
 }
 await fs.writeFile(configFile,JSON.stringify({...config,projects},null,2));
 const app=await createTaskboardServer({rootDir:root,host:"127.0.0.1",port:0});
 await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await fs.rm(root,{recursive:true,force:true});});
 const base="http://127.0.0.1:"+app.server.address().port;
 const secret=JSON.parse(await fs.readFile(path.join(root,"config","admin-secret.json"),"utf8")).adminSecret;
 const headers={Authorization:"Bearer "+secret,"Content-Type":"application/json"};
 const get=async(id,task="COMMON-TASK")=>{const res=await fetch(base+"/api/projects/"+id+"/tasks/"+task,{headers});assert.equal(res.status,200);return res.json();};
 const post=async(id,suffix,body={})=>{
   const url=base+"/api/projects/"+id+"/tasks/COMMON-TASK"+suffix;
   const res=await fetch(url,{method:"POST",headers,body:JSON.stringify({operationId:"multi.project."+ (++serial),...body})});
   const data=await res.json();assert.equal(res.status,200,url+" "+JSON.stringify(data.error||data));return data;
 };
 const claim=async(id,actorType,actorId,sessionId)=>{
   const before=await get(id);
   await post(id,"/preclaim-report",{actorType,actorId,sessionId,note:"模拟用户可见汇报项目"+id+"任务和角色、范围"});
   return post(id,"/claim",{expectedRevision:before.registryRevision,actorType,actorId,sessionId,assignee:actorId,sessionWindowName:"独立项目"+id+"窗口"});
 };
 const complete=async(id,actorId,sessionId)=>{
   const before=await get(id);
   return post(id,"/complete-execution",{expectedRevision:before.registryRevision,actorType:"developer_ai",actorId,sessionId});
 };
 const outcome=async(id,actorId,sessionId,result)=>{
   const before=await get(id);
   return post(id,"/test-result",{expectedRevision:before.registryRevision,actorType:"test_ai",actorId,sessionId,testResult:result,reportPath:"reports/B-10/report.md",deliveryDisposition:result==="pass"?"required":undefined,deliveryActions:result==="pass"?["deploy_switch"]:[]});
 };
 return {root,projects,app,base,headers,get,post,claim,complete,outcome};
}
test("three managed projects share the same workflow without cross-task state or history",async t=>{
 const x=await setup(t);
 const a=await x.claim("A","developer_ai","dev-A","sess-A-dev");
 assert.equal(a.after.status,"开发中");
 assert.equal(a.after.sessionId,"sess-A-dev");
 const b=await x.claim("B","developer_ai","dev-B","sess-B-dev");
 assert.equal(b.after.status,"开发中");
 assert.equal((await x.get("C")).status,"待开发");
 assert.equal((await x.get("B")).assignee,"dev-B");
 await x.post("A","/events",{eventType:"test_result",actorType:"developer_ai",actorId:"dev-A",sessionId:"sess-A-dev",metadata:{testResult:"pass",reportPath:"reports/B-10/report.md"}});
 await x.complete("A","dev-A","sess-A-dev");
 assert.equal((await x.get("A")).status,"待独测");
 assert.equal((await x.get("B")).status,"开发中");
 await x.claim("A","test_ai","tester-A","sess-A-test");
 const fail=await x.outcome("A","tester-A","sess-A-test","fail");
 assert.equal(fail.after.status,"测试失败待修复");
 assert.equal((await x.get("B")).status,"开发中");
 await x.claim("A","developer_ai","dev-A","sess-A-fix");
 await x.post("A","/events",{eventType:"test_result",actorType:"developer_ai",actorId:"dev-A",sessionId:"sess-A-fix",metadata:{testResult:"pass",reportPath:"reports/B-10/report.md"}});
 await x.complete("A","dev-A","sess-A-fix");
 assert.equal((await x.get("A")).status,"待复测");
 await x.claim("A","test_ai","tester-A","sess-A-retest");
 const pass=await x.outcome("A","tester-A","sess-A-retest","pass");
 assert.equal(pass.after.status,"待交付");
 assert.equal(pass.after.plannedRole,"开发AI");
 assert.equal((await x.get("B")).status,"开发中");
 assert.equal((await x.get("C")).status,"待开发");
 const history=async id=>{
  const r=await fetch(x.base+"/api/projects/"+id+"/tasks/COMMON-TASK/history?limit=100",{headers:x.headers});
  assert.equal(r.status,200);return (await r.json()).events;
 };
 const ah=await history("A"),bh=await history("B"),ch=await history("C");
 assert.ok(ah.some(e=>e.event_type==="test_result"&&e.metadata?.testResult==="fail"));
 assert.ok(ah.some(e=>e.event_type==="test_result"&&e.metadata?.testResult==="pass"));
 assert.equal(bh.some(e=>e.actor_id==="dev-A"||e.actor_id==="tester-A"),false);
 assert.equal(ch.length,0);
 const saved=new TaskStore(x.root);await saved.init();
 assert.equal((await saved.getTask("A","COMMON-TASK")).task.status,"待交付");
 assert.equal((await saved.getTask("B","COMMON-TASK")).task.sessionId,"sess-B-dev");
 assert.equal((await saved.getTask("C","COMMON-TASK")).task.status,"待开发");
});
test("same task ID across projects never creates global occupancy or duplicate claim in another project",async t=>{
 const x=await setup(t);
 await x.claim("A","developer_ai","dev-A","sess-A-dev");
 const dup=await fetch(x.base+"/api/projects/A/tasks/COMMON-TASK/claim",{method:"POST",headers:x.headers,body:JSON.stringify({operationId:"multiproject.duplicate."+ ++serial,expectedRevision:(await x.get("A")).registryRevision,actorType:"developer_ai",actorId:"dev-X",sessionId:"sess-other",assignee:"dev-X",sessionWindowName:"collision"})});
 assert.equal(dup.status,409);
 assert.equal((await dup.json()).error.code,"TASK_ALREADY_OCCUPIED");
 const c=await x.claim("C","developer_ai","dev-C","sess-C-dev");
 assert.equal(c.after.status,"开发中");
 assert.equal((await x.get("C")).task?.id,undefined);
 assert.equal((await x.get("A")).assignee,"dev-A");
 const p=await fetch(x.base+"/api/projects",{headers:x.headers}),data=await p.json();
 assert.equal(p.status,200);assert.deepEqual(new Set(data.projects.map(v=>v.id)),new Set(["A","B","C"]));
});
test("creating a task in project C remains isolated from A and B regardless of Git metadata",async t=>{
 const x=await setup(t);
 const before=await fetch(x.base+"/api/projects/C/tasks",{headers:x.headers}),snapshot=await before.json();
 assert.equal(before.status,200);
 const task={id:"C-NEW-TASK",parent:"F-COMMON",track:"infrastructure",priority:"P0",
   status:"待开发",plannedRole:"开发AI",boundary:"多项目任务创建夹具",
   plan:"任务看板与AI协作控制开发计划.md",traceability:"cp/B-10.md",
   readDependencies:"AGENTS.md",writeTargets:"测试隔离目录",targets:"独立项目C"};
  const response=await fetch(x.base+"/api/projects/C/tasks",{method:"POST",headers:{Origin:x.base,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"multiproject.create."+ ++serial,expectedRevision:snapshot.registryRevision,
      actorId:"fixture-owner",task})}); const created=await response.json();
 assert.equal(response.status,201,JSON.stringify(created));
 assert.equal(created.task.id,"C-NEW-TASK");
 assert.equal((await x.get("C","C-NEW-TASK")).status,"待开发");
 for(const id of ["A","B"]){
  const r=await fetch(x.base+"/api/projects/"+id+"/tasks/C-NEW-TASK",{headers:x.headers});
  assert.equal(r.status,404,"created task must not appear in "+id);
 }
});
