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

test("taskctl stop and ack-stop complete cooperative HOLD handshake", async (t) => {
  const { fixture, base } = await startFixture(t);
  const stopped = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "stop", "--project", "fixture", "--task", "B-10", "--note", "please stop"
  ])).stdout);
  assert.equal(stopped.stopRequested, true);

  const guarded = await assert.rejects(
    taskctl(fixture.boardRoot, base, ["guard", "--project", "fixture", "--task", "B-10"]),
    (error) => error.code === 3
  );
  void guarded;

  const acknowledged = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "ack-stop", "--project", "fixture", "--task", "B-10", "--note", "released"
  ])).stdout);
  assert.equal(acknowledged.after.status, "HOLD");

  const task = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "B-10"
  ])).stdout);
  assert.equal(task.stop.stopRequested, false);
});

test("taskctl transition atomically hands development to independent test", async (t) => {
  const { fixture, base } = await startFixture(t);
  const handedOff = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "B-10",
    "--status", "待独测", "--event-type", "handoff",
    "--actor-id", "dev-1", "--session-id", "wc_sess_test"
  ])).stdout);
  assert.equal(handedOff.after.status, "待独测");
  assert.equal(handedOff.after.plannedRole, "独立测试AI");
  assert.equal(handedOff.after.assignee, "");
  assert.equal(handedOff.after.sessionWindowName, "");
  assert.equal(handedOff.after.sessionId, "");
});

test("taskctl transition atomically hands repair to retest", async (t) => {
  const { fixture, base } = await startFixture(t);
  const registry = await fs.readFile(fixture.registryPath, "utf8");
  await fs.writeFile(fixture.registryPath, registry.replace("| B-10 | F-022 | infrastructure | P0 | 开发中 |", "| B-10 | F-022 | infrastructure | P0 | 修复中 |"), "utf8");

  const handedOff = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "B-10",
    "--status", "待复测", "--event-type", "handoff",
    "--actor-id", "dev-1", "--session-id", "wc_sess_test"
  ])).stdout);
  assert.equal(handedOff.after.status, "待复测");
  assert.equal(handedOff.after.plannedRole, "独立测试AI");
  assert.equal(handedOff.after.assignee, "");
  assert.equal(handedOff.after.sessionWindowName, "");
  assert.equal(handedOff.after.sessionId, "");
});

test("taskctl generic transition cannot bypass the atomic independent test-result flow", async (t) => {
  const { fixture, base } = await startFixture(t);
  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "tester-evidence", sessionId: "sess-evidence" });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-evidence",
    "--actor-type", "test_ai", "--actor-id", "tester-evidence"
  ]);
  await assert.rejects(() => taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "T-01", "--status", "待准备",
    "--actor-type", "test_ai", "--actor-id", "tester-evidence", "--session-id", "sess-evidence"
  ]), (error) => {
    assert.match(error.stderr, /ATOMIC_TEST_RESULT_REQUIRED/);
    return true;
  });
  const current = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "get", "--project", "fixture", "--task", "T-01"
  ])).stdout);
  assert.equal(current.status, "独测中");
  assert.equal(current.assignee, "Independent Tester");
  assert.equal(current.sessionId, "sess-evidence");
});

test("taskctl generic transition derives user role for decision waiting", async (t) => {
  const { fixture, base } = await startFixture(t);
  const moved = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "T-01", "--status", "待确认"
  ])).stdout);
  assert.equal(moved.after.status, "待确认");
  assert.equal(moved.after.plannedRole, "用户");
  assert.equal(moved.after.assignee, "");
  assert.equal(moved.after.sessionId, "");
});

test("taskctl generic transition clears test ownership when moving to HOLD", async (t) => {
  const { fixture, base } = await startFixture(t);
  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "tester-hold", sessionId: "sess-hold" });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-hold",
    "--actor-type", "test_ai", "--actor-id", "tester-hold"
  ]);
  const moved = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "T-01", "--status", "HOLD",
    "--actor-type", "test_ai", "--actor-id", "tester-hold", "--session-id", "sess-hold"
  ])).stdout);
  assert.equal(moved.after.status, "HOLD");
  assert.equal(moved.after.plannedRole, "");
  assert.equal(moved.after.assignee, "");
  assert.equal(moved.after.sessionWindowName, "");
  assert.equal(moved.after.sessionId, "");
});

