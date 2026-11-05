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
    source.slice(source.indexOf("function taskCard("),source.indexOf("function columnPageKey(")),
    source.slice(source.indexOf("function renderList("),source.indexOf("function renderRequirements("))
  ];
  const makeElement=(tag)=>({tag,children:[],listeners:{},className:"",textContent:"",
    append(...nodes){this.children.push(...nodes)},
    addEventListener(name,callback){this.listeners[name]=callback}
  });
  const context={
    document:{createElement:makeElement},
    state:{projectId:"demo",projectEpoch:1,filtered:[]},
    els:{taskTableBody:{rows:[],replaceChildren(...rows){this.rows=rows}}},
    taskTitle:t=>t.id,priorityLabel:t=>t,mainPlan:()=>null,planName:()=>"",
    developerCandidateFor:()=>null,isReadyTask:()=>false,roleLabel:()=>"",
    sameProject:()=>true,openTask:()=>{},formatTime:()=>"",
  };
  vm.runInNewContext(blocks.join("\n")+"\nthis.renderCard=taskCard;this.renderList=renderList;this.statusText=statusLabel;",context);
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
