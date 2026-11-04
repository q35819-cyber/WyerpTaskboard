import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../server/task-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

let sequence = 0;
const row = (id, status, { owner = "—", session = "—", dependencies = "" } = {}) =>
  [id, "F-" + id, "bugfix", "P0", status,
    ["独测中", "待独测"].includes(status) ? "独立测试AI" : "开发AI",
    owner, "—", session, "—", "fixture", "plan.md", "trace/" + id,
    dependencies, "src/" + id + ".mjs", "cp/" + id + ".md"];

async function setup(t, rows) {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const store = await new TaskStore(fixture.boardRoot).init();
  const evaluator = new CandidateEvaluator(fixture.boardRoot, {
    taskStore: store, requirementStore: { pending: async () => ({ pendingCount: 0, waitingUserCount: 0 }) }
  });
  return { ...fixture, store, evaluator };
}

async function change(store, id, patch, eventType, metadata = {}, actorType = "system", sessionId = "") {
  const { snapshot } = await store.getTask("fixture", id);
  return store.updateTask("fixture", id, patch, {
    expectedRevision: snapshot.registryRevision,
    operationId: "autounblock.fixture." + (++sequence),
    eventType, actorType, actorId: "fixture-actor", sessionId, metadata
  });
}

async function block(store, id, conditions) {
  return change(store, id, { status: "阻断", assignee: "", sessionId: "" },
    "temporary_block", { conditions });
}
const status = async (store, id) => (await store.getTask("fixture", id)).task.status;

test("prepared developer is restored to ready only after every real hard prerequisite is complete", async (t) => {
  const { store, evaluator } = await setup(t, [
    row("A-10", "待准备", { dependencies: "B-10完成;C-10完成" }),
    row("B-10", "已完成"),
    row("C-10", "独测中", { owner: "tester", session: "qa-session" })
  ]);
  await block(store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断", "another unfinished hard dependency must prevent release");
  await change(store, "C-10", { status: "已完成", assignee: "", sessionId: "", sessionWindowName: "" },
    "test_result", { atomicLifecycle: true, testResult: "pass", acceptanceScope: "system",
      reportPath: "reports/C-10/PASS.md", deliveryActions: [] }, "test_ai", "qa-session");
  const scan = await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "待开发");
  const candidate = scan.candidates.find((item) => item.task_id === "A-10");
  assert.equal(candidate.eligible, true);
  assert.equal(candidate.auto_unblocked_bug, true);
  assert.equal(candidate.priority, "P0");
  await evaluator.evaluateProject("fixture");
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  const unblock = history.filter((item) => item.event_type === "auto_unblock");
  assert.equal(unblock.length, 1);
  assert.equal(unblock[0].old_status, "阻断");
  assert.equal(unblock[0].new_status, "待开发");
  assert.equal((await store.transactions.read(unblock[0].operation_id))?.state, "committed");
});

test("prepared developer without declared write targets remains blocked after machine conditions pass", async (t) => {
  const missingWrites = row("A-10", "待准备", { dependencies: "B-10完成" });
  missingWrites[14] = "";
  const { store, evaluator } = await setup(t, [missingWrites, row("B-10", "已完成")]);
  await block(store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");
  assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
    .filter((item) => item.event_type === "auto_unblock").length, 0);
});

