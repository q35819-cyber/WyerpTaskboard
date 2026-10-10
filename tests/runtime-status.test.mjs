import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskboardRuntimeStatus } from "../server/runtime-status.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-runtime-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of [
    "config",
    "browser-extension/chat-wake",
    "data/runtime/chatgpt-health",
    "data/runtime/task-scan",
    "data/runtime/validation",
    "scripts"
  ]) await fs.mkdir(path.join(root, dir), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({version:"0.6.6"}));
  await fs.writeFile(path.join(root, "browser-extension/chat-wake/manifest.json"), JSON.stringify({version:"0.6.7"}));
  await fs.writeFile(path.join(root, "config/chat-browser-wake.json"), JSON.stringify({
    version:1, enabled:true, token:"s".repeat(64), expected_extension_version:"0.6.7"
  }));
  await fs.writeFile(path.join(root, "config/chatgpt-health.json"), JSON.stringify({
    version:1, enabled:true, interval_minutes:1, dispatcher_stale_seconds:90
  }));
  const now = Date.parse("2026-09-29T10:00:00Z");
  await fs.writeFile(path.join(root, "data/runtime/task-scan/chat-browser-wake.json"), JSON.stringify({
    version:1, leases:{}, acked:{a:{}}, dispatcher:{
      client_id:"browser", dispatcher_epoch:44, role:"developer_ai", extension_version:"0.6.7",
      last_seen_at:new Date(now-30000).toISOString(), last_seen_at_ms:now-30000
    }
  }));
  await fs.writeFile(path.join(root, "data/runtime/task-scan/scheduler.json"), JSON.stringify({
    version:2, installed:true, state:"installed", task_name:"WyerpTaskboard-TaskScan", interval_minutes:10
  }));
  await fs.writeFile(path.join(root, "data/runtime/chatgpt-health/status.json"), JSON.stringify({
    version:1, state:"healthy", healthy:true, checked_at:new Date(now-10000).toISOString(),
    mcp:{ready:true,server:{name:"windows-mcp"},tool_count:20}
  }));
  await fs.writeFile(path.join(root, "data/runtime/chatgpt-health/scheduler.json"), JSON.stringify({
    version:1, installed:true, state:"installed", task_name:"WyerpTaskboard-ChatGPT-MCP-Health", interval_minutes:1
  }));
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({
    version:1,state:"failed",files:30,failedFiles:1,durationMs:1200,
    failures:[{file:"http-server.test.mjs",exit_code:1,stdout_tail:"assertion failed",stderr_tail:""}]
  }));
  return {root,now};
}

test("runtime status light snapshot skips live scheduler probes and uses recorded scheduler truth", async (t) => {
  const {root,now}=await fixture(t);
  let probeCalls=0;
  const result=await new TaskboardRuntimeStatus(root,{
    clock:()=>now,
    healthSchedulerProbe:async()=>{ probeCalls += 1; return {live_probe:true,state:"Ready"}; }
  }).snapshot({liveProbes:false});
  assert.equal(probeCalls,0);
  assert.equal(result.schedulers.task_scan.state,"installed");
  assert.equal(result.schedulers.chatgpt_mcp_health.state,"installed");
});

test("runtime status exposes active developer and test tasks from task registry truth", async (t) => {
  const {root,now}=await fixture(t);
  const taskStore = {
    projects: { list: () => [{ id: "fixture" }] },
    snapshot: async () => ({ tasks: [
      { id:"DEV-1", parent:"监控界面中文化", status:"开发中", plannedRole:"开发AI", assignee:"开发AI", sessionId:"dev-session", updatedAt:"2026-09-29T09:59:00Z" },
      { id:"TEST-1", parent:"独立复测", status:"复测中", plannedRole:"独立测试AI", assignee:"测试AI", sessionId:"test-session", updatedAt:"2026-09-29T09:58:00Z" },
      { id:"WAIT-1", parent:"未执行", status:"待开发", plannedRole:"开发AI", assignee:"", sessionId:"", updatedAt:"2026-09-29T09:57:00Z" }
    ] })
  };
  const result=await new TaskboardRuntimeStatus(root,{clock:()=>now,taskStore}).snapshot({liveProbes:false});
  assert.deepEqual(result.active_tasks.developer.map((item)=>item.task_id),["DEV-1"]);
  assert.equal(result.active_tasks.developer[0].name,"监控界面中文化");
  assert.deepEqual(result.active_tasks.test.map((item)=>item.task_id),["TEST-1"]);
});

test("runtime status falls back to task registry activity when dispatcher has no active task", async (t) => {
  const {root,now}=await fixture(t);
  const taskStore = {
    projects: { list: () => [{ id: "fixture" }] },
    snapshot: async () => ({ tasks: [
      { id:"TEST-ONLY", parent:"监控独测", status:"独测中", plannedRole:"独立测试AI", assignee:"独立测试AI", sessionId:"test-session", updatedAt:"2026-09-29T09:59:30Z" }
    ] })
  };
  const result=await new TaskboardRuntimeStatus(root,{clock:()=>now,taskStore}).snapshot({liveProbes:false});
  assert.deepEqual(result.active_tasks.test.map((item)=>item.task_id),["TEST-ONLY"]);
  assert.equal(result.activity.project_id,"fixture");
  assert.equal(result.activity.task_id,"TEST-ONLY");
  assert.equal(result.activity.role,"test_ai");
  assert.equal(result.activity.phase,"executing");
});

test("runtime status CLI wires TaskStore into the runtime snapshot", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "cli", "runtime-status.mjs"), "utf8");
  assert.match(content, /import \{ TaskStore \} from "\.\.\/server\/task-store\.mjs";/);
  assert.match(content, /await new TaskStore\(ROOT\)\.init\(\)/);
  assert.match(content, /new TaskboardRuntimeStatus\(ROOT, \{ taskStore \}\)\.snapshot\(\)/);
});

test("runtime status exposes structured version, bridge, scheduler and npm validation without secrets", async (t) => {
  const {root,now}=await fixture(t);
  const result=await new TaskboardRuntimeStatus(root,{
    clock:()=>now,
    healthSchedulerProbe:async()=>({live_probe:true,installed:true,state:"Ready",last_task_result:0})
  }).snapshot();
  assert.equal(result.versions.contract_ok,true);
  assert.equal(result.versions.package,"0.6.6");
  assert.equal(result.versions.extension,"0.6.7");
  assert.equal(result.versions.extension_runtime_ok,true);
  assert.equal(result.bridge.dispatcher.fresh,true);
  assert.equal(result.schedulers.chatgpt_mcp_health.interval_minutes,1);
  assert.equal(result.validation.npm_test.state,"failed");
  assert.equal(result.validation.npm_test.failures[0].file,"http-server.test.mjs");
  assert.equal(result.mcp.lifecycle,"spawn_on_demand");
  assert.equal(result.mcp.policy,"anomaly_or_explicit_ui_only");
  assert.equal(result.policy.session_switch,"read_before_act");
  assert.equal(result.system_log.path_pattern,"data/runtime/system-events/YYYY-MM-DD.jsonl");
  assert.ok(Array.isArray(result.system_log.recent_errors));
  assert.equal(JSON.stringify(result).includes("s".repeat(64)),false);
});