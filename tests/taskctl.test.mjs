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

test("taskctl reads project list and guard through bearer auth", async (t) => {
  const { fixture, base } = await startFixture(t);
  const projects = JSON.parse((await taskctl(fixture.boardRoot, base, ["projects"])).stdout);
  assert.equal(projects.projects[0].id, "fixture");

  const guard = JSON.parse((await taskctl(fixture.boardRoot, base, ["guard", "--project", "fixture", "--task", "B-10"])).stdout);
  assert.equal(guard.status, "开发中");
  assert.equal(guard.stopRequested, false);
});

test("taskctl create defaults to system and supports explicit user UI/business scope", async (t) => {
  const { fixture, base } = await startFixture(t);
  const createArgs = [
    "create", "--project", "fixture", "--task", "SAFE-CREATE-001",
    "--parent", "安全创建任务", "--track", "product", "--priority", "P0",
    "--status", "待开发", "--planned-role", "开发AI",
    "--boundary", "说明包含普通竖线 A | B，也必须保持注册表列数稳定",
    "--plan", "测试计划.md", "--traceability", "tests/taskctl.test.mjs",
    "--read-dependencies", "read/SAFE-CREATE-001.md",
    "--write-targets", "write/SAFE-CREATE-001.js",
    "--targets", "cp/SAFE-CREATE-001.md；reports/SAFE-CREATE-001/"
  ];
  const created = JSON.parse((await taskctl(fixture.boardRoot, base, createArgs)).stdout);
  assert.equal(created.taskId, "SAFE-CREATE-001");
  assert.equal(created.task.boundary, "说明包含普通竖线 A | B，也必须保持注册表列数稳定");

  const loaded = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "SAFE-CREATE-001"
  ])).stdout);
  assert.equal(loaded.id, "SAFE-CREATE-001");
  assert.equal(loaded.writeTargets, "write/SAFE-CREATE-001.js");
  assert.equal(loaded.acceptanceScope, "system", "unscoped tasks default to system regardless of track");

  const uiArgs = [...createArgs];
  uiArgs[uiArgs.indexOf("--task") + 1] = "SAFE-CREATE-UI-001";
  uiArgs.push("--acceptance-scope", "user_ui_business");
  await taskctl(fixture.boardRoot, base, uiArgs);
  const uiLoaded = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "SAFE-CREATE-UI-001"
  ])).stdout);
  assert.equal(uiLoaded.acceptanceScope, "user_ui_business");

  const waitingArgs = [...createArgs];
  waitingArgs[waitingArgs.indexOf("--task") + 1] = "SAFE-CREATE-WAITING-UI-001";
  waitingArgs[waitingArgs.indexOf("--status") + 1] = "待用户验收";
  waitingArgs[waitingArgs.indexOf("--planned-role") + 1] = "用户";
  waitingArgs.push("--acceptance-scope", "user_ui_business");
  await assert.rejects(
    taskctl(fixture.boardRoot, base, waitingArgs),
    (error) => { assert.match(error.stderr, /新任务不能直接创建为待用户验收/); return true; }
  );

  const waitingSystemArgs = [...createArgs];
  waitingSystemArgs[waitingSystemArgs.indexOf("--task") + 1] = "SAFE-CREATE-WAITING-SYSTEM-001";
  waitingSystemArgs[waitingSystemArgs.indexOf("--status") + 1] = "待用户验收";
  waitingSystemArgs[waitingSystemArgs.indexOf("--planned-role") + 1] = "用户";
  await assert.rejects(
    taskctl(fixture.boardRoot, base, waitingSystemArgs),
    (error) => { assert.match(error.stderr, /新任务不能直接创建为待用户验收/); return true; }
  );

  const registry = await fs.readFile(fixture.registryPath, "utf8");
  assert.match(registry, /A \\| B/);
  const parsed = parseRegistryText(registry, { defaultTrack: "product", trackOverrides: { "B-10": "infrastructure" } });
  assert.equal(parsed.headers.length, 16);
  assert.ok(parsed.tasks.some((task) => task.id === "SAFE-CREATE-001"));

  await assert.rejects(
    taskctl(fixture.boardRoot, base, createArgs),
    (error) => { assert.match(error.stderr, /任务ID重复/); return true; }
  );
});

