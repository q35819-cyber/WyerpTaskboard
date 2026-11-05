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
    source.slice(source.indexOf("async function copyTaskId("),source.indexOf("function taskCard(")),
    source.slice(source.indexOf("function taskCard("),source.indexOf("function columnPageKey(")),
    source.slice(source.indexOf("function renderList("),source.indexOf("function renderRequirements("))
  ];
  const makeElement=(tag)=>({tag,children:[],listeners:{},className:"",textContent:"",
    append(...nodes){for(const node of nodes)node.parentElement=this;this.children.push(...nodes)},
    addEventListener(name,callback){this.listeners[name]=callback},
    querySelector(selector){return this.children.find(node=>selector==="."+node.className)||null},
    focus(){this.focused=true},select(){this.selected=true}
  });
  const context={
    document:{createElement:makeElement},
    state:{projectId:"demo",projectEpoch:1,filtered:[]},
    els:{taskTableBody:{rows:[],replaceChildren(...rows){this.rows=rows}}},
    taskTitle:t=>t.id,priorityLabel:t=>t,mainPlan:()=>null,planName:()=>"",
    developerCandidateFor:()=>null,isReadyTask:()=>false,roleLabel:()=>"",
    sameProject:()=>true,openTask:()=>{context.openCount++},formatTime:()=>"",
    navigator:{clipboard:{writeText:async value=>{context.copied.push(value)}}},
    toast:(message,error=false)=>{context.toasts.push({message,error})},copied:[],toasts:[],openCount:0,
  };
  vm.runInNewContext(blocks.join("\n")+"\nthis.renderCard=taskCard;this.renderList=renderList;this.statusText=statusLabel;this.copyId=copyTaskId;",context);
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

test("R1 task card copy sends exact ID and prevents navigation",async()=>{
  const ctx=await cardRenderer();
  const id="WTB-P1-BOARD-TASK-ID-QUICK-COPY-20261106-T1";
  const card=ctx.renderCard({id,track:"product",priority:"P1",status:"待开发"});
  const row=card.children.find(n=>n.className==="task-id-row");
  const button=row.children[1];
  assert.equal(button.ariaLabel,"复制任务编号："+id);
  assert.equal(button.type,"button");
  let stopped=0;button.listeners.click({stopPropagation(){stopped++}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stopped,1);assert.equal(ctx.openCount,0);
  assert.deepEqual(ctx.copied,[id]);
  assert.equal(ctx.toasts.at(-1).message,"任务编号已复制");
});

test("R2 denied clipboard offers selectable exact ID and refuses stale project",async()=>{
  const ctx=await cardRenderer();
  const id="WTB-P0-LONG-TASK-NUMBER-20261106-T1";
  const row=ctx.renderCard({id,track:"bugfix",priority:"P0",status:"待独测"}).children.find(n=>n.className==="task-id-row");
  const btn=row.children[1];
  ctx.navigator.clipboard.writeText=async()=>{throw Error("Permission denied")};
  assert.equal(await ctx.copyId(id,btn,"demo",1),false);
  assert.deepEqual(ctx.copied,[]);
  const input=row.children.find(n=>n.className==="copy-task-id-fallback");
  assert.equal(input.value,id);
  assert.equal(input.readOnly,true);
  assert.equal(input.focused,true);
  assert.equal(input.selected,true);
  assert.equal(ctx.toasts.at(-1).error,true);
  assert.doesNotMatch(ctx.toasts.at(-1).message,/已复制/);
  ctx.sameProject=()=>false;
  assert.equal(await ctx.copyId("WRONG-TASK",btn,"other",2),false);
  assert.equal(input.value,id);
});

test("R3 detail copy and mobile touch target remain available",async()=>{
  const html=await fs.readFile("web/index.html","utf8");
  const css=await fs.readFile("web/styles.css","utf8");
  const js=await fs.readFile("web/app.js","utf8");
  assert.match(html,/id="detailTaskId"[\s\S]*?id="copyDetailTaskIdBtn"/);
  assert.match(html,/id="copyDetailTaskIdBtn"[^>]*type="button"[^>]*aria-label=/);
  assert.match(css,/\.copy-task-id\{[^}]*width:40px;[^}]*height:40px;[^}]*min-height:40px/);
  assert.match(js,/els\.copyDetailTaskIdBtn\.addEventListener\("click"/);
  assert.match(js,/copyTaskId\(task\.id,els\.copyDetailTaskIdBtn,projectId,epoch\)/);
});

test("R2 repeated taps produce one clipboard write and stale project shows no success",async()=>{
  const ctx=await cardRenderer();
  const id="WTB-P1-COPY-NO-DUPLICATES-20261106-T1";
  const row=ctx.renderCard({id,track:"product",priority:"P1",status:"待开发"}).children.find(n=>n.className==="task-id-row");
  const btn=row.children[1];let release;
  ctx.navigator.clipboard.writeText=async value=>{
    ctx.copied.push(value);
    await new Promise(resolve=>{release=resolve});
  };
  let stopped=0;
  btn.listeners.click({stopPropagation(){stopped++}});
  btn.listeners.click({stopPropagation(){stopped++}});
  assert.equal(stopped,2);
  assert.deepEqual(ctx.copied,[id]);
  assert.equal(btn.disabled,true);
  ctx.sameProject=()=>false;
  release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(btn.disabled,false);
  assert.equal(ctx.toasts.length,0);
  assert.equal(ctx.openCount,0);
});