test("machine-confirmed prerequisite completion automatically restores the original eligible stage once", async (t) => {
  const { store, evaluator } = await setup(t, [
    row("A-10", "待开发", { dependencies: "B-10完成" }),
    row("B-10", "独测中", { owner: "tester", session: "test-session" })
  ]);
  await block(store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");

  await change(store, "B-10", {
    status: "已完成", assignee: "", sessionId: "", sessionWindowName: ""
  }, "test_result", {
    atomicLifecycle: true, testResult: "pass", reportPath: "reports/B-10/PASS.md",
    acceptanceScope: "system", deliveryActions: []
  }, "test_ai", "test-session");
  await Promise.all([
    evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")
  ]);
  assert.equal(await status(store, "A-10"), "待开发");
  const evaluated = await evaluator.evaluateProject("fixture");
  assert.equal(evaluated.candidates.find((c) => c.task_id === "A-10").eligible, true);
  await Promise.all([evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")]);
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  assert.equal(history.filter((event) => event.event_type === "auto_unblock").length, 1);
});

test("authentic developer full-suite pause resumes after its recorded requiredTask completes", async (t) => {
  const { store, evaluator } = await setup(t, [
    row("A-10", "开发中", { owner: "dev", session: "dev-session" }),
    row("B-10", "独测中", { owner: "tester", session: "qa-session" })
  ]);
  await store.appendTaskEvent("fixture", "A-10", {
    operationId: "claim.pause.fixture." + (++sequence), eventType: "claim", actorType: "developer_ai",
    actorId: "fixture-actor", sessionId: "dev-session"
  });
  await change(store, "A-10", { status: "阻断", assignee: "", sessionId: "" },
    "developer_paused_for_independent_full_suite_gate",
    { requiredTask: "B-10", candidateSha: "a".repeat(40) }, "developer_ai", "dev-session");
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");
  await change(store, "B-10", { status: "已完成", assignee: "", sessionId: "" },
    "test_result", { atomicLifecycle: true, testResult: "pass", acceptanceScope: "system",
      reportPath: "reports/B-10/QA-PASS.md", deliveryActions: [] }, "test_ai", "qa-session");
  await Promise.all([evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")]);
  assert.equal(await status(store, "A-10"), "待开发");
  const latest = await evaluator.evaluateProject("fixture");
  assert.equal(latest.candidates.find(item => item.task_id === "A-10")?.eligible, true);
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  assert.equal(history.filter(event => event.event_type === "auto_unblock").length, 1);
});

test("unclaimed, unknown and stopped developer pauses cannot auto-resume", async (t) => {
  const rows = [row("A-10", "开发中", { owner: "dev", session: "dev-session" }), row("B-10", "已完成")];
  const forged = await setup(t, rows);
  await change(forged.store, "A-10", { status: "阻断", assignee: "", sessionId: "" },
    "developer_paused_for_independent_full_suite_gate", { requiredTask: "B-10" },
    "developer_ai", "dev-session");
  await forged.evaluator.evaluateProject("fixture");
  assert.equal(await status(forged.store, "A-10"), "阻断", "an unclaimed pause is not proof");

  const invalid = await setup(t, rows);
  await invalid.store.appendTaskEvent("fixture", "A-10", {
    operationId: "claim.invalidpause.fixture." + (++sequence), eventType: "claim",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "dev-session"
  });
  await change(invalid.store, "A-10", { status: "阻断", assignee: "", sessionId: "" },
    "developer_paused_for_independent_full_suite_gate", { requiredTask: "UNKNOWN" },
    "developer_ai", "dev-session");
  await invalid.evaluator.evaluateProject("fixture");
  assert.equal(await status(invalid.store, "A-10"), "阻断");

  const stopped = await setup(t, rows);
  await stopped.store.appendTaskEvent("fixture", "A-10", {
    operationId: "claim.stoppedpause.fixture." + (++sequence), eventType: "claim",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "dev-session"
  });
  await change(stopped.store, "A-10", { status: "阻断", assignee: "", sessionId: "" },
    "developer_paused_for_independent_full_suite_gate", { requiredTask: "B-10" },
    "developer_ai", "dev-session");
  await stopped.store.appendTaskEvent("fixture", "A-10", {
    operationId: "stop.pause.fixture." + (++sequence), eventType: "stop_request", actorType: "user"
  });
  await stopped.evaluator.evaluateProject("fixture");
  assert.equal(await status(stopped.store, "A-10"), "阻断");
});

test("unknown proof, manual block, unfulfilled dependency and pending STOP never auto-resume", async (t) => {
  const { store, evaluator } = await setup(t, [
    row("A-10", "待开发", { dependencies: "B-10完成" }),
    row("B-10", "已完成")
  ]);
  await block(store, "A-10", [{ kind: "unexpected_verbal_proof", taskId: "B-10" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");

  const { store: stoppedStore, evaluator: stoppedEval } = await setup(t, [
    row("A-10", "待开发", { dependencies: "B-10完成" }), row("B-10", "已完成")
  ]);
  await block(stoppedStore, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await stoppedStore.appendTaskEvent("fixture", "A-10", {
    operationId: "stop.fixture." + (++sequence), eventType: "stop_request", actorType: "user", note: "暂停"
  });
  await stoppedEval.evaluateProject("fixture");
  assert.equal(await status(stoppedStore, "A-10"), "阻断");

  const { store: manualStore, evaluator: manualEval } = await setup(t, [
    row("A-10", "待开发", { dependencies: "B-10完成" }), row("B-10", "已完成")
  ]);
  await change(manualStore, "A-10", { status: "阻断" }, "status_change", {
    conditions: [{ kind: "dependency_completed", taskId: "B-10" }]
  });
  await manualEval.evaluateProject("fixture");
  assert.equal(await status(manualStore, "A-10"), "阻断");
});

test("old QA FAIL cannot be erased by a machine condition", async (t) => {
  const { store, evaluator } = await setup(t, [
    row("A-10", "待独测", { dependencies: "B-10完成" }), row("B-10", "已完成")
  ]);
  await store.appendTaskEvent("fixture", "A-10", {
    operationId: "qa.fail.fixture." + (++sequence), eventType: "test_result",
    actorType: "test_ai", sessionId: "prior-tester", metadata: { testResult: "fail" }
  });
  await block(store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");
});

test("QA resumption requires an authentic, non-invalidated developer handoff", async (t) => {
  const noHandoff = await setup(t, [
    row("A-10", "待独测", { dependencies: "B-10完成" }), row("B-10", "已完成")
  ]);
  await block(noHandoff.store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await noHandoff.evaluator.evaluateProject("fixture");
  assert.equal(await status(noHandoff.store, "A-10"), "阻断");

  const valid = await setup(t, [
    row("A-10", "开发中", {
      owner: "original-developer", session: "original-session", dependencies: "B-10完成"
    }),
    row("B-10", "已完成")
  ]);
  await change(valid.store, "A-10", {
    status: "待独测", assignee: "", sessionId: "", sessionWindowName: ""
  }, "handoff", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  }, "developer_ai", "original-session");
  await block(valid.store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  await valid.evaluator.evaluateProject("fixture");
  assert.equal(await status(valid.store, "A-10"), "待独测");
});

test("a released developer Session cannot bypass a still reserved QA write scope", async (t) => {
  const a = row("A-10", "待开发", { dependencies: "env/ready.marker" });
  const b = row("B-10", "待独测");
  b[14] = a[14];
  const { store, evaluator, projectRoot } = await setup(t, [a, b]);
  await fs.mkdir(path.join(projectRoot, "env"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "env/ready.marker"), "ready");
  await block(store, "A-10", [{ kind: "required_file_exists", path: "env/ready.marker" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");
});

test("machine-rechecked required file and genuinely released ownership can resume", async (t) => {
  const { store, evaluator, projectRoot } = await setup(t, [
    row("A-10", "待开发", { dependencies: "env/ready.marker" }), row("B-10", "已完成")
  ]);
  await block(store, "A-10", [{ kind: "required_file_exists", path: "env/ready.marker" }]);
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "阻断");
  await fs.mkdir(path.join(projectRoot, "env"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "env/ready.marker"), "ready");
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "待开发");

  const released = await setup(t, [
    row("A-10", "待开发"), row("B-10", "开发中", { owner: "old-dev", session: "old-session" })
  ]);
  await released.store.appendTaskEvent("fixture", "B-10", {
    operationId: "claim.fixture." + (++sequence), eventType: "claim",
    actorType: "developer_ai", actorId: "old-dev", sessionId: "old-session"
  });
  await block(released.store, "A-10", [
    { kind: "owner_released", taskId: "B-10", sessionId: "old-session" }
  ]);
  await released.evaluator.evaluateProject("fixture");
  assert.equal(await status(released.store, "A-10"), "阻断");
  await change(released.store, "B-10", {
    status: "待独测", assignee: "", sessionId: "", sessionWindowName: ""
  }, "handoff", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  }, "developer_ai", "old-session");
  await released.evaluator.evaluateProject("fixture");
  assert.equal(await status(released.store, "A-10"), "待开发");
});

test("registry-written interruption replays exactly one recovery event on next scan", async (t) => {
  const { store, evaluator, boardRoot } = await setup(t, [
    row("A-10", "待开发", { dependencies: "B-10完成" }), row("B-10", "已完成")
  ]);
  await block(store, "A-10", [{ kind: "dependency_completed", taskId: "B-10" }]);
  const crashingStore = await new TaskStore(boardRoot, { faultAfter: "registry_written" }).init();
  const interrupted = new CandidateEvaluator(boardRoot, {
    taskStore: crashingStore,
    requirementStore: { pending: async () => ({ pendingCount: 0, waitingUserCount: 0 }) }
  });
  await assert.rejects(() => interrupted.evaluateProject("fixture"),
    (error) => error.code === "INJECTED_CRASH");
  assert.equal(await status(store, "A-10"), "待开发");
  assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
    .filter((event) => event.event_type === "auto_unblock").length, 0);
  await evaluator.evaluateProject("fixture");
  await evaluator.evaluateProject("fixture");
  assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
    .filter((event) => event.event_type === "auto_unblock").length, 1);
});
