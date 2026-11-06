import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

test("board state module and local browser project list are available without a bearer token", async (t) => {
  const fixture=await makeFixture();
  await fs.copyFile("web/board-state.mjs", fixture.boardRoot+"/web/board-state.mjs");
  const app=await createTaskboardServer({rootDir:fixture.boardRoot,host:"127.0.0.1",port:0});
  await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(0,"127.0.0.1",resolve)});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>app.server.close(resolve));
    await fs.rm(fixture.boardRoot,{recursive:true,force:true});
  });

  const moduleResponse=await fetch(base+"/board-state.mjs");
  assert.equal(moduleResponse.status,200);
  assert.match(moduleResponse.headers.get("content-type")||"",/text\/javascript/);
  assert.equal(moduleResponse.headers.get("cache-control"),"no-store");
  assert.match(await moduleResponse.text(),/export function tasksForColumn/);

  const denied=await fetch(base+"/api/projects");
  assert.equal(denied.status,200);
});

async function cardRenderer() {
  const source=await fs.readFile("web/app.js","utf8");
  const blocks=[
    source.slice(source.indexOf("const TRACK_LABELS="),source.indexOf(";",source.indexOf("const TRACK_LABELS="))+1),
    source.slice(source.indexOf("const STATUS_LABELS="),source.indexOf(";",source.indexOf("const STATUS_LABELS="))+1),
    source.slice(source.indexOf("function trackLabel("),source.indexOf("\n",source.indexOf("function trackLabel("))),
    source.slice(source.indexOf("function statusLabel("),source.indexOf("\n",source.indexOf("function statusLabel("))),
    source.slice(source.indexOf("function badge("),source.indexOf("\n",source.indexOf("function badge("))),
    source.slice(source.indexOf("function taskDependencies("),source.indexOf("function columnPageKey(")),
    source.slice(source.indexOf("function renderList("),source.indexOf("function renderRequirements("))
  ];
  const makeElement=(tag)=>({tag,children:[],listeners:{},className:"",textContent:"",
    append(...nodes){for(const n of nodes)n.parentElement=this;this.children.push(...nodes)},
    replaceChildren(...nodes){this.children=[];this.append(...nodes)},
    setAttribute(name,value){(this.attributes??={})[name]=value},
    addEventListener(name,callback){this.listeners[name]=callback}
  });
  const context={
    document:{createElement:makeElement},
    state:{projectId:"demo",projectEpoch:1,filtered:[],dependencyTrail:[],snapshot:{tasks:[]}},
    els:{taskTableBody:{rows:[],replaceChildren(...rows){this.rows=rows}},readDependenciesText:makeElement("p"),dependencyTrail:makeElement("nav"),dependencyBackBtn:makeElement("button")},
    taskTitle:t=>t.id,priorityLabel:t=>t,mainPlan:()=>null,planName:()=>"",
    developerCandidateFor:()=>null,isReadyTask:()=>false,roleLabel:()=>"",
    sameProject:(projectId,epoch)=>projectId===context.state.projectId&&epoch===context.state.projectEpoch,
    navCalls:[],openTask:(id,nested)=>{context.navCalls.push({id,nested});return Promise.resolve()},formatTime:()=>"",
  };
  vm.runInNewContext(blocks.join("\n")+"\nthis.renderCard=taskCard;this.renderList=renderList;this.statusText=statusLabel;this.renderDeps=renderTaskDependencies;this.renderTrail=renderDependencyTrail;this.nextTrail=dependencyTrailFor;",context);
  return context;
}

