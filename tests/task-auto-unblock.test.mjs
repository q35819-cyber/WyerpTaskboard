import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TaskStore } from "../server/task-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";
import { TaskStepCheckpoint } from "../server/task-step-checkpoint.mjs";
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

async function blockedD01(t, { dependency = "", fakeActor = false,
  originalAuthorization = true, withCheckpoint = false } = {}) {
  const f = await setup(t, [row("A-10", "开发中", {
    owner: "developer", session: "dev-session", dependencies: dependency
  }), row("B-10", "已完成")]);
  if (originalAuthorization) await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "d01.earlier.dispatch." + (++sequence), eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session"
  });
  const claim = await change(f.store, "A-10", { status: "开发中", assignee: "developer",
    sessionWindowName: "developer", sessionId: "dev-session" },
  "claim", {}, "developer_ai", "dev-session");
  const checkpoint = withCheckpoint
    ? await new TaskStepCheckpoint(f.boardRoot, { taskStore: f.store, flowVersion: "role-steps-v1" }).init()
    : null;
  if (checkpoint) {
    for (const [stepId, eventId] of [["D01_CLAIM", claim.eventId], ["D02_WORKTREE", null]]) {
      const before = await checkpoint.show("fixture", "A-10");
      await checkpoint.record("fixture", "A-10", {
        operationId: "d01.original.step." + (++sequence),
        expectedSha256: before.sha256, stepId,
        actorType: "developer_ai", actorId: "fixture-actor", sessionId: "dev-session",
        result: "PASS", eventId, evidence: "valid original developer step " + stepId
      });
    }
  }
  const blocked = await change(f.store, "A-10", {
    status: "阻断", assignee: "", sessionId: "", sessionWindowName: ""
  }, "developer_d01_missing_controller_dispatch_block", {}, fakeActor ? "system" : "developer_ai",
  "dev-session");
  return { ...f, blocked, checkpoint };
}

async function dispatchD01(store, actorType = "controller_ai") {
  return store.appendTaskEvent("fixture", "A-10", {
    operationId: "d01.new.dispatch." + (++sequence), eventType: "controller_dispatch",
    actorType, actorId: "controller", sessionId: "ctrl-session",
    note: "新一轮真实派工，不能回填旧claim"
  });
}

const D09_FIX = "WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1";
async function blockedD09(t, { release = true, qaPass = true, published = true,
  dispatch = true, stopped = false, untrustedNote = false,
  unfinished = false, dispatchBeforeRelease = false, unmetHardDependency = false } = {}) {
  const f = await setup(t, [
    row("A-10", "待开发"),
    row(D09_FIX, unfinished ? "待独测" : "已完成")
  ]);
  const git = (...args) => execFileSync("git", ["-C", f.projectRoot, ...args],
    { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "main");
  git("add", "tasks.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "commit", "-m", "D09 published fixture");
  const mainSha = git("rev-parse", "HEAD");
  await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "d09.original.dispatch." + (++sequence),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller-session"
  });
  const claim = await change(f.store, "A-10", {
    status: "开发中", assignee: "old-dev", sessionWindowName: "old-dev",
    sessionId: "old-session"
  }, "claim", {}, "developer_ai", "old-session");
  await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "d09.fail." + (++sequence),
    eventType: "developer_checkpoint_resume_blocked",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "",
    note: "D09_MERGE_MAIN CHECKPOINT_STEP_ORDER "
      + (untrustedNote ? "fabricated" : claim.eventId)
  });
  const blocked = await change(f.store, "A-10", {
    status: "阻断", assignee: "", sessionWindowName: "", sessionId: ""
  }, "developer_step_cursor_blocked", {}, "developer_ai", "");
  if (unmetHardDependency) {
    const lines = (await fs.readFile(f.registryPath, "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => line.startsWith("| A-10 |"));
    const cells = lines[index].split("|");
    cells[14] = " UNFINISHED完成 ";
    lines[index] = cells.join("|");
    await fs.writeFile(f.registryPath, lines.join("\n"));
  }
  const dispatchController = async () => f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "d09.dispatch." + (++sequence),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller-session"
  });
  if (dispatchBeforeRelease) await dispatchController();
  if (qaPass) {
    const qa = await f.store.appendTaskEvent("fixture", D09_FIX, {
      operationId: "d09.qa." + (++sequence), eventType: "test_result",
      actorType: "test_ai", actorId: "qa", sessionId: "qa-session",
      metadata: { atomicLifecycle: true, testResult: "pass",
        commitSha: "a".repeat(40) }
    });
    if (release) await f.store.appendTaskEvent("fixture", D09_FIX, {
      operationId: "d09.delivery." + (++sequence),
      eventType: "delivery_complete", actorType: "controller_ai",
      actorId: "controller", sessionId: "controller-session",
      metadata: { independentPassEventId: qa.event.event_id,
        deliveryVerified: true, postMergeRegressionResult: "PASS",
        candidateCommitSha: "a".repeat(40),
        mergeCommitSha: published ? mainSha : "b".repeat(40),
        remoteMainSha: published ? mainSha : "b".repeat(40) }
    });
  }
  await new Promise((done) => setTimeout(done, 8));
  if (dispatch && !dispatchBeforeRelease) await dispatchController();
  if (stopped) await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "d09.stop." + (++sequence),
    eventType: "stop_request", actorType: "user", actorId: "user",
    note: "用户暂停旧任务"
  });
  return { ...f, blocked, mainSha };
}

