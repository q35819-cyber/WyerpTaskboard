import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function makeElement(id=""){
  const listeners={};
  const element={id,children:[],options:[],dataset:{},style:{setProperty(){}},classList:{add(){},remove(){},toggle(){}},
    value:"",textContent:"",hidden:false,open:false,disabled:false,
    addEventListener(type,fn){(listeners[type]??=[]).push(fn)},
    async fire(type){for(const fn of listeners[type]||[])await fn({preventDefault(){},stopPropagation(){}})},
    replaceChildren(...nodes){this.children=nodes;this.options=nodes.filter(x=>x?.value!==undefined)},
    append(...nodes){this.children.push(...nodes);if(id==="projectSelect"||id.endsWith("Filter"))this.options=this.children},
    showModal(){this.open=true},close(){this.open=false},
    querySelector(){return null},querySelectorAll(){return []},
    reset(){this.value=""},focus(){},scrollIntoView(){},
    setAttribute(){},removeAttribute(){}};
  return element;
}
async function runtime(fetchImpl){
 const source=(await fs.readFile(path.resolve("web/app.js"),"utf8"))
   .replace(/^import .*;\s*$/gm,"")
   .replace(/\(async\(\)=>\{await loadAppVersion\(\);[\s\S]*?\}\)\(\);\s*setInterval\([\s\S]*?\);\s*$/,"");
 const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,makeElement(id));return elements.get(id)};
 get("archiveFilter").value="all";
 const storage=new Map();
 const context={console,Date,URL,Promise,Map,Set,Number,String,Boolean,Object,Array,Math,JSON,
   fetch:fetchImpl,setTimeout:()=>0,clearTimeout(){},setInterval(){},requestAnimationFrame:fn=>fn(),
   crypto:{randomUUID:()=>("id-"+Math.random())},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   window:{confirm:()=>true},document:{hidden:false,getElementById:get,createElement:tag=>makeElement(tag)},
   buildPlanIndex:()=>({foundTask:false,entries:[],lines:[],targetLine:null}),
   tasksForColumn:(tasks,statuses)=>(tasks||[]).filter(t=>statuses.includes(t.status)),
   paginateColumn:(tasks,page,size)=>({page:1,totalPages:1,visible:tasks.slice(0,size)}),
   resolveProjectId:(projects,current,saved)=>[current,saved,projects[0]?.id].find(id=>projects.some(p=>p.id===id))||null};
 vm.runInNewContext(source+"\n;globalThis.__test={state,els,loadProject,loadProjects,switchProject,openTask,loadHistory,openPlan,mutateTask,refreshAll,taskCard,planButton}",context,{filename:"app.js"});
 return {api:context.__test,get,storage};
}
function mockResponse(data){return {ok:true,json:async()=>data};}
function projectInfo(ids){return ids.map(id=>({id,name:id,health:{ok:true,status:"healthy"}}));}
test("A→B→C→A keeps newest project despite old A response arriving last",async()=>{
 const oldA=deferred(),started=deferred(),seen=[];let aLoads=0;
 const r=await runtime(async(url)=>{
  seen.push(url);
  if(url==="/api/task-scan/status")return mockResponse({scheduler:{},scan:{}});
  const m=url.match(/^\/api\/projects\/([^/]+)\/(workflow|tasks|requirements)$/);
  if(!m)throw Error("unexpected "+url);
  const [,id,type]=m;
  if(id==="A"&&type==="workflow"&&++aLoads===1){started.resolve();return oldA.promise;}
  return mockResponse(type==="workflow"?{id:"workflow-"+id,columns:[],tracks:[],priorities:[],statuses:[]}
    :type==="tasks"?{tasks:[{id:id+"-TASK",status:"待开发",priority:"P0",track:"infrastructure"}]}
    :{items:[{id:id+"-REQ",status:"待AI拆解"}]});
 });
 r.api.state.projects=projectInfo(["A","B","C"]);
 r.api.switchProject("A");
 const aFirst=r.api.loadProject();await started.promise;
 r.api.switchProject("B");assert.equal(await r.api.loadProject(),true);
 assert.equal(r.api.state.snapshot.tasks[0].id,"B-TASK");
 r.api.switchProject("C");assert.equal(await r.api.loadProject(),true);
 assert.equal(r.api.state.snapshot.tasks[0].id,"C-TASK");
 r.api.switchProject("A");assert.equal(await r.api.loadProject(),true);
 oldA.resolve(mockResponse({id:"stale-A",columns:[],tracks:[],priorities:[],statuses:[]}));
 assert.equal(await aFirst,false);
 assert.equal(r.api.state.projectId,"A");
 assert.equal(r.api.state.workflow.id,"workflow-A");
 assert.equal(r.api.state.snapshot.tasks[0].id,"A-TASK");
 assert.equal(r.api.state.requirements[0].id,"A-REQ");
 assert.equal(r.storage.get("wyerp-taskboard:selected-project"),"A");
 assert.equal(r.api.state.selectedTask,null);
 assert.ok(seen.some(x=>x.includes("/B/tasks"))&&seen.some(x=>x.includes("/C/tasks")));
});
test("stale task detail cannot reopen dialog or overwrite the task selected in another project",async()=>{
 const old=deferred(),started=deferred();
 const r=await runtime(async(url)=>{
  if(url==="/api/projects/A/tasks/SHARED"){started.resolve();return old.promise;}
  if(url==="/api/projects/B/tasks/SHARED")return mockResponse({id:"SHARED",parent:"B-DETAIL",status:"待开发",priority:"P1",track:"infrastructure",presentation:{plans:[],documents:[]}});
  if(url.endsWith("/history?limit=120"))return mockResponse({events:[]});
  throw Error(url);
 });
 r.api.state.projects=projectInfo(["A","B"]);
 r.api.switchProject("A");r.api.state.snapshot={tasks:[{id:"SHARED"}]};
 const delayed=r.api.openTask("SHARED");await started.promise;
 r.api.switchProject("B");r.api.state.snapshot={tasks:[{id:"SHARED"}]};
 await r.api.openTask("SHARED");
 assert.equal(r.api.state.selectedTaskProjectId,"B");assert.equal(r.get("detailTitle").textContent,"B-DETAIL");
 assert.equal(r.get("taskDialog").open,true);
 old.resolve(mockResponse({id:"SHARED",parent:"A-DETAIL"}));await delayed;
 assert.equal(r.api.state.selectedTaskProjectId,"B");
 assert.equal(r.get("detailTitle").textContent,"B-DETAIL");
});
test("old selected task and plan cannot trigger project-crossing mutations",async()=>{
 const delayed=deferred(),started=deferred(),requests=[];
 const r=await runtime(async(url,opts={})=>{
  requests.push({url,method:opts.method||"GET"});
  if(url==="/api/projects/A/tasks/A-TASK/plans/0"){started.resolve();return delayed.promise;}
  if(url==="/api/projects/B/tasks/B-TASK/history?limit=120")return mockResponse({events:[]});
  if(url==="/api/projects/B/tasks/B-TASK")return mockResponse({id:"B-TASK",parent:"B",status:"待开发",priority:"P1",track:"infrastructure",presentation:{plans:[],documents:[]}});
  throw Error(url);
 });
 r.api.state.projects=projectInfo(["A","B"]);
 r.api.switchProject("A");r.api.state.snapshot={tasks:[{id:"A-TASK"}]};
 const pending=r.api.openPlan("A-TASK",0);await started.promise;
 r.api.switchProject("B");r.api.state.snapshot={tasks:[{id:"B-TASK"}]};
 delayed.resolve(mockResponse({name:"A OLD PLAN",path:"a.md",content:"# stale"}));
 await pending;assert.equal(r.get("planDialog").open,false);
 await r.api.mutateTask("/stop",{operationId:"stale"},"");assert.equal(requests.filter(x=>x.method==="POST").length,0);
 await r.api.openTask("B-TASK");assert.equal(r.api.state.selectedTaskProjectId,"B");
 assert.equal(r.get("taskDialog").open,true);
});
test("old project-list response cannot reset a newer project selection",async()=>{
 const pending=deferred(),started=deferred();
 const r=await runtime(async(url)=>{
  if(url==="/api/projects"){started.resolve();return pending.promise;}
  throw Error("unexpected "+url);
 });
 r.api.state.projects=projectInfo(["A","B","C"]);
 r.api.switchProject("A");const old=r.api.loadProjects();await started.promise;
 r.api.switchProject("B");pending.resolve(mockResponse({projects:projectInfo(["A"])}));
 assert.equal(await old,false);
 assert.equal(r.api.state.projectId,"B");
 assert.equal(r.api.state.projects.length,3);
 assert.equal(r.storage.get("wyerp-taskboard:selected-project"),"B");
});
test("stale card click cannot open same task ID in the newly selected project",async()=>{
 const calls=[];
 const r=await runtime(async(url)=>{
   calls.push(url);
   if(url==="/api/projects/B/tasks/SHARED")return mockResponse({id:"SHARED",parent:"from B",status:"待开发",priority:"P1",track:"infrastructure",presentation:{plans:[],documents:[]}});
   if(url==="/api/projects/B/tasks/SHARED/history?limit=120")return mockResponse({events:[]});
   throw Error("unexpected "+url);
 });
 r.api.state.projects=projectInfo(["A","B"]);
 r.api.switchProject("A");r.api.state.snapshot={tasks:[{id:"SHARED",parent:"from A",status:"待开发",priority:"P1",track:"infrastructure"}]};
 const oldCard=r.api.taskCard(r.api.state.snapshot.tasks[0]);
 r.api.switchProject("B");r.api.state.snapshot={tasks:[{id:"SHARED",parent:"from B",status:"待开发",priority:"P1",track:"infrastructure"}]};
 await oldCard.fire("click");assert.equal(calls.length,0);
 assert.equal(r.api.state.selectedTask,null);
 const activeCard=r.api.taskCard(r.api.state.snapshot.tasks[0]);await activeCard.fire("click");await new Promise(resolve=>setImmediate(resolve));
 assert.ok(calls.some(u=>u==="/api/projects/B/tasks/SHARED"));
 assert.equal(r.api.state.selectedTaskProjectId,"B");
});
test("project switch clears old task dialog fields, requirement draft and derived filters",async()=>{
 const r=await runtime(async()=>{throw Error("unexpected fetch")});
 r.api.state.projects=projectInfo(["A","B"]);
 r.api.switchProject("A");
 r.get("reviewNote").value="A user-only review";
 r.get("rejectReason").value="A confidential reason";
 r.get("requirementText").value="A project requirement draft";
 r.get("searchInput").value="A task";
 r.get("statusFilter").value="开发中";
 r.get("taskDialog").showModal();
 r.get("planDialog").showModal();
 r.api.state.selectedTask={id:"COMMON-TASK"};
 r.api.state.selectedTaskProjectId="A";
 r.api.state.userMessages=[{note:"A-private-message"}];
 r.api.switchProject("B");
 assert.equal(r.api.state.selectedTask,null);
 assert.equal(r.api.state.userMessages.length,0);
 assert.equal(r.get("taskDialog").open,false);
 assert.equal(r.get("planDialog").open,false);
 assert.equal(r.get("reviewNote").value,"");
 assert.equal(r.get("rejectReason").value,"");
 assert.equal(r.get("requirementText").value,"");
 assert.equal(r.get("searchInput").value,"");
 assert.equal(r.get("statusFilter").value,"");
});