test("R1 bugfix cards show prominent BUG without replacing status and priority", async () => {
  const ctx=await cardRenderer();
  for(const status of ["待准备","待开发","开发中","阻断","测试失败待修复","HOLD"]){
    for(const priority of ["P0","P1"]){
      const card=ctx.renderCard({id:"TASK-"+priority,track:"bugfix",priority,status});
      const badges=card.children.find(x=>x.className==="badges").children;
      assert.match(card.className,/\bbug-card\b/);
      assert.equal(badges[0].textContent,"BUG");
      assert.match(badges[0].className,/\bbugfix\b/);
      assert.equal(badges[1].textContent,priority);
      assert.equal(badges[2].textContent,ctx.statusText(status));
    }
  }
  const css=await fs.readFile("web/styles.css","utf8");
  assert.match(css,/\.task-card\.bug-card\{border-left:4px solid #d92d20/);
  assert.match(css,/\.badge\.bugfix\{background:#b42318;color:#fff/);
});

test("R2 only track=bugfix is flagged, including in table categories", async () => {
  const ctx=await cardRenderer();
  const tasks=[
    {id:"BUG-LOOKALIKE",track:"product",priority:"P0",status:"待开发"},
    {id:"INFRA",track:"infrastructure",priority:"P1",status:"阻断"},
    {id:"OTHER",track:"other",priority:"P1",status:"待准备"},
    {id:"REAL",track:"bugfix",priority:"P0",status:"测试失败待修复"}
  ];
  for(const task of tasks){
    const card=ctx.renderCard(task);
    const badge=card.children.find(x=>x.className==="badges").children[0];
    assert.equal(card.className.includes("bug-card"),task.track==="bugfix");
    assert.equal(badge.className.includes("bugfix"),task.track==="bugfix");
  }
  ctx.state.filtered=tasks;
  ctx.renderList();
  assert.deepEqual(Array.from(ctx.els.taskTableBody.rows,x=>x.children[2].textContent),
    ["产品业务","基础设施","其它类别","BUG"]);
  assert.equal(ctx.els.taskTableBody.rows.length,tasks.length);
});

test("R1 multiple registered predecessors show on both card and detail, with direct click",async()=>{
  const ctx=await cardRenderer();
  const ids=["WTB-A-20261106-T1","WTB-B-20261106-T1","WTB-C-20261106-T1","WTB-D-20261106-T1","WTB-E-20261106-T1"];
  const tasks=ids.map((id,index)=>({id,status:index===4?"已完成":"待开发",track:"product",priority:"P1"}));
  tasks[0].readDependencies=ids[1]+"完成；"+ids[4]+"完成;docs/archive.md";
  tasks[1].readDependencies=ids[2]+"完成";
  tasks[2].readDependencies=ids[3]+"完成";
  ctx.state.snapshot={tasks};
  const card=ctx.renderCard(tasks[0]);
  const pending=card.children.find(item=>item.className==="dependency-card-row");
  assert.equal(pending.children[0].textContent,"前置 1 项");
  const link=pending.children[1];
  assert.equal(link.textContent,ids[1]);
  let stopped=false;link.listeners.click({stopPropagation(){stopped=true}});
  assert.equal(stopped,true);
  assert.deepEqual(ctx.navCalls,[{id:ids[1],nested:true}]);
  assert.equal(ctx.state.dependencyTrail.join("|"),ids[0],"card entry must retain its parent as breadcrumb root");
  ctx.renderDeps(tasks[0]);
  const detail=ctx.els.readDependenciesText.children;
  assert.equal(detail.length,3,"one link for each predecessor and one plain path");
  assert.equal(detail[0].children[0].textContent,ids[1]);
  assert.equal(detail[1].children[0].textContent,ids[4],"completed registered predecessor remains clickable");
  assert.equal(detail[2].textContent,"docs/archive.md");
  detail[1].children[0].listeners.click({stopPropagation(){}});
  assert.equal(ctx.navCalls.at(-1).nested,true);
});

test("R1 A→B→C→D breadcrumbs allow ancestors, backward navigation and branching",async()=>{
  const ctx=await cardRenderer();
  const A="WTB-A-20261106-T1",B="WTB-B-20261106-T1",C="WTB-C-20261106-T1",D="WTB-D-20261106-T1",E="WTB-E-20261106-T1";
  let path=ctx.nextTrail([],A,false);
  for(const id of [B,C,D])path=ctx.nextTrail(path,id,true);
  assert.deepEqual([...path],[A,B,C,D]);
  ctx.state.dependencyTrail=path;
  ctx.renderTrail();
  assert.equal(ctx.els.dependencyBackBtn.hidden,false);
  assert.deepEqual(ctx.els.dependencyTrail.children.map(x=>x.textContent),[...path]);
  ctx.els.dependencyTrail.children[1].listeners.click();
  assert.deepEqual(ctx.navCalls.at(-1),{id:B,nested:true});
  path=ctx.nextTrail(path,B,true);
  assert.deepEqual([...path],[A,B]);
  path=ctx.nextTrail(path,E,true);
  assert.deepEqual([...path],[A,B,E],"branch from B should drop old C/D");
});

test("R2 invalid references, self-loops and stale project do not navigate",async()=>{
  const ctx=await cardRenderer();
  const A="WTB-A-20261106-T1",B="WTB-B-20261106-T1";
  const task={id:A,status:"待开发",track:"product",priority:"P1",
    readDependencies:A+"完成;"+B+"完成;server/task-store.mjs;do-not-eval-<script>"};
  ctx.state.snapshot={tasks:[task]};
  ctx.renderDeps(task);
  const rows=ctx.els.readDependenciesText.children;
  assert.equal(rows.length,4);
  assert.equal(rows[0].textContent,A+"完成","self-reference is noninteractive");
  assert.match(rows[1].textContent,/未登记\/不可跳转/);
  assert.equal(rows[2].textContent,"server/task-store.mjs");
  assert.equal(rows[3].textContent,"do-not-eval-<script>");
  assert.equal(ctx.navCalls.length,0);
  const Btask={id:B,status:"待开发",track:"product",priority:"P1",readDependencies:A+"完成"};
  ctx.state.snapshot={tasks:[task,Btask]};
  const link=ctx.renderCard(Btask).children.find(n=>n.className==="dependency-card-row").children[1];
  ctx.state.projectEpoch++;
  link.listeners.click({stopPropagation(){}});
  assert.equal(ctx.navCalls.length,0,"stale button after project epoch change cannot navigate");
  assert.deepEqual([...ctx.nextTrail([A,B],A,true)],[A],"cycle goes back to existing breadcrumb");
  assert.deepEqual([...ctx.nextTrail([A,B],B,true)],[A,B],"same task never piles duplicate path");
});

test("R3 mobile breadcrumb and close cleanup contract are visible",async()=>{
  const html=await fs.readFile("web/index.html","utf8");
  const css=await fs.readFile("web/styles.css","utf8");
  const app=await fs.readFile("web/app.js","utf8");
  assert.match(html,/id="dependencyBackBtn"/);
  assert.match(html,/id="dependencyTrail"[^>]*aria-label="任务访问路径"/);
  assert.match(css,/\.dependency-trail\{[^}]*overflow-x:auto/);
  assert.match(css,/\.dependency-link[^}]*min-height:40px/);
  assert.match(app,/els\.taskDialog\.addEventListener\("close",[\s\S]*?state\.dependencyTrail=\[\]/);
  assert.match(app,/if\(!els\.taskDialog\.open\)els\.taskDialog\.showModal\(\)/);
});

test("R2 actual async openTask supports four-level drilldown, back, branches, close and stale requests",async()=>{
  const source=await fs.readFile("web/app.js","utf8");
  const helpers=source.slice(source.indexOf("function taskDependencies("),source.indexOf("function taskCard("));
  const opener=source.slice(source.indexOf("async function openTask("),source.indexOf("async function loadHistory("));
  const listeners=source.slice(source.indexOf('els.closeDialogBtn.addEventListener("click"'),source.indexOf('els.reloadHistoryBtn.addEventListener("click"'));
  const node=tag=>({tag,children:[],listeners:{},textContent:"",hidden:false,open:false,
    append(...children){this.children.push(...children)},
    replaceChildren(...children){this.children=[...children]},
    setAttribute(){},
    addEventListener(type,handler){this.listeners[type]=handler},
    showModal(){this.open=true},
    close(){this.open=false;this.listeners.close?.()}
  });
  const ids=["WTB-A-20261106-T1","WTB-B-20261106-T1","WTB-C-20261106-T1","WTB-D-20261106-T1","WTB-E-20261106-T1"];
  const tasks=ids.map((id,index)=>({id,status:index===3?"已完成":"待开发",
    priority:"P1",track:"product",plannedRole:"开发AI",readDependencies:index===0?ids[1]+"完成；"+ids[4]+"完成":index<3?ids[index+1]+"完成":""}));
  const state={projectId:"demo",projectEpoch:1,detailEpoch:0,dependencyTrail:[],selectedTask:null,selectedTaskProjectId:null,
    snapshot:{tasks},filtered:[tasks[0]],userMessages:[],userMessagePage:1};
  const keys=["dependencyBackBtn","dependencyTrail","closeDialogBtn","taskDialog","detailTaskId","detailTitle","taskPlanList",
    "responsibilityText","currentProgressText","userAssistanceText","traceabilityText","readDependenciesText",
    "writeTargetsText","relatedArtifactsText","userAcceptanceActions","detailMeta","sessionInfo","prioritySelect",
    "reviewNote","resumeBtn","allowTakeoverBtn","revokeTakeoverBtn"];
  const els=Object.fromEntries(keys.map(k=>[k,node(k)]));
  const ctx={state,els,document:{createElement:node},api:async url=>{
    const id=decodeURIComponent(url.split("/tasks/")[1]);
    const result=tasks.find(x=>x.id===id);if(!result)throw Error("missing task");
    return result;
  },sameProject:(projectId,epoch)=>state.projectId===projectId&&state.projectEpoch===epoch,
  taskTitle:t=>t.id,statusLabel:v=>v,priorityLabel:v=>v,trackLabel:v=>v,roleLabel:v=>v,formatTime:()=>"",
  planButton:()=>node("button"),documentButton:()=>node("button"),
  renderTestResources:()=>{},renderUserMessages:()=>{},loadHistory:async()=>{},toast:()=>{}};
  vm.runInNewContext(helpers+"\n"+opener+"\n"+listeners+"\nthis.navigate=openTask;",ctx);
  for(const [index,id] of ids.slice(0,4).entries())await ctx.navigate(id,index>0);
  assert.equal(state.selectedTask.id,ids[3],"registered predecessor opens even when filtered out");
  assert.equal(state.dependencyTrail.join("|"),ids.slice(0,4).join("|"));
  assert.equal(els.dependencyBackBtn.hidden,false);
  els.dependencyBackBtn.listeners.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.selectedTask.id,ids[2]);
  assert.equal(state.dependencyTrail.join("|"),ids.slice(0,3).join("|"));
  els.dependencyTrail.children[0].listeners.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(state.dependencyTrail.join("|"),ids[0]);
  await ctx.navigate(ids[4],true);
  assert.equal(state.dependencyTrail.join("|"),ids[0]+"|"+ids[4],"branch switched after ancestor click");
  els.taskDialog.close();
  assert.equal(state.dependencyTrail.length,0,"close clears the whole path");
  await ctx.navigate(ids[1]);
  assert.equal(state.dependencyTrail.join("|"),ids[1],"fresh open starts new root after dialog close");
  let resolveLater;
  ctx.api=async()=>new Promise(resolve=>{resolveLater=resolve});
  const inflight=ctx.navigate(ids[2],true);
  state.projectEpoch++;
  resolveLater(tasks[2]);await inflight;
  assert.equal(state.dependencyTrail.join("|"),ids[1],"a previous-project reply cannot pollute the navigation path");
});


test("R1 mutually exclusive ready-column counters count each task exactly once", async () => {
  const source=await fs.readFile("web/app.js","utf8");
  const begin=source.indexOf("function renderBoard(){");
  const end=source.indexOf("function renderList(){",begin);
  assert.ok(begin>=0&&end>begin);
  const element=(tag)=>({tag,className:"",textContent:"",children:[],
    classList:{add(){}},
    append(...nodes){this.children.push(...nodes)},
    replaceChildren(...nodes){this.children=nodes}
  });
  const tasks=[
    {id:"DEV-1",track:"product",dev:true},
    {id:"DEV-2",track:"infrastructure",dev:true},
    {id:"BUG-1",track:"bugfix",dev:true},
    {id:"BUG-2",track:"bugfix",dev:true},
    {id:"BUG-3",track:"bugfix",dev:true},
    {id:"QA-1",track:"product",dev:false},
    {id:"QA-BUG-1",track:"bugfix",dev:false},
    {id:"QA-BUG-2",track:"bugfix",dev:false}
  ];
  const board=element("main");
  const ctx={
    document:{createElement:element},
    state:{workflow:{boardColumns:[{id:"qa_pending",title:"待执行",statuses:["待独测","待复测"]}]},
      filtered:tasks,columnPages:{}},
    els:{boardView:board},
    boardTasksForColumn:()=>ctx.state.filtered,
    paginateColumn:(items)=>({page:1,totalPages:1,visible:items}),
    PAGE_SIZE:10,
    isReadyTask:(item)=>item.dev,
    taskCard:()=>element("article")
  };
  vm.runInNewContext(source.slice(begin,end)+"\nthis.renderReadyBoard=renderBoard;",ctx);
  const check=(items,expected)=>{
    ctx.state.filtered=items;
    ctx.renderReadyBoard();
    const column=board.children[0],head=column.children[0];
    assert.equal(head.children[1].textContent,expected);
    const values=[...head.children[1].textContent.matchAll(/(\d+) 项/g)].map(x=>Number(x[1]));
    assert.equal(values.reduce((sum,value)=>sum+value,0),items.length);
  };
  check(tasks,"开发 2 项 · 测试 3 项 · BUG 3 项");
  check(tasks.filter(x=>x.id.startsWith("QA-BUG")||x.id==="BUG-1"),"开发 0 项 · 测试 2 项 · BUG 1 项");
  check([tasks[0]],"开发 1 项 · 测试 0 项 · BUG 0 项");
});