test("published D09 fix restores original authorized block without fresh dispatch", async (t) => {
  const { store, evaluator, blocked } = await blockedD09(t, { dispatch: false });
  await Promise.all([evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")]);
  assert.equal(await status(store, "A-10"), "待开发");
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  const events = history.filter((event) => event.event_type === "auto_unblock");
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.blockedEventId, blocked.eventId);
  assert.equal(events[0].metadata.restoreStatus, "待开发");
  assert.equal((await store.transactions.read(events[0].operation_id)).state, "committed");
  const ready = await evaluator.evaluateProject("fixture");
  assert.equal(ready.candidates.find((item) => item.task_id === "A-10")?.auto_unblocked_bug, true);
  await change(store, "A-10", { status: "开发中", assignee: "fresh-dev",
    sessionWindowName: "fresh-dev", sessionId: "fresh-session" },
  "claim", {}, "developer_ai", "fresh-session");
  assert.equal(await status(store, "A-10"), "开发中");
  assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
    .filter((event) => event.event_type === "developer_step_cursor_blocked").length, 1);
});

test("D09 recovery denies missing/forged proof, stale dispatch, unpublished fix and STOP", async (t) => {
  for (const options of [
    { release: false }, { qaPass: false }, { published: false },
    { stopped: true }, { untrustedNote: true }, { unfinished: true },
    { unmetHardDependency: true }
  ]) {
    const { store, evaluator } = await blockedD09(t, options);
    await evaluator.evaluateProject("fixture");
    assert.equal(await status(store, "A-10"), "阻断", JSON.stringify(options));
    assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
      .filter((event) => event.event_type === "auto_unblock").length, 0);
  }
});

test("D01 authorized block recovers without any post-block controller dispatch", async (t) => {
  const { store, evaluator, blocked } = await blockedD01(t);
  const [first, second] = await Promise.all([
    evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")
  ]);
  assert.equal(await status(store, "A-10"), "待开发");
  assert.ok(first.candidates.find(x => x.task_id === "A-10") || second.candidates.find(x => x.task_id === "A-10"));
  await evaluator.evaluateProject("fixture");
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  const unblocks = history.filter(x => x.event_type === "auto_unblock");
  assert.equal(unblocks.length, 1);
  assert.equal(unblocks[0].actor_type, "system");
  assert.equal(unblocks[0].metadata.blockedEventId, blocked.eventId);
  assert.equal(unblocks[0].metadata.restoreStatus, "待开发");
  assert.equal((await store.transactions.read(unblocks[0].operation_id))?.state, "committed");
  const oldClaim = history.find(x => x.event_type === "claim");
  assert.ok(history.findIndex(x => x.event_type === "controller_dispatch")
    < history.findIndex(x => x.event_id === oldClaim.event_id));
  assert.equal(history.filter(x => x.event_type === "controller_dispatch").length, 1,
    "no second human dispatch is required");
  assert.equal(history.filter(x => x.event_type === "claim").length, 1,
    "auto restore must not fabricate a retroactive claim");
});