test("taskctl generic transition cannot enter execution stage without claim identity", async (t) => {
  const { fixture, base } = await startFixture(t);
  await assert.rejects(
    taskctl(fixture.boardRoot, base, [
      "transition", "--project", "fixture", "--task", "A-10", "--status", "开发中"
    ]),
    (error) => {
      assert.match(error.stderr, /FORMAL_CLAIM_REQUIRED/);
      return true;
    }
  );
});

test("taskctl reply-user links an AI reply to a specific user message", async (t) => {
  const { fixture, base } = await startFixture(t);
  const browserReview = await fetch(base + "/api/projects/fixture/tasks/A-10/review", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "test.reply-user.browser-comment",
      action: "comment",
      note: "请AI回复这个问题"
    })
  });
  assert.equal(browserReview.status, 200, "user message must originate from the browser review route");
  const review = await browserReview.json();
  const eventId = review.event.event_id;

  const reply = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "reply-user", "--project", "fixture", "--task", "A-10",
    "--message", eventId, "--note", "已回复",
    "--actor-id", "dev-1", "--session-id", "sess-1"
  ])).stdout);
  assert.equal(reply.event.metadata.replyToEventId, eventId);
});


test("taskctl guard and preflight prioritize pending requirement intake", async (t) => {
  const { fixture, base } = await startFixture(t);
  const { RequirementStore } = await import("../server/requirement-store.mjs");
  const store=await new RequirementStore(fixture.boardRoot).init();
  const created=await store.create("fixture",{operationId:"req.cli.create.001",text:"先处理这个需求",actorId:"local-admin"});

  await assert.rejects(
    taskctl(fixture.boardRoot,base,["guard","--project","fixture","--task","A-10","--actor-id","dev","--session-id","sess"]),
    (error)=>{
      assert.equal(error.code,5);
      assert.match(error.stdout,/待AI拆解/);
      return true;
    }
  );

  await assert.rejects(
    taskctl(fixture.boardRoot,base,[
      "changed","--project","fixture","--task","A-10","--kind","code","--paths","a.js","--note","should block",
      "--actor-id","dev","--session-id","sess"
    ]),
    (error)=>{
      assert.match(error.stderr,/REQUIREMENT_INTAKE_PENDING/);
      return true;
    }
  );

  const replied=JSON.parse((await taskctl(fixture.boardRoot,base,[
    "requirement-reply","--project","fixture","--requirement",created.requirement.id,
    "--note","已收到","--actor-id","dev","--session-id","sess"
  ])).stdout);
  assert.equal(replied.message.note,"已收到");

  const done=JSON.parse((await taskctl(fixture.boardRoot,base,[
    "requirement-status","--project","fixture","--requirement",created.requirement.id,
    "--status","已拆解","--plans","账号登录与权限开发计划.md","--tasks","A-10","--key-files","server/auth.mjs",
    "--note","已拆解","--actor-id","dev","--session-id","sess"
  ])).stdout);
  assert.equal(done.requirement.status,"已拆解");

  const changed=JSON.parse((await taskctl(fixture.boardRoot,base,[
    "changed","--project","fixture","--task","A-10","--kind","code","--paths","a.js","--note","now allowed",
    "--actor-id","dev","--session-id","sess"
  ])).stdout);
  assert.equal(changed.event.event_type,"code_change");
});

test("requirement cannot be marked decomposed when referenced task is missing from the same project", async (t) => {
  const { fixture, base } = await startFixture(t);
  const { RequirementStore } = await import("../server/requirement-store.mjs");
  const store = await new RequirementStore(fixture.boardRoot).init();
  const created = await store.create("fixture", {
    operationId: "req.cli.missing.create.001",
    text: "拆解后必须绑定真实任务",
    actorId: "local-admin"
  });

  await assert.rejects(
    taskctl(fixture.boardRoot, base, [
      "requirement-status", "--project", "fixture", "--requirement", created.requirement.id,
      "--status", "已拆解", "--plans", "测试计划.md", "--tasks", "NOT-EXISTS-001",
      "--key-files", "server/example.mjs", "--note", "不应成功",
      "--actor-id", "dev", "--session-id", "sess"
    ]),
    (error) => {
      assert.match(error.stderr, /REQUIREMENT_TASK_REFERENCE_INVALID|需求关联任务不存在于当前项目/);
      return true;
    }
  );

  const pending = JSON.parse((await taskctl(fixture.boardRoot, base, ["requirements", "--project", "fixture"])).stdout);
  const latest = pending.items.find((item) => item.id === created.requirement.id);
  assert.equal(latest.status, "待AI拆解");
  assert.deepEqual(latest.taskIds, []);
});
