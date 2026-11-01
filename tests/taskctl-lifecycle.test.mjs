import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createTaskboardServer } from "../server/http-server.mjs";
import { parseRegistryText } from "../server/adapters/markdown-task-registry-v1.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const taskctlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli/taskctl.mjs");

async function startFixture(t) {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const port = app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  return { fixture, base: "http://127.0.0.1:" + port };
}

async function taskctl(rootDir, base, args) {
  const controllerProof = args[0] === "create"
    ? JSON.parse(await fs.readFile(path.join(rootDir, "config", "controller-proof.json"), "utf8")).proof
    : "";
  return execFileAsync(process.execPath, [taskctlPath, ...args], {
    cwd: path.resolve("."),
    windowsHide: true,
    env: {
      ...process.env,
      WYERP_TASKBOARD_ROOT: rootDir,
      WYERP_TASKBOARD_URL: base,
      ...(controllerProof ? { WYERP_CONTROLLER_PROOF: controllerProof } : {}),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function preclaim(rootDir, base, task, {
  actorType = "developer_ai",
  actorId,
  sessionId,
  note = "已向用户汇报任务ID、主要内容、当前阶段/可认领依据和本轮边界"
} = {}) {
  return JSON.parse((await taskctl(rootDir, base, [
    "preclaim-report", "--project", "fixture", "--task", task,
    "--actor-type", actorType, "--actor-id", actorId,
    "--session-id", sessionId, "--note", note
  ])).stdout);
}

test("taskctl complete atomically hands developer work to independent test and releases ownership", async (t) => {
  const { fixture, base } = await startFixture(t);
  const completed = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "complete", "--project", "fixture", "--task", "B-10",
    "--actor-id", "dev-1", "--session-id", "wc_sess_test",
    "--note", "开发与自测完成，自动交独测"
  ])).stdout);
  assert.equal(completed.after.status, "待独测");
  assert.equal(completed.after.plannedRole, "独立测试AI");
  assert.equal(completed.after.assignee, "");
  assert.equal(completed.after.sessionId, "");
});

test("taskctl delivery-failed records a visible blocker and preserves original developer ownership", async (t) => {
  const { fixture, base } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-CLI-FAIL", "F-DELIVERY", "infrastructure", "P0", "交付中", "开发AI", "developer", "交付窗口", "dev-session", "2026-10-31T00:00:00Z", "交付失败记录", "测试计划.md", "cp/B-10.md"]
  ]), "utf8");
  const event = async (eventType, actorType, actorId, sessionId, metadata) => {
    await taskctl(fixture.boardRoot, base, [
      "event", "--project", "fixture", "--task", "D-CLI-FAIL",
      "--event-type", eventType, "--actor-type", actorType, "--actor-id", actorId,
      "--session-id", sessionId, "--metadata", JSON.stringify(metadata)
    ]);
  };
  await event("handoff", "developer_ai", "developer", "dev-session", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  });
  await event("claim", "test_ai", "independent-tester", "test-session", { claimedFromStatus: "待独测" });
  await event("test_result", "test_ai", "independent-tester", "test-session", {
    atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required",
    deliveryActions: ["candidate_merge"], commitSha: "c".repeat(40),
    headBranch: "feature/candidate", reportPath: "reports/D-CLI-FAIL/pass.md"
  });
  await event("claim", "developer_ai", "developer", "dev-session", { claimedFromStatus: "待交付" });
  const failed = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "delivery-failed", "--project", "fixture", "--task", "D-CLI-FAIL",
    "--actor-id", "developer", "--session-id", "dev-session",
    "--failure-stage", "push", "--failure-code", "REMOTE_REJECTED",
    "--note", "远端推送被拒绝", "--next-action", "fetch origin/main 后同步并重试"
  ])).stdout);
  assert.equal(failed.event.event_type, "delivery_attempt_failed");
  assert.equal(failed.event.actor_id, "developer");
  const current = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "D-CLI-FAIL"
  ])).stdout);
  assert.equal(current.status, "交付中");
  assert.equal(current.assignee, "developer");
  assert.equal(current.sessionId, "dev-session");
  assert.match(current.presentation.currentProgress, /REMOTE_REJECTED/);
  assert.match(current.presentation.currentProgress, /远端推送被拒绝/);
  assert.match(current.presentation.currentProgress, /fetch origin\/main/);
});