test("committed auto recovery reopens D01 without fresh dispatch or losing old steps", async (t) => {
  const { store, evaluator, checkpoint } = await blockedD01(t, { withCheckpoint: true });
  const old = await checkpoint.show("fixture", "A-10");
  assert.equal(old.state.cursors.developer_ai, "D03_WRITE_SCOPE");
  await evaluator.evaluateProject("fixture");
  assert.equal(await status(store, "A-10"), "待开发");
  const fresh = await change(store, "A-10", {
    status: "开发中", assignee: "new-developer", sessionWindowName: "new",
    sessionId: "new-session"
  }, "claim", {}, "developer_ai", "new-session");
  const before = await checkpoint.show("fixture", "A-10");
  const result = await checkpoint.record("fixture", "A-10", {
    operationId: "d01.auto.restart." + (++sequence),
    expectedSha256: before.sha256, stepId: "D01_CLAIM",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "new-session",
    result: "PASS", eventId: fresh.eventId, evidence: "confirmed automatic recovery new D01"
  });
  assert.equal(result.state.attempts, old.state.attempts + 1);
  assert.equal(result.state.cursors.developer_ai, "D02_WORKTREE");
  assert.equal(result.state.records.filter((item) => item.stepId === "D02_WORKTREE"
    && item.attempt === old.state.attempts).length, 1);
  const history = await store.taskHistory("fixture", "A-10", { all: true });
  assert.equal(history.filter((item) => item.event_type === "controller_dispatch").length, 1);
});

test("fake system recovery event cannot reset developer D01 cursor", async (t) => {
  const { store, checkpoint, blocked } = await blockedD01(t, { withCheckpoint: true });
  await change(store, "A-10", {
    status: "待开发", assignee: "", sessionId: "", sessionWindowName: ""
  }, "manual_bad_transition");
  await store.appendTaskEvent("fixture", "A-10", {
    operationId: "d01.fake.auto.unblock." + (++sequence),
    eventType: "auto_unblock", actorType: "system", actorId: "task-scan",
    metadata: { blockedEventId: blocked.eventId, restoreStatus: "待开发" }
  });
  const fresh = await change(store, "A-10", {
    status: "开发中", assignee: "fake-developer", sessionWindowName: "fake",
    sessionId: "fake-session"
  }, "claim", {}, "developer_ai", "fake-session");
  const before = await checkpoint.show("fixture", "A-10");
  await assert.rejects(checkpoint.record("fixture", "A-10", {
    operationId: "d01.fake.restart." + (++sequence),
    expectedSha256: before.sha256, stepId: "D01_CLAIM",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "fake-session",
    result: "PASS", eventId: fresh.eventId, evidence: "fake auto recovery must be rejected"
  }), (error) => error.code === "CHECKPOINT_STEP_ORDER");
  assert.equal((await checkpoint.show("fixture", "A-10")).sha256, before.sha256);
});

test("D01 machine restores pending work even when an unrelated QA or delivery task shares source paths", async (t) => {
  for (const otherStatus of ["待独测", "交付中"]) {
    const first = row("A-10", "开发中", { owner: "developer", session: "dev-session" });
    const second = row("B-10", otherStatus, {
      owner: otherStatus === "交付中" ? "controller" : "—",
      session: otherStatus === "交付中" ? "controller-session" : "—"
    });
    second[14] = first[14];
    const { store, evaluator } = await setup(t, [first, second]);
    await store.appendTaskEvent("fixture", "A-10", {
      operationId: "d01.original.dispatch." + (++sequence), eventType: "controller_dispatch",
      actorType: "controller_ai", actorId: "controller", sessionId: "ctrl-session"
    });
    await change(store, "A-10", { status: "开发中", assignee: "developer",
      sessionWindowName: "developer", sessionId: "dev-session" },
    "claim", {}, "developer_ai", "dev-session");
    await change(store, "A-10", {
      status: "阻断", assignee: "", sessionId: "", sessionWindowName: ""
    }, "developer_d01_missing_controller_dispatch_block", {}, "developer_ai", "dev-session");
    await evaluator.evaluateProject("fixture");
    assert.equal(await status(store, "A-10"), "待开发", otherStatus);
    assert.equal(await status(store, "B-10"), otherStatus,
      "machine recovery must not change the unrelated task");
    await evaluator.evaluateProject("fixture");
    assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
      .filter(e => e.event_type === "auto_unblock").length, 1);
  }
});

test("D01 block rejects absent original authorization and wrong block actor", async (t) => {
  for (const options of [{ originalAuthorization: false }, { fakeActor: true }]) {
    const { store, evaluator } = await blockedD01(t, options);
    if (options.originalAuthorization === false) await dispatchD01(store, "developer_ai");
    await evaluator.evaluateProject("fixture");
    assert.equal(await status(store, "A-10"), "阻断");
    assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
      .filter(x => x.event_type === "auto_unblock").length, 0);
  }
});

