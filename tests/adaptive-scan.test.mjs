import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ScanStore } from "../server/scan-store.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";

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
    ],qaCandidates:[
      {projectId:"fixture",taskId:"QA",status:"待独测",eligible:true,evidenceVerified:true,blockers:[]},
      {projectId:"fixture",taskId:"RE",status:"待复测",eligible:true,evidenceVerified:true,blockers:[]}
    ]
  }};
  const candidate=t=>state.scanStatus.developerCandidates.find(x=>x.projectId===state.projectId&&x.taskId===t.id)||null;
  const qaCandidate=t=>state.scanStatus.qaCandidates.find(x=>x.projectId===state.projectId&&x.taskId===t.id)||null;
  const testSource=source.match(/function isReadyTestTask\(task\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(testSource,"current UI includes QA readiness");
  const testReady=new Function("state","qaCandidateFor",testSource+"\nreturn isReadyTestTask;")(state,qaCandidate);
  const ready=new Function("state","developerCandidateFor",readySource+"\nreturn isReadyTask;")(state,candidate);
  const board=new Function("state","developerCandidateFor","isReadyTask","tasksForColumn","isReadyTestTask",boardSource+"\nreturn boardTasksForColumn;")(
    state,candidate,ready,(items,statuses)=>items.filter(t=>statuses.includes(t.status)),testReady);
  const get=id=>board(flow.boardColumns.find(c=>c.id===id)).map(t=>t.id);
  assert.equal(flow.boardColumns.length,6);
  assert.ok(!flow.boardColumns.some(c=>c.id==="awaiting_work"));
  assert.deepEqual(get("qa_pending"),["A","QA","RE"]);
  assert.equal(get("qa_pending").filter(id=>["A","C"].includes(id)).length,1,"developer count");
  assert.equal(get("qa_pending").filter(id=>["QA","RE"].includes(id)).length,2,"QA count");
  assert.deepEqual(get("awaiting_delivery_user"),["DEL"]);
  assert.deepEqual(get("todo"),["B","C","LEG"]);
  assert.equal(state.filtered.filter(ready).length,1);
  A.status="已完成";
  C.status="开发中";C.assignee="dev-other";
  state.scanStatus.developerCandidates=[{projectId:"fixture",taskId:"B",status:"待开发",eligible:true,blockers:[]}];
  assert.deepEqual(get("qa_pending"),["B","QA","RE"]);
  state.scanStatus.qaCandidates[0].evidenceVerified=false;
  assert.deepEqual(get("qa_pending"),["B","RE"],"QA without fixed evidence is not ready");
  assert.ok(get("todo").includes("QA"),"unready QA stays visible");
  state.scanStatus.qaCandidates[0].evidenceVerified=true;
  assert.equal(state.filtered.filter(ready).length,1);
  assert.equal(state.filtered.flatMap(()=>[]).length,0);
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.deepEqual(get("qa_pending"),[],"stale scan removes developer and QA");
  assert.deepEqual(get("todo"),["B","QA","RE","LEG"]);
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
    "document","taskCard","renderPagination",renderSource+"\nreturn renderBoard;")(
      state,els,board,ready,(items,page,size)=>{
        const pages=Math.max(1,Math.ceil(items.length/size));
        const current=Math.min(Math.max(1,page||1),pages);
        return {page:current,totalPages:pages,visible:items.slice((current-1)*size,current*size)};
      },3,{createElement:node},task=>Object.assign(node("article"),{taskId:task.id}),()=>node("nav"));
  const renderedCount=()=>{
    renderBoard();
    assert.equal(els.boardView.children.length,6,"six actual DOM columns");
    const shared=els.boardView.children.find(col=>
      col.children[0]?.children[0]?.textContent===flow.boardColumns.find(c=>c.id==="qa_pending").title);
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
  assert.equal(renderedCount(),"开发 1 项 · 测试 2 项 · BUG 0 项");
  state.filtered=state.filtered.filter(t=>["A","QA"].includes(t.id));
  assert.equal(renderedCount(),"开发 1 项 · 测试 1 项 · BUG 0 项","count tracks current filter");
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.equal(renderedCount(),"开发 0 项 · 测试 0 项 · BUG 0 项","stale scan removes all unverified candidates");
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

test("scanner promotes dispatched ready preparation exactly once, never without dispatch or with STOP", async (t) => {
  const dir = await root(t);
  const scanStore = await new ScanStore(dir).init();
  const task = { id: "PRE", status: "待准备", updatedAt: "2026-11-06T00:00:00Z", assignee: "", sessionId: "" };
  let dispatched = false, stop = false, provisional = false, writes = 0;
  const taskStore = {
    projects: { list: () => [{ id: "fixture" }] },
    taskHistory: async () => dispatched ? [{ event_id: "evt_dispatch", event_type: "controller_dispatch",
      actor_type: "controller_ai", old_status: "待准备", new_status: "待准备" }] : [],
    getTask: async () => ({ task: { ...task }, snapshot: { registryRevision: "rev1" } }),
    stopState: async () => ({ stopRequested: stop }),
    updateTask: async (_project, _id, patch, opts) => {
      assert.equal(opts.eventType, "auto_preparation_ready");
      assert.equal(opts.actorType, "system");
      assert.equal(opts.metadata.controllerDispatchEventId, "evt_dispatch");
      assert.equal(patch.status, "待开发");
      writes++; task.status = patch.status; return { idempotentReplay: false };
    }
  };
  const scanner = new TaskScanner(dir, { taskStore, requirementStore: {}, scanStore,
    wakeBridge: { notifyCandidate: async () => ({ state: "no_candidate" }) },
    chatBrowserWake: { readState: async () => ({ acked: {} }),
      publicStatus: () => ({ enabled: false }) } });
  scanner.evaluator = { evaluateProject: async () => ({
    project_id: "fixture", status: "ok", detected_at: new Date().toISOString(),
    registry_revision: "rev1", registry_sha: "sha", resource_ledger_sha: "ledger", task_count: 1,
    watch: { test_tasks: 0, developer_tasks: 1, active_test_tasks: 0, active_developer_tasks: 0, pending_requirements: 0 },
    candidates: [{ project_id: "fixture", task_id: task.id, status: task.status,
      task_updated_at: task.updatedAt, eligible: true, provisional, eligible_role: "developer_ai",
      blockers: [], track: "bugfix", priority: "P0" }]
  }) };
  await scanner.scanOnce({ trigger: "test" });
  assert.equal(task.status, "待准备"); assert.equal(writes, 0, "scan flag alone is not proof");
  dispatched = true; stop = true;
  await scanner.scanOnce({ trigger: "test" });
  assert.equal(task.status, "待准备"); assert.equal(writes, 0, "STOP forbids promotion");
  stop = false; provisional = true;
  await scanner.scanOnce({ trigger: "test" });
  assert.equal(writes, 0, "provisional developer approval is not preparation completion");
  provisional = false;
  const completed = await scanner.scanOnce({ trigger: "test" });
  assert.equal(task.status, "待开发"); assert.equal(writes, 1);
  assert.equal(completed.projects[0].candidates[0].status, "待开发");
  await scanner.scanOnce({ trigger: "test" });
  assert.equal(writes, 1, "already promoted tasks never emit duplicate transition");
});