test("taskctl project-scoped commands require explicit --project and fail without side effects", async (t) => {
  const { fixture, base } = await startFixture(t);
  const before = await fs.readFile(fixture.registryPath, "utf8");

  await assert.rejects(
    taskctl(fixture.boardRoot, base, [
      "create", "--task", "WRONG-PROJECT-001",
      "--parent", "不应创建", "--track", "product", "--priority", "P0",
      "--status", "待开发", "--planned-role", "开发AI",
      "--boundary", "不应写入", "--plan", "测试计划.md",
      "--traceability", "tests/taskctl.test.mjs",
      "--write-targets", "write/nope.js", "--targets", "cp/nope.md"
    ]),
    (error) => {
      assert.match(error.stderr, /PROJECT_REQUIRED|必须显式指定 --project/);
      return true;
    }
  );

  await assert.rejects(
    taskctl(fixture.boardRoot, base, ["guard", "--task", "B-10"]),
    (error) => {
      assert.match(error.stderr, /PROJECT_REQUIRED|必须显式指定 --project/);
      return true;
    }
  );

  const after = await fs.readFile(fixture.registryPath, "utf8");
  assert.equal(after, before);
});
test("taskctl generic event and developer self-test default to developer_ai", async (t) => {
  const { fixture, base } = await startFixture(t);
  const event = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "event", "--project", "fixture", "--task", "B-10",
    "--event-type", "developer_note", "--note", "hello"
  ])).stdout);
  assert.equal(event.event.actor_type, "developer_ai");
  assert.equal(event.event.note, "hello", "generic task events must preserve the supplied note");

  const started = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "test-start", "--project", "fixture", "--task", "B-10", "--note", "self test"
  ])).stdout);
  assert.equal(started.event.actor_type, "developer_ai");
});

test("taskctl independent test identity must be explicit", async (t) => {
  const { fixture, base } = await startFixture(t);
  await assert.rejects(
    taskctl(fixture.boardRoot, base, [
      "test-start", "--project", "fixture", "--task", "B-10",
      "--actor-type", "test_ai", "--note", "independent"
    ]),
    (error) => {
      assert.match(error.stderr, /--actor-id is required for independent test/);
      return true;
    }
  );
});

test("taskctl ack-user infers test_ai during independent test stages", async (t) => {
  const { fixture, base } = await startFixture(t);
  const userComment = await fetch(base + "/api/projects/fixture/tasks/T-01/review", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "test.ack-user.browser-comment",
      action: "comment",
      note: "独测前请先阅读"
    })
  });
  assert.equal(userComment.status, 200, "user review must originate from a local browser session");

  const acknowledged = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "ack-user", "--project", "fixture", "--task", "T-01",
    "--actor-id", "test-ai-1", "--session-id", "sess-test-1"
  ])).stdout);
  assert.equal(acknowledged.event.actor_type, "test_ai");
  assert.equal(acknowledged.event.metadata.scope, "test_ai|test-ai-1|sess-test-1");
  assert.equal(acknowledged.userMessages.unreadCount, 0);

  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "test-ai-1", sessionId: "sess-test-1" });
  const claimed = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-test-1",
    "--actor-type", "test_ai", "--actor-id", "test-ai-1"
  ])).stdout);
  assert.equal(claimed.after.status, "独测中");
});
test("claim requires a current preclaim report from the same actor and session", async (t) => {
  const { fixture, base } = await startFixture(t);
  const claimArgs = [
    "claim", "--project", "fixture", "--task", "A-10",
    "--assignee", "Developer", "--session-name", "开发窗口",
    "--session-id", "sess-preclaim", "--actor-id", "dev-preclaim"
  ];

  await assert.rejects(
    taskctl(fixture.boardRoot, base, claimArgs),
    (error) => {
      assert.match(error.stderr, /PRECLAIM_REPORT_REQUIRED|认领前必须先向用户汇报/);
      return true;
    }
  );

  const reported = await preclaim(fixture.boardRoot, base, "A-10", {
    actorId: "dev-preclaim", sessionId: "sess-preclaim"
  });
  assert.equal(reported.preclaimReport.valid, true);

  const guard = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "guard", "--project", "fixture", "--task", "A-10",
    "--actor-id", "dev-preclaim", "--session-id", "sess-preclaim"
  ])).stdout);
  assert.equal(guard.preclaimReport.valid, true);

  await taskctl(fixture.boardRoot, base, [
    "priority", "--project", "fixture", "--task", "A-10",
    "--value", "P1", "--actor-id", "dev-preclaim", "--session-id", "sess-preclaim"
  ]);

  await assert.rejects(
    taskctl(fixture.boardRoot, base, claimArgs),
    (error) => {
      assert.match(error.stderr, /PRECLAIM_REPORT_REQUIRED|task_changed|认领前必须先向用户汇报/);
      return true;
    }
  );

  await preclaim(fixture.boardRoot, base, "A-10", {
    actorId: "dev-preclaim", sessionId: "sess-preclaim"
  });
  const claimed = JSON.parse((await taskctl(fixture.boardRoot, base, claimArgs)).stdout);
  assert.equal(claimed.after.status, "开发中");
});