test("D01 automatic recovery preserves STOP and unresolved user message", async (t) => {
  for (const flag of ["stop", "message"]) {
    const { store, evaluator } = await blockedD01(t);
    if (flag === "stop") await store.appendTaskEvent("fixture", "A-10", {
      operationId: "d01.stop." + (++sequence), eventType: "stop_request",
      actorType: "user", note: "用户阻止自动重开"
    });
    if (flag === "message") await store.appendTaskEvent("fixture", "A-10", {
      operationId: "d01.user." + (++sequence), eventType: "user_review",
      actorType: "user", note: "请先答复这个未处理的问题"
    });
    await evaluator.evaluateProject("fixture");
    assert.equal(await status(store, "A-10"), "阻断");
  }
});

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

const RECOVERY_FIX = "WTB-P0-BLOCKED-DEV-RECOVERY-GATE-20261106-T1";
const RUNNER_STEP_FIX = "WTB-P0-TEST-RUNNER-STEP-CHECKPOINT-TIMEOUT-20261106-T1";
const MODERN_D01_FIX = "WTB-P0-DELIVERY-REWORK-D01-CHECKPOINT-20261106-T1";

async function verifiedDeveloperBlockFixture(t, { kind = "blocked", dispatch = true,
  missingPredecessor = false, missingRootQA = false, missingRootDelivery = false,
  missingRelatedDelivery = false, unrelatedFixPending = false, wrongPublishedSha = false,
  wrongCandidateSha = false,
  stopped = false, wrongMetadata = false, unfinishedDependency = false,
  forgedGenericNote = false } = {}) {
  const relatedFix = ["developer_c06_blocked", "developer_r3_runner_timeout_blocked"].includes(kind)
    ? RUNNER_STEP_FIX : kind === "developer_d07_checkpoint_unauthorized_dependency_block"
      ? MODERN_D01_FIX : null;
  const fixes = [RECOVERY_FIX, ...(relatedFix ? [relatedFix] : [])];
  const f = await setup(t, [
    row("A-10", "待开发"),
    ...fixes.map((id) => row(id, unrelatedFixPending && id === relatedFix ? "待交付" : "已完成")),
    ...(unfinishedDependency ? [row("PENDING", "待开发")] : [])
  ]);
  const git = (...args) => execFileSync("git", ["-C", f.projectRoot, ...args],
    { encoding: "utf8", windowsHide: true }).trim();
  git("init", "-b", "main");
  git("add", "tasks.md");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com",
    "commit", "-m", "trusted developer block fixture");
  const mainSha = git("rev-parse", "HEAD");
  await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "developer.original.dispatch." + (++sequence),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller-session"
  });
  const claim = await change(f.store, "A-10", {
    status: "开发中", assignee: "developer", sessionWindowName: "developer",
    sessionId: "dev-session"
  }, "claim", {}, "developer_ai", "dev-session");
  if (kind === "blocked" && !missingPredecessor) {
    await f.store.appendTaskEvent("fixture", "A-10", {
      operationId: "developer.predecessor.fail." + (++sequence),
      eventType: "developer_claim_checkpoint_predecessor_blocked",
      actorType: "developer_ai", actorId: "fixture-actor", sessionId: "dev-session",
      note: "D01_CLAIM CHECKPOINT_PREDECESSOR_REQUIRED " + claim.eventId
    });
  }
  const metadata = kind === "developer_r3_runner_timeout_blocked" ? {
    failureStage: "D07_TEST_3", failureCode: wrongMetadata ? "UNRELATED_ERROR" :
      "TEST_RUNNER_30S_SPAWNSYNC_ETIMEDOUT",
    blockerCategory: "test_runner", candidateSha: "c".repeat(40)
  } : kind === "developer_d07_checkpoint_unauthorized_dependency_block" ? {
    reasonCode: wrongMetadata ? "UNRELATED_ERROR" : "CHECKPOINT_STEP_ORDER",
    blockedByWriteScope: "server/task-step-checkpoint.mjs",
    candidateWipPreserved: true, candidateSha: "d".repeat(40)
  } : {};
  const blocked = await change(f.store, "A-10", {
    status: "阻断", assignee: "", sessionWindowName: "", sessionId: ""
  }, kind, metadata, "developer_ai", "dev-session");
  if (unfinishedDependency) {
    const lines = (await fs.readFile(f.registryPath, "utf8")).split(/\r?\n/);
    const index = lines.findIndex((line) => line.startsWith("| A-10 |"));
    const cells = lines[index].split("|");
    cells[14] = " PENDING完成 ";
    lines[index] = cells.join("|");
    await fs.writeFile(f.registryPath, lines.join("\n"));
  }
  if (forgedGenericNote) await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "dev.generic.note." + (++sequence), eventType: "developer_comment",
    actorType: "developer_ai", actorId: "fixture-actor", sessionId: "dev-session",
    note: "CHECKPOINT_PREDECESSOR_REQUIRED " + claim.eventId
  });
  for (const fixId of fixes) {
    const qaCommit = wrongCandidateSha && fixId === RECOVERY_FIX ? "e".repeat(40) : mainSha;
    const qa = !missingRootQA || fixId !== RECOVERY_FIX
      ? await f.store.appendTaskEvent("fixture", fixId, {
        operationId: "developer.fix.qa." + (++sequence), eventType: "test_result",
        actorType: "test_ai", actorId: "qa", sessionId: "qa-session",
        metadata: { atomicLifecycle: true, testResult: "pass", commitSha: qaCommit }
      }) : null;
    if ((fixId === RECOVERY_FIX && missingRootDelivery)
      || (fixId === relatedFix && (missingRelatedDelivery || unrelatedFixPending))) continue;
    await f.store.appendTaskEvent("fixture", fixId, {
      operationId: "developer.fix.delivery." + (++sequence),
      eventType: "delivery_complete", actorType: "controller_ai",
      actorId: "controller", sessionId: "controller-session",
      metadata: {
        independentPassEventId: qa?.event.event_id || "evt_forged_qa",
        deliveryVerified: true, postMergeRegressionResult: "PASS",
        candidateCommitSha: qaCommit,
        mergeCommitSha: wrongPublishedSha && fixId === RECOVERY_FIX
          ? "b".repeat(40) : mainSha,
        remoteMainSha: wrongPublishedSha && fixId === RECOVERY_FIX
          ? "b".repeat(40) : mainSha
      }
    });
  }
  if (dispatch) await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "developer.new.dispatch." + (++sequence),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller-session"
  });
  if (stopped) await f.store.appendTaskEvent("fixture", "A-10", {
    operationId: "developer.stop." + (++sequence), eventType: "stop_request",
    actorType: "user", actorId: "user", sessionId: "user-session"
  });
  return { ...f, blocked };
}

