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
