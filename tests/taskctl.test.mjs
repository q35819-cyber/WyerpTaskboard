import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createTaskboardServer } from "../server/http-server.mjs";
import { parseRegistryText } from "../server/adapters/markdown-task-registry-v1.mjs";
import { makeFixture } from "./helpers.mjs";

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
  return execFileAsync(process.execPath, [taskctlPath, ...args], {
    cwd: path.resolve("."),
    windowsHide: true,
    env: {
      ...process.env,
      WYERP_TASKBOARD_ROOT: rootDir,
      WYERP_TASKBOARD_URL: base,
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

test("taskctl create safely appends a structured 16-column task", async (t) => {
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

  const started = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "test-start", "--project", "fixture", "--task", "B-10", "--note", "self test"
  ])).stdout);
  assert.equal(started.event.actor_type, "developer_ai");
});

test("developer self-test retains explicit immutable commit metadata without granting QA PASS", async (t) => {
  const { fixture, base } = await startFixture(t);
  const sha = "a".repeat(40), hash = "b".repeat(64);
  const submitted = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "B-10",
    "--result", "pass", "--report", "synthetic/self-test.md",
    "--actor-type", "developer_ai", "--actor-id", "dev-binding-1",
    "--commit-sha", sha, "--head-branch", "fix/B-10-self-test",
    "--report-sha256", hash
  ])).stdout);
  assert.equal(submitted.event.actor_type, "developer_ai");
  assert.equal(submitted.event.metadata.commitSha, sha);
  assert.equal(submitted.event.metadata.headBranch, "fix/B-10-self-test");
  assert.equal(submitted.event.metadata.reportSha256, hash);
  assert.equal(submitted.event.metadata.testResult, "pass");
  assert.equal(submitted.event.metadata.reportPath, "synthetic/self-test.md");
  assert.notEqual(submitted.event.metadata.atomicLifecycle, true);
  await assert.rejects(taskctl(fixture.boardRoot, base, [
    "test-result", "--project", "fixture", "--task", "B-10",
    "--result", "pass", "--report", "synthetic/self-test.md",
    "--actor-type", "developer_ai", "--commit-sha", "invalid"
  ]), error => {
    assert.match(error.stderr, /--commit-sha must be a 40-character SHA/);
    return true;
  });
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
  await taskctl(fixture.boardRoot, base, [
    "event", "--project", "fixture", "--task", "T-01",
    "--event-type", "user_review", "--actor-type", "user", "--actor-id", "local-admin", "--note", "独测前请先阅读"
  ]);

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

test("taskctl generic transition normalizes test evidence fallback", async (t) => {
  const { fixture, base } = await startFixture(t);
  await preclaim(fixture.boardRoot, base, "T-01", { actorType: "test_ai", actorId: "tester-evidence", sessionId: "sess-evidence" });
  await taskctl(fixture.boardRoot, base, [
    "claim", "--project", "fixture", "--task", "T-01",
    "--assignee", "Independent Tester", "--session-name", "独测窗口", "--session-id", "sess-evidence",
    "--actor-type", "test_ai", "--actor-id", "tester-evidence"
  ]);
  const moved = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "transition", "--project", "fixture", "--task", "T-01", "--status", "待准备",
    "--actor-type", "test_ai", "--actor-id", "tester-evidence", "--session-id", "sess-evidence"
  ])).stdout);
  assert.equal(moved.after.status, "待准备");
  assert.equal(moved.after.plannedRole, "开发AI");
  assert.equal(moved.after.assignee, "");
  assert.equal(moved.after.sessionWindowName, "");
  assert.equal(moved.after.sessionId, "");
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
      assert.match(error.stderr, /EXECUTION_IDENTITY_REQUIRED/);
      return true;
    }
  );
});

test("taskctl reply-user links an AI reply to a specific user message", async (t) => {
  const { fixture, base } = await startFixture(t);
  const review = JSON.parse((await taskctl(fixture.boardRoot, base, [
    "review", "--project", "fixture", "--task", "A-10",
    "--action", "comment", "--note", "请AI回复这个问题"
  ])).stdout);
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

test("independent test pass can explicitly skip empty delivery and move to user acceptance", async (t) => {
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
    "--delivery-mode", "user_acceptance",
    "--actor-type", "test_ai", "--actor-id", "test-ai-pass", "--session-id", "sess-test-pass"
  ])).stdout);
  assert.equal(result.after.status, "待用户验收");
  assert.equal(result.after.plannedRole, "用户");
  assert.equal(result.after.assignee, "");
  assert.equal(result.after.sessionId, "");
});