test("taskctl complete automatically records a failed Git verification and keeps the delivery owner", async (t) => {
  const { fixture, base } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-CLI-COMPLETE", "F-DELIVERY", "infrastructure", "P0", "交付中", "开发AI", "developer", "交付窗口", "dev-session", "2026-10-31T00:00:00Z", "交付自动记录失败", "测试计划.md", "cp/B-10.md"]
  ]), "utf8");
  const event = async (eventType, actorType, actorId, sessionId, metadata) => {
    await taskctl(fixture.boardRoot, base, [
      "event", "--project", "fixture", "--task", "D-CLI-COMPLETE",
      "--event-type", eventType, "--actor-type", actorType, "--actor-id", actorId,
      "--session-id", sessionId, "--metadata", JSON.stringify(metadata)
    ]);
  };
  await event("handoff", "developer_ai", "developer", "dev-session", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  });
  await event("claim", "test_ai", "independent-tester", "test-session", { claimedFromStatus: "待独测" });
  await event("test_result", "test_ai", "independent-tester", "test-session", {
    atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required",
    deliveryActions: ["candidate_merge"], commitSha: "d".repeat(40),
    headBranch: "feature/candidate", reportPath: "reports/D-CLI-COMPLETE/pass.md"
  });
  await event("claim", "developer_ai", "developer", "dev-session", { claimedFromStatus: "待交付" });

  await assert.rejects(() => taskctl(fixture.boardRoot, base, [
    "complete", "--project", "fixture", "--task", "D-CLI-COMPLETE",
    "--actor-id", "developer", "--session-id", "dev-session",
    "--report", "reports/B-10/report.md"
  ]), (error) => {
    assert.match(error.stderr, /DELIVERY_REMOTE_UNAVAILABLE/);
    return true;
  });
  const current = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "D-CLI-COMPLETE"
  ])).stdout);
  assert.equal(current.status, "交付中");
  assert.equal(current.assignee, "developer");
  assert.equal(current.sessionId, "dev-session");
  assert.match(current.presentation.currentProgress, /DELIVERY_REMOTE_UNAVAILABLE/);
  assert.match(current.presentation.currentProgress, /原开发AI/);
});

test("independent test failure atomically returns task to developer and releases tester", async (t) => {
  const { fixture, base } = await startFixture(t);
  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "test-ai-fail", sessionId: "sess-test-fail" });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-test-fail",
    "--actor-type", "test_ai", "--actor-id", "test-ai-fail"
  ]);
  const result = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "T-01",
    "--result", "fail", "--report", "reports/T-01/fail.md", "--note", "发现缺陷",
    "--actor-type", "test_ai", "--actor-id", "test-ai-fail", "--session-id", "sess-test-fail"
  ])).stdout);
  assert.equal(result.after.status, "测试失败待修复");
  assert.equal(result.after.plannedRole, "开发AI");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
});

test("independent test pass defaults to system auto-close for an unscoped task", async (t) => {
  const { fixture, base } = await startFixture(t);
  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "test-ai-pass", sessionId: "sess-test-pass" });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-test-pass",
    "--actor-type", "test_ai", "--actor-id", "test-ai-pass"
  ]);
  const result = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "T-01",
    "--result", "pass", "--report", "reports/T-01/pass.md", "--note", "独测通过，无真实交付动作",
    "--actor-type", "test_ai", "--actor-id", "test-ai-pass", "--session-id", "sess-test-pass"
  ])).stdout);
  assert.equal(result.after.status, "已完成");
  assert.equal(result.after.plannedRole, "");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
});
