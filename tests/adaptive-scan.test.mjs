import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScanStore } from "../server/scan-store.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";
import { countReadyColumnBugs } from "../web/board-state.mjs";

async function root(t) {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-adaptive-scan-"));
  t.after(() => fs.rm(value, { recursive: true, force: true }));
  return value;
}

test("one shared ready column derives developer eligibility and keeps QA and delivery roles separate", async () => {
  const { wyerpAiFlowV1: flow } = await import("../server/workflows/wyerp-ai-flow-v1.mjs");
  const source = await fs.readFile(path.resolve(import.meta.dirname, "..", "web", "app.js"), "utf8");
  const readySource = source.match(/function isReadyTask\(task\)\{[\s\S]*?\n\}/)?.[0];
  const boardSource = source.match(/function boardTasksForColumn\(column\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(readySource && boardSource, "actual UI source includes derived ready column functions");
  const task = (id,status,role="开发AI") => ({id,status,plannedRole:role,assignee:"",sessionId:""});
  const A=task("A","待开发"), B=task("B","待开发"), C=task("C","待准备");
  const QA=task("QA","待独测","独立测试AI"), RE=task("RE","待复测","独立测试AI");
  const DEL=task("DEL","待交付","总控AI"), LEG=task("LEG","待执行");
  const state={projectId:"fixture",filtered:[A,B,C,QA,RE,DEL,LEG],scanStatus:{
    scan:{last_scan_at:new Date().toISOString()},developerCandidates:[
      {projectId:"fixture",taskId:"A",status:"待开发",eligible:true,blockers:[]},
      {projectId:"fixture",taskId:"B",status:"待开发",eligible:false,blockers:["A前置未完成"]},
      {projectId:"fixture",taskId:"C",status:"待准备",eligible:true,blockers:[]},
      {projectId:"fixture",taskId:"LEG",status:"待执行",eligible:false,blockers:["过期"]}
    ]
  }};
  const candidate=t=>state.scanStatus.developerCandidates.find(x=>x.projectId===state.projectId&&x.taskId===t.id)||null;
  const ready=new Function("state","developerCandidateFor",readySource+"\nreturn isReadyTask;")(state,candidate);
  const board=new Function("state","developerCandidateFor","isReadyTask","tasksForColumn",boardSource+"\nreturn boardTasksForColumn;")(
    state,candidate,ready,(items,statuses)=>items.filter(t=>statuses.includes(t.status)));
  const get=id=>board(flow.boardColumns.find(c=>c.id===id)).map(t=>t.id);
  assert.equal(flow.boardColumns.length,6);
  assert.ok(!flow.boardColumns.some(c=>c.id==="awaiting_work"));
  assert.deepEqual(get("qa_pending"),["A","C","QA","RE"]);
  assert.equal(get("qa_pending").filter(id=>["A","C"].includes(id)).length,2,"developer count");
  assert.equal(get("qa_pending").filter(id=>["QA","RE"].includes(id)).length,2,"QA count");
  assert.deepEqual(get("awaiting_delivery_user"),["DEL"]);
  assert.deepEqual(get("todo"),["B","LEG"]);
  assert.equal(state.filtered.filter(ready).length,2);
  A.status="已完成";
  C.status="开发中";C.assignee="dev-other";
  state.scanStatus.developerCandidates=[{projectId:"fixture",taskId:"B",status:"待开发",eligible:true,blockers:[]}];
  assert.deepEqual(get("qa_pending"),["B","QA","RE"]);
  assert.equal(state.filtered.filter(ready).length,1);
  assert.equal(state.filtered.flatMap(()=>[]).length,0);
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.deepEqual(get("qa_pending"),["QA","RE"],"stale scan removes developer, not QA");
  assert.deepEqual(get("todo"),["B","LEG"]);
  const ids=flow.boardColumns.flatMap(col=>get(col.id));
  assert.equal(ids.length,state.filtered.length);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(B.status,"待开发");
  // Exercise the real renderBoard function with minimal DOM nodes, not just column metadata.
  const renderSource=source.match(/function renderBoard\(\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(renderSource);
  const node=tag=>({
    tag,children:[],classList:{add(){}},textContent:"",className:"",
    append(...parts){this.children.push(...parts)},
    replaceChildren(...parts){this.children=[...parts]}
  });
  const els={boardView:node("main")};
  state.workflow=flow;state.columnPages={};
  const renderBoard=new Function("state","els","boardTasksForColumn","isReadyTask","paginateColumn","PAGE_SIZE",
    "document","taskCard","renderPagination","countReadyColumnBugs",renderSource+"\nreturn renderBoard;")(
      state,els,board,ready,(items,page,size)=>{
        const pages=Math.max(1,Math.ceil(items.length/size));
        const current=Math.min(Math.max(1,page||1),pages);
        return {page:current,totalPages:pages,visible:items.slice((current-1)*size,current*size)};
      },3,{createElement:node},task=>Object.assign(node("article"),{taskId:task.id}),()=>node("nav"),countReadyColumnBugs);
  const renderedCount=()=>{
    renderBoard();
    assert.equal(els.boardView.children.length,6,"six actual DOM columns");
    const shared=els.boardView.children.find(col=>
      col.children[0]?.children[0]?.textContent==="待执行");
    assert.ok(shared);
    assert.equal(shared.children.filter(child=>child.tag==="article").length,
      Math.min(3,get("qa_pending").length),"pagination never changes full role counts");
    return shared.children[0].children[1].textContent;
  };
  A.status="待开发";C.status="待准备";C.assignee="";
  state.scanStatus.scan.last_scan_at=new Date().toISOString();
  state.scanStatus.developerCandidates=[
    {projectId:"fixture",taskId:"A",status:"待开发",eligible:true,blockers:[]},
    {projectId:"fixture",taskId:"B",status:"待开发",eligible:false,blockers:["前置未完成"]},
    {projectId:"fixture",taskId:"C",status:"待准备",eligible:true,blockers:[]}
  ];
  assert.equal(renderedCount(),"开发 2 项 · 测试 2 项 · BUG 0 项");
  QA.track="bugfix";A.track="bugfix";
  assert.equal(renderedCount(),"开发 2 项 · 测试 2 项 · BUG 2 项","QA BUG and eligible developer BUG both count before paging");
  state.filtered=state.filtered.filter(t=>["A","QA"].includes(t.id));
  assert.equal(renderedCount(),"开发 1 项 · 测试 1 项 · BUG 2 项","count tracks current filter");
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.equal(renderedCount(),"开发 0 项 · 测试 1 项 · BUG 1 项","stale scan returns developer to todo");
});

test("scheduled dispatcher scans busy or idle mode only when due", async (t) => {
  const dir = await root(t);
  let now = Date.parse("2026-09-29T00:00:00Z");
  const store = await new ScanStore(dir, { clock: () => now }).init();

  await store.writeStatus({ scheduler_mode: "idle_hunt", rearm_pending: false, next_due_at: new Date(now - 1).toISOString() });
  assert.equal((await store.scheduledDecision()).run, true);
  await store.writeStatus({ scheduler_mode: "idle_hunt", rearm_pending: false, next_due_at: new Date(now + 10_000).toISOString() });
  assert.equal((await store.scheduledDecision()).run, false);
  await store.writeStatus({ scheduler_mode: "busy_watch", rearm_pending: false, next_due_at: new Date(now - 1).toISOString() });
  assert.equal((await store.scheduledDecision()).run, true);
  await store.writeStatus({ scheduler_mode: "busy_watch", rearm_pending: false, next_due_at: new Date(now + 600_000).toISOString() });
  assert.equal((await store.scheduledDecision()).run, false);
});

test("rearm overrides suspended modes but temp roots never start the real Windows task", async (t) => {
  const dir = await root(t);
  const store = await new ScanStore(dir).init();
  await store.writeStatus({ scheduler_mode: "idle_hunt", rearm_pending: false });
  const rearmed = await store.requestRearm("task_write", { projectId: "p", taskId: "T-1" });
  assert.equal(rearmed.rearm_pending, true);
  assert.equal(rearmed.scheduler_trigger.started, false);
  assert.equal((await store.scheduledDecision()).reason, "rearm");
});

test("scanner uses busy_watch only for actually active work and idle_hunt otherwise", async (t) => {
  const dir = await root(t);
  let now = Date.parse("2026-09-29T00:00:00Z");
  const scanStore = await new ScanStore(dir, { clock: () => now }).init();
  const taskStore = { projects: { list: () => [{ id: "p" }] } };
  const wakeBridge = { notifyCandidate: async () => ({ state: "no_candidate", instant_trigger: "github_bridge_ready_unverified" }) };
  const chatBrowserWake = { readState: async () => ({ acked: {} }), publicStatus: () => ({ enabled: true, mode: "browser_extension_chat_only", expected_extension_version: "0.5.0" }) };
  const scanner = new TaskScanner(dir, {
    clock: () => now,
    taskStore,
    requirementStore: {},
    scanStore,
    wakeBridge,
    chatBrowserWake,
  });
  let watch = { test_tasks: 1, developer_tasks: 5, active_test_tasks: 1, active_developer_tasks: 0, pending_requirements: 0 };
  scanner.evaluator = {
    evaluateProject: async () => ({
      project_id: "p", status: "ok", detected_at: new Date(now).toISOString(),
      registry_revision: "r", registry_sha: "s", resource_ledger_sha: "l",
      task_count: 1, watch, candidates: []
    })
  };

  let result = await scanner.scanOnce({ trigger: "test" });
  assert.equal(result.scheduler_mode, "busy_watch");
  assert.equal(Date.parse(result.next_due_at) - Date.parse(result.last_scan_at), 10 * 60 * 1000);

  now += 1000;
  watch = { test_tasks: 0, developer_tasks: 1, active_test_tasks: 0, active_developer_tasks: 1, pending_requirements: 0 };
  result = await scanner.scanOnce({ trigger: "test" });
  assert.equal(result.scheduler_mode, "busy_watch");

  now += 1000;
  watch = { test_tasks: 1, developer_tasks: 1, active_test_tasks: 0, active_developer_tasks: 0, pending_requirements: 1 };
  result = await scanner.scanOnce({ trigger: "test" });
  assert.equal(result.scheduler_mode, "idle_hunt");
  assert.equal(Date.parse(result.next_due_at) - Date.parse(result.last_scan_at), 10 * 1000);
});

test("a rearm arriving during a scan remains pending for a follow-up one-shot", async (t) => {
  const dir = await root(t);
  let now = Date.parse("2026-09-29T00:00:00Z");
  const scanStore = await new ScanStore(dir, { clock: () => now }).init();
  const taskStore = { projects: { list: () => [{ id: "p" }] } };
  const wakeBridge = { notifyCandidate: async () => ({ state: "no_candidate", instant_trigger: "github_bridge_ready_unverified" }) };
  const chatBrowserWake = { readState: async () => ({ acked: {} }), publicStatus: () => ({ enabled: true, mode: "browser_extension_chat_only", expected_extension_version: "0.5.0" }) };
  const scanner = new TaskScanner(dir, { clock: () => now, taskStore, requirementStore: {}, scanStore, wakeBridge, chatBrowserWake });
  scanner.evaluator = {
    evaluateProject: async () => {
      now += 1;
      await scanStore.requestRearm("concurrent_write", { taskId: "T-2" });
      return {
        project_id: "p", status: "ok", detected_at: new Date(now).toISOString(),
        registry_revision: "r", registry_sha: "s", resource_ledger_sha: "l",
        task_count: 0, watch: { test_tasks: 0, developer_tasks: 0, active_test_tasks: 0, active_developer_tasks: 0, pending_requirements: 0 }, candidates: []
      };
    }
  };
  const result = await scanner.scanOnce({ trigger: "test" });
  assert.equal(result.rearm_pending, true);
  assert.equal((await scanStore.scheduledDecision()).reason, "rearm");
});
