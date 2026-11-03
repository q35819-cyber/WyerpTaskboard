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

test("ready queue UI fails closed on STOP, stale/missing candidates and keeps blocked tasks visible", async () => {
  const source=await fs.readFile(path.resolve(import.meta.dirname,"..","web","app.js"),"utf8");
  const readySource=source.match(/function isReadyTask\(task\)\{[\s\S]*?\n\}/)?.[0];
  const boardSource=source.match(/function boardTasksForColumn\(column\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(readySource && boardSource,"test real UI functions, not a copied implementation");
  const task={id:"READY-1",status:"待执行",plannedRole:"开发AI",assignee:"",sessionId:""};
  const state={projectId:"fixture",filtered:[task],scanStatus:{scan:{last_scan_at:new Date().toISOString()}}};
  let candidate={projectId:"fixture",taskId:"READY-1",status:"待执行",eligible:true,blockers:[]};
  const lookup=()=>candidate;
  const ready=new Function("state","developerCandidateFor",readySource+"\nreturn isReadyTask;")(state,lookup);
  const board=new Function("state","developerCandidateFor","isReadyTask","tasksForColumn",boardSource+"\nreturn boardTasksForColumn;")
    (state,lookup,ready,(tasks,statuses)=>tasks.filter(item=>statuses.includes(item.status)));
  const todo={id:"todo",statuses:["待确认","待准备","待开发"]};
  const awaiting={id:"awaiting_work",statuses:["待执行","待独测","待复测"]};
  assert.equal(ready(task),true);
  assert.deepEqual(board(awaiting).map(item=>item.id),["READY-1"]);
  candidate={...candidate,eligible:false,blockers:["STOP"]};
  assert.equal(ready(task),false);
  assert.deepEqual(board(awaiting),[]);
  assert.deepEqual(board(todo).map(item=>item.id),["READY-1"]);
  candidate={...candidate,eligible:true,blockers:["前置未完成"]};
  assert.equal(ready(task),false);
  candidate=null;
  assert.equal(ready(task),false);
  candidate={projectId:"fixture",taskId:"READY-1",status:"待执行",eligible:true,blockers:[]};
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.equal(ready(task),false,"expired scan must not count as ready");
  state.scanStatus.scan.last_scan_at=new Date().toISOString();
  candidate.status="待开发";
  assert.equal(ready(task),false,"candidate from a previous status cannot authorize this task");
  candidate.status="待执行";
  assert.equal(ready({...task,assignee:"other-ai"}),false);
  assert.equal(ready({...task,plannedRole:"总控AI"}),false);
});

test("ready column derives fresh developer eligibility and separates QA, delivery across changes", async () => {
  const [{ wyerpAiFlowV1: flow }, source] = await Promise.all([
    import("../server/workflows/wyerp-ai-flow-v1.mjs"),
    fs.readFile(path.resolve(import.meta.dirname, "..", "web", "app.js"), "utf8")
  ]);
  const readySource=source.match(/function isReadyTask\(task\)\{[\s\S]*?\n\}/)?.[0];
  const boardSource=source.match(/function boardTasksForColumn\(column\)\{[\s\S]*?\n\}/)?.[0];
  assert.ok(readySource && boardSource);
  const task=(id,status,role="开发AI")=>({id,status,plannedRole:role,assignee:"",sessionId:""});
  const A=task("A","待开发"),B=task("B","待开发"),C=task("C","待准备");
  const QA=task("QA","待独测","独立测试AI"),RE=task("RE","待复测","独立测试AI");
  const DEL=task("DEL","待交付","总控AI");
  const state={projectId:"fixture",filtered:[A,B,C,QA,RE,DEL],scanStatus:{
    scan:{last_scan_at:new Date().toISOString()},
    developerCandidates:[
      {projectId:"fixture",taskId:"A",status:"待开发",eligible:true,blockers:[]},
      {projectId:"fixture",taskId:"B",status:"待开发",eligible:false,blockers:["A前置未完成"]},
      {projectId:"fixture",taskId:"C",status:"待准备",eligible:true,blockers:[]}
    ]
  }};
  const candidate=(t)=>state.scanStatus.developerCandidates.find(x=>x.projectId===state.projectId&&x.taskId===t.id)||null;
  const ready=new Function("state","developerCandidateFor",readySource+"\nreturn isReadyTask;")(state,candidate);
  const board=new Function("state","developerCandidateFor","isReadyTask","tasksForColumn",boardSource+"\nreturn boardTasksForColumn;")(
    state,candidate,ready,(tasks,statuses)=>tasks.filter(t=>statuses.includes(t.status)));
  const get=(id)=>board(flow.boardColumns.find(c=>c.id===id)).map(t=>t.id);
  assert.deepEqual(get("awaiting_work"),["A","C"]);
  assert.deepEqual(get("qa_pending"),["QA","RE"]);
  assert.deepEqual(get("awaiting_delivery_user"),["DEL"]);
  assert.deepEqual(get("todo"),["B"]);
  assert.equal(state.filtered.filter(ready).length,2);
  // A was completed; B's dependency is now fulfilled, C is already claimed.
  A.status="已完成";
  B.status="待开发";
  C.status="开发中";
  C.assignee="another-developer";
  state.scanStatus.developerCandidates=[
    {projectId:"fixture",taskId:"B",status:"待开发",eligible:true,blockers:[]}
  ];
  assert.deepEqual(get("awaiting_work"),["B"]);
  assert.deepEqual(get("qa_pending"),["QA","RE"]);
  assert.equal(state.filtered.filter(ready).length,1);
  state.scanStatus.scan.last_scan_at=new Date(Date.now()-31*60*1000).toISOString();
  assert.deepEqual(get("awaiting_work"),[]);
  assert.deepEqual(get("todo"),["B"]);
  assert.deepEqual(get("qa_pending"),["QA","RE"]);
  assert.equal(state.filtered.filter(ready).length,0);
  // Each task belongs to exactly one visible column; projection never mutates persisted status.
  const all=flow.boardColumns.flatMap(c=>get(c.id));
  assert.equal(all.length,state.filtered.length);
  assert.equal(new Set(all).size,all.length);
  assert.equal(B.status,"待开发");
  assert.equal(QA.status,"待独测");
  assert.equal(RE.status,"待复测");
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
