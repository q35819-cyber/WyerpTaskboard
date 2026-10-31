import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskboardServer } from "../server/http-server.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";
import { ScanStore } from "../server/scan-store.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";
import { ChatBrowserWake } from "../server/chat-browser-wake.mjs";
import { makeFixture } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const TASKCTL = path.resolve(import.meta.dirname, "..", "cli", "taskctl.mjs");

async function startFixture(t) {
  const fixture = await makeFixture();
  await fs.writeFile(path.join(fixture.projectRoot, "ledger.md"), "# ledger\n", "utf8");
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  return { fixture, base };
}

async function taskctl(rootDir, base, args) {
  const { stdout } = await execFileAsync(process.execPath, [TASKCTL, ...args], {
    cwd: path.resolve("."),
    windowsHide: true,
    env: { ...process.env, WYERP_TASKBOARD_ROOT: rootDir, WYERP_TASKBOARD_URL: base },
    maxBuffer: 2 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function preclaimForCanary(rootDir, base, { actorType, actorId, sessionId }) {
  const result = await taskctl(rootDir, base, [
    "preclaim-report", "--project", "fixture", "--task", "B-10",
    "--actor-type", actorType, "--actor-id", actorId, "--session-id", sessionId,
    "--note", "Canary fixture: reported B-10 scope, current status, role eligibility and execution boundary before claim"
  ]);
  assert.equal(result.preclaimReport.valid, true, "canary must satisfy current preclaim-report gate");
  return result;
}

async function scanCandidate(scanner, scanStore, taskId, role) {
  const scan = await scanner.scanOnce({ trigger: "unattended_core_canary" });
  assert.equal(scan.state, "completed");
  const candidate = (await scanStore.list()).find(item =>
    item.task_id === taskId &&
    item.eligible === true &&
    item.eligible_role === role
  );
  assert.ok(candidate, taskId + " should expose an eligible " + role + " candidate");
  return candidate;
}

async function wakeAck(wake, candidate, role, epoch) {
  const client = "canary-" + role + "-" + epoch;
  const claim = await wake.claim([candidate], client, role, epoch);
  assert.equal(claim.state, "candidate");
  assert.equal(claim.candidate.task_id, candidate.task_id);
  const ack = await wake.ack(candidate.detection_id, client, {
    dispatcher_epoch: epoch,
    role,
    conversation_url: "https://chatgpt.com/c/canary-" + epoch,
    request_count: 1
  });
  assert.equal(ack.state, "acked");
}

test("unattended core loops developer -> independent test fail -> repair -> retest pass -> system auto-close -> next work", async (t) => {
  const { fixture, base } = await startFixture(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, {
    taskStore,
    requirementStore,
    scanStore
  }).init();
  const wake = await new ChatBrowserWake(fixture.boardRoot).init();

  const devDone = await taskctl(fixture.boardRoot, base, [
    "complete", "--project", "fixture", "--task", "B-10",
    "--actor-id", "dev-initial", "--session-id", "wc_sess_test",
    "--note", "canary initial development done"
  ]);
  assert.equal(devDone.after.status, "待独测");
  assert.equal(devDone.after.assignee, "");

  let candidate = await scanCandidate(scanner, scanStore, "B-10", "test_ai");
  await wakeAck(wake, candidate, "test_ai", 1001);
  await preclaimForCanary(fixture.boardRoot, base, {
    actorType: "test_ai", actorId: "canary-test-ai", sessionId: "sess-test-1"
  });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "B-10",
    "--assignee", "Canary Test AI", "--session-name", "canary-test-1", "--session-id", "sess-test-1",
    "--actor-type", "test_ai", "--actor-id", "canary-test-ai"
  ]);
  const failed = await taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "B-10",
    "--result", "fail", "--report", "reports/B-10/fail.md", "--note", "canary defect",
    "--actor-type", "test_ai", "--actor-id", "canary-test-ai", "--session-id", "sess-test-1"
  ]);
  assert.equal(failed.after.status, "测试失败待修复");
  assert.equal(failed.after.plannedRole, "开发AI");
  assert.equal(failed.after.assignee, "");

  candidate = await scanCandidate(scanner, scanStore, "B-10", "developer_ai");
  await wakeAck(wake, candidate, "developer_ai", 1002);
  await preclaimForCanary(fixture.boardRoot, base, {
    actorType: "developer_ai", actorId: "canary-dev-ai", sessionId: "sess-dev-fix"
  });
  const repairClaim = await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "B-10",
    "--assignee", "Canary Dev AI", "--session-name", "canary-dev-fix", "--session-id", "sess-dev-fix",
    "--actor-type", "developer_ai", "--actor-id", "canary-dev-ai"
  ]);
  assert.equal(repairClaim.after.status, "修复中");
  const repairDone = await taskctl(fixture.boardRoot, base, [
    "complete", "--project", "fixture", "--task", "B-10",
    "--actor-type", "developer_ai", "--actor-id", "canary-dev-ai", "--session-id", "sess-dev-fix",
    "--note", "canary repair done"
  ]);
  assert.equal(repairDone.after.status, "待复测");
  assert.equal(repairDone.after.plannedRole, "独立测试AI");
  assert.equal(repairDone.after.assignee, "");

  candidate = await scanCandidate(scanner, scanStore, "B-10", "test_ai");
  await wakeAck(wake, candidate, "test_ai", 1003);
  await preclaimForCanary(fixture.boardRoot, base, {
    actorType: "test_ai", actorId: "canary-test-ai", sessionId: "sess-test-2"
  });
  const retestClaim = await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "B-10",
    "--assignee", "Canary Retest AI", "--session-name", "canary-test-2", "--session-id", "sess-test-2",
    "--actor-type", "test_ai", "--actor-id", "canary-test-ai"
  ]);
  assert.equal(retestClaim.after.status, "复测中");
  const passed = await taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "B-10",
    "--result", "pass", "--report", "reports/B-10/pass.md", "--note", "canary retest passed",
    "--actor-type", "test_ai", "--actor-id", "canary-test-ai", "--session-id", "sess-test-2"
  ]);
  assert.equal(passed.after.status, "已完成");
  assert.equal(passed.after.plannedRole, "");
  assert.equal(passed.after.assignee, "");
  assert.equal(passed.after.sessionId, "");

  await scanner.scanOnce({ trigger: "unattended_core_next_work" });
  const active = await scanStore.list();
  assert.equal(active.some(item => item.eligible && item.task_id === "B-10" && item.eligible_role === "developer_ai"), false, "no-delivery pass must not create an empty developer delivery candidate");
  assert.ok(active.some(item => item.eligible && item.task_id !== "B-10"), "scanner should continue exposing the next eligible task");

  const events = await scanStore.recentEvents(200);
  assert.ok(events.filter(event => event.type === "scan_rearmed").length >= 4);
  const wakeState = await wake.readState();
  assert.ok(Object.keys(wakeState.acked || {}).length >= 3);
});