test("originally authorized developer blocks recover once after published fixes", async (t) => {
  for (const kind of ["blocked", "developer_c06_blocked",
    "developer_r3_runner_timeout_blocked",
    "developer_d07_checkpoint_unauthorized_dependency_block"]) {
    const { store, evaluator, blocked } = await verifiedDeveloperBlockFixture(t, { kind });
    await Promise.all([evaluator.evaluateProject("fixture"), evaluator.evaluateProject("fixture")]);
    assert.equal(await status(store, "A-10"), "待开发", kind);
    const events = (await store.taskHistory("fixture", "A-10", { all: true }))
      .filter((event) => event.event_type === "auto_unblock");
    assert.equal(events.length, 1, kind);
    assert.equal(events[0].metadata.blockedEventId, blocked.eventId, kind);
    assert.equal((await store.transactions.read(events[0].operation_id))?.state, "committed");
    const scanned = await evaluator.evaluateProject("fixture");
    assert.equal(scanned.candidates.find((item) => item.task_id === "A-10")?.eligible, true);
  }
});

test("developer block recovery rejects missing QA, delivery, STOP and false failure proofs", async (t) => {
  for (const options of [
    { missingPredecessor: true }, { missingPredecessor: true, forgedGenericNote: true },
    { missingRootQA: true }, { missingRootDelivery: true },
    { wrongPublishedSha: true }, { wrongCandidateSha: true },
    { stopped: true },
    { unfinishedDependency: true }, { kind: "developer_c06_blocked", missingRelatedDelivery: true },
    { kind: "developer_r3_runner_timeout_blocked", wrongMetadata: true },
    { kind: "developer_d07_checkpoint_unauthorized_dependency_block", wrongMetadata: true },
    { kind: "developer_d07_checkpoint_unauthorized_dependency_block", unrelatedFixPending: true }
  ]) {
    const { store, evaluator } = await verifiedDeveloperBlockFixture(t, options);
    await evaluator.evaluateProject("fixture");
    assert.equal(await status(store, "A-10"), "阻断", JSON.stringify(options));
    assert.equal((await store.taskHistory("fixture", "A-10", { all: true }))
      .filter((event) => event.event_type === "auto_unblock").length, 0);
  }
});
