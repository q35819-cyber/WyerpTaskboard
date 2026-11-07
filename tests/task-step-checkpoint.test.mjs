import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../server/task-store.mjs";
import { TaskStepCheckpoint, ROLE_STAGE_STEPS } from "../server/task-step-checkpoint.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

async function fixture(t) {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const taskStore = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore, flowVersion: "role-steps-v1" }).init();
  return { f, taskStore, cp };
}
let sequence = 1;
async function step(cp, role, id, extra = {}, taskId = "A-10") {
  const before = await cp.show("fixture", taskId);
  const actorId = extra.actorId || (role === "controller_ai" ? "controller" : role === "developer_ai" ? "developer" : "qa");
  const sessionId = extra.sessionId || role + ".session";
  const c00 = {
    C00_A_REQUIREMENTS: ["controller_requirements_reviewed",
      { requirementsReviewed: true, requirementEvidence: "reports/requirements-checked.md" }],
    C00_B_MAIN_VERSION: ["controller_main_version_verified",
      { gitExitCode: 0, localMainSha: "a".repeat(40), remoteMainSha: "a".repeat(40), packageVersion: "0.6.63" }],
    C00_C_SAFE_CLEANUP: ["controller_safe_cleanup_verified",
      { resourcesChecked: true, cleanupOutcome: "preserved", cleanupEvidence: "data/logs/changes/fixture.jsonl", nextAction: "继续保全并在下一轮C00复核" }]
  };
  if (role === "controller_ai" && cp.flowVersion === "role-steps-v2"
    && (extra.result || "PASS") === "PASS" && c00[id] && !extra.eventId) {
    const event = await cp.taskStore.appendTaskEvent("fixture", taskId, {
      operationId: "fixture.c00." + String(sequence++).padStart(8, "0"),
      eventType: c00[id][0], actorType: role, actorId, sessionId, metadata: c00[id][1]
    });
    extra = { ...extra, eventId: event.event.event_id };
  }
  const result = await cp.record("fixture", taskId, {
    operationId: "fixture.step." + String(sequence++).padStart(8, "0"),
    expectedSha256: before.sha256, stepId: id, actorType: role, actorId,
    sessionId, evidence: "实际执行证据: fixture-" + id, ...extra
  });
  assert.ok(result.sha256 && result.file.endsWith(taskId + ".md"));
  assert.equal(result.state.lastAction.stepId, id);
  return result;
}
async function controllerReady(store, cp, taskId = "A-10") {
  await step(cp, "controller_ai", "C01_SCAN", {}, taskId);
  await step(cp, "controller_ai", "C02_TRIAGE", {}, taskId);
  const event = await store.appendTaskEvent("fixture", taskId, {
    operationId: "fixture.dispatch." + String(sequence++).padStart(8, "0"),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller_ai.session", note: "正式派给合法开发"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: event.event.event_id }, taskId);
  await step(cp, "controller_ai", "C04_VERIFY_NEXT", {}, taskId);
}
async function claimDev(store) {
  const s = await store.snapshot("fixture");
  return store.updateTask("fixture", "A-10", {
    status: "开发中", assignee: "developer", sessionWindowName: "dev", sessionId: "developer_ai.session"
  }, {
    operationId: "fixture.claim." + String(sequence++).padStart(8, "0"),
    expectedRevision: s.registryRevision, eventType: "claim", actorType: "developer_ai",
    actorId: "developer", sessionId: "developer_ai.session"
  });
}

async function newCandidateAfterQ04(t, { candidate = "2".repeat(40), selfTest = true,
  testSha = candidate, stop = false } = {}) {
  const { cp, taskStore } = await fixture(t);
  const move = async (patch, eventType, actorType, actorId, sessionId, metadata = {}, note = "") =>
    taskStore.updateTask("fixture", "A-10", patch, {
      operationId: "fixture.q04fresh." + String(sequence++).padStart(8, "0"),
      expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      eventType, actorType, actorId, sessionId, metadata, note
    });
  await claimDev(taskStore);
  await move({ status: "待独测", assignee: "", sessionId: "", sessionWindowName: "" },
    "handoff", "developer_ai", "developer", "developer_ai.session",
    { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" });
  const firstQa = await move({ status: "独测中", assignee: "qa", sessionWindowName: "qa", sessionId: "test_ai.session" },
    "claim", "test_ai", "qa", "test_ai.session");
  await step(cp, "test_ai", "Q01_ADMISSION", { eventId: firstQa.eventId });
  await step(cp, "test_ai", "Q02_TEST");
  const pass = await move({ status: "待交付", assignee: "", sessionId: "", sessionWindowName: "" },
    "test_result", "test_ai", "qa", "test_ai.session",
    { atomicLifecycle: true, testResult: "pass", acceptanceScope: "system",
      reportPath: "reports/qa-old.md", deliveryActions: ["candidate_merge"],
      commitSha: "1".repeat(40) });
  await step(cp, "test_ai", "Q03_RESULT", { eventId: pass.eventId });
  await step(cp, "test_ai", "Q04_NEXT");
  const finished = await cp.show("fixture", "A-10");
  assert.equal(finished.state.cursors.test_ai, null);
  await move({ status: "交付中", assignee: "controller", sessionWindowName: "controller", sessionId: "controller-session" },
    "claim", "controller_ai", "controller", "controller-session");
  await move({ status: "阻断", assignee: "", sessionId: "" },
    "controller_delivery_blocked", "controller_ai", "controller", "controller-session");
  await move({ status: "HOLD" }, "controller_hold_for_refactor",
    "controller_ai", "controller", "controller-session");
  await move({ status: "待开发" }, "controller_restore_dev",
    "controller_ai", "controller", "controller-session");
  await move({ status: "开发中", assignee: "new-developer", sessionWindowName: "new-developer", sessionId: "new-dev-session" },
    "claim", "developer_ai", "new-developer", "new-dev-session");
  if (selfTest) {
    await taskStore.appendTaskEvent("fixture", "A-10", {
      operationId: "fixture.q04.selftest." + String(sequence++).padStart(8, "0"),
      eventType: "test_result", actorType: "developer_ai",
      actorId: "new-developer", sessionId: "new-dev-session",
      note: "三轮真实自测 PASS 候选" + testSha,
      metadata: { testResult: "pass", reportPath: "reports/new-dev-pass.md" }
    });
  }
  await move({ status: "待独测", assignee: "", sessionId: "", sessionWindowName: "" },
    "handoff", "developer_ai", "new-developer", "new-dev-session",
    { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" },
    "新开发正式handoff候选" + candidate);
  const latestQa = await move({ status: "独测中", assignee: "qa2", sessionWindowName: "qa2", sessionId: "qa2-session" },
    "claim", "test_ai", "qa2", "qa2-session");
  if (stop) await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.q04.stop." + String(sequence++).padStart(8, "0"),
    eventType: "stop_request", actorType: "user", note: "用户明确暂停"
  });
  return { cp, taskStore, latestQa, finished };
}

async function legacyD09Restart(t, { dispatch = true, newActor = "next-dev",
  newSession = "next-dev-session" } = {}) {
  const { cp, taskStore } = await fixture(t);
  const move = async (patch, eventType, actorType, actorId, sessionId, metadata = {}) =>
    taskStore.updateTask("fixture", "A-10", patch, {
      operationId: "fixture.d09." + String(sequence++).padStart(8, "0"),
      expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
      eventType, actorType, actorId, sessionId, metadata
    });
  await controllerReady(taskStore, cp);
  const old = await claimDev(taskStore);
  await step(cp, "developer_ai", "D01_CLAIM", { eventId: old.eventId });
  for (const name of ROLE_STAGE_STEPS.developer_ai.slice(1, 7))
    await step(cp, "developer_ai", name);
  const handoff = await move({ status: "待独测", assignee: "", sessionId: "" },
    "handoff", "developer_ai", "developer", "developer_ai.session",
    { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" });
  await step(cp, "developer_ai", "D08_HANDOFF", { eventId: handoff.eventId });
  const qaClaim = await move({ status: "独测中", assignee: "qa",
    sessionWindowName: "qa", sessionId: "test_ai.session" },
    "claim", "test_ai", "qa", "test_ai.session");
  await step(cp, "test_ai", "Q01_ADMISSION", { eventId: qaClaim.eventId });
  await step(cp, "test_ai", "Q02_TEST");
  const qaPass = await move({ status: "待交付", assignee: "", sessionId: "" },
    "test_result", "test_ai", "qa", "test_ai.session",
    { atomicLifecycle: true, testResult: "pass", reportPath: "reports/real-qa.md",
      acceptanceScope: "system", deliveryActions: ["candidate_merge"],
      commitSha: "1".repeat(40) });
  await step(cp, "test_ai", "Q03_RESULT", { eventId: qaPass.eventId });
  await step(cp, "test_ai", "Q04_NEXT");
  const oldCheckpoint = await cp.show("fixture", "A-10");
  assert.equal(oldCheckpoint.state.cursors.developer_ai, "D09_MERGE_MAIN");
  await move({ status: "交付中", assignee: "controller",
    sessionWindowName: "controller", sessionId: "controller_ai.session" },
  "claim", "controller_ai", "controller", "controller_ai.session");
  await move({ status: "阻断", assignee: "", sessionId: "", sessionWindowName: "" },
    "controller_delivery_blocked", "controller_ai", "controller", "controller_ai.session");
  await move({ status: "HOLD" }, "controller_hold_for_refactor",
    "controller_ai", "controller", "controller_ai.session");
  await move({ status: "待开发" }, "controller_restore_development",
    "controller_ai", "controller", "controller_ai.session");
  if (dispatch) await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.d09.dispatch." + String(sequence++).padStart(8, "0"),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller_ai.session"
  });
  const newClaim = await move({ status: "开发中", assignee: newActor,
    sessionWindowName: "next-dev", sessionId: newSession },
    "claim", "developer_ai", newActor, newSession);
  return { cp, taskStore, oldCheckpoint, newClaim, newActor, newSession };
}

test("legacy D09 starts a new D01 attempt only after real QA PASS, fresh dispatch and claim", async (t) => {
  const { cp, oldCheckpoint, newClaim, newActor, newSession } = await legacyD09Restart(t);
  const fresh = await step(cp, "developer_ai", "D01_CLAIM", {
    eventId: newClaim.eventId, actorId: newActor, sessionId: newSession
  });
  assert.equal(fresh.state.attempts, oldCheckpoint.state.attempts + 1);
  assert.equal(fresh.state.cursors.developer_ai, "D02_WORKTREE");
  assert.equal(fresh.state.cursors.test_ai, "Q01_ADMISSION");
  assert.equal(fresh.state.records.filter(r => r.attempt === oldCheckpoint.state.attempts
    && r.stepId === "Q03_RESULT" && r.verdict === "pass").length, 1);
  assert.equal(fresh.state.records.filter(r => r.stepId === "D08_HANDOFF" && r.result === "PASS").length, 1);
  await assert.rejects(step(cp, "developer_ai", "D01_CLAIM", {
    eventId: newClaim.eventId, actorId: newActor, sessionId: newSession
  }), e => e.code === "CHECKPOINT_STEP_ORDER");
});

test("legacy D09 blocks missing dispatch, replayed actor/Session and STOP without rewriting history", async (t) => {
  for (const options of [{ dispatch: false }, {}]) {
    const { cp, taskStore, newClaim, newActor, newSession } = await legacyD09Restart(t, options);
    const before = await cp.show("fixture", "A-10");
    const actors = options.dispatch === false
      ? [[newActor, newSession]]
      : [["developer", newSession], [newActor, "developer_ai.session"]];
    for (const [actorId, sessionId] of actors)
      await assert.rejects(step(cp, "developer_ai", "D01_CLAIM", {
        eventId: newClaim.eventId, actorId, sessionId
      }), e => ["CHECKPOINT_STEP_ORDER", "CHECKPOINT_SESSION_MISMATCH"].includes(e.code));
    if (options.dispatch !== false) {
      await taskStore.appendTaskEvent("fixture", "A-10", {
        operationId: "fixture.d09.stop." + String(sequence++).padStart(8, "0"),
        eventType: "stop_request", actorType: "user", note: "暂停此任务"
      });
      await assert.rejects(step(cp, "developer_ai", "D01_CLAIM", {
        eventId: newClaim.eventId, actorId: newActor, sessionId: newSession
      }), e => e.code === "CHECKPOINT_STEP_ORDER");
    }
    const after = await cp.show("fixture", "A-10");
    assert.equal(after.sha256, before.sha256);
    assert.equal(after.state.attempts, before.state.attempts);
    assert.equal(after.state.cursors.developer_ai, "D09_MERGE_MAIN");
  }
});

test("finished Q04 permits a fresh Q01 only after a different formally handed-off candidate", async (t) => {
  const { cp, latestQa, finished } = await newCandidateAfterQ04(t);
  const before = await cp.show("fixture", "A-10");
  await assert.rejects(step(cp, "test_ai", "Q01_ADMISSION", {
    eventId: latestQa.eventId, actorId: "qa", sessionId: "test_ai.session"
  }), e => e.code === "CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  const resumed = await step(cp, "test_ai", "Q01_ADMISSION", {
    eventId: latestQa.eventId, actorId: "qa2", sessionId: "qa2-session"
  });
  assert.equal(resumed.state.attempts, finished.state.attempts + 1);
  assert.equal(resumed.state.cursors.test_ai, "Q02_TEST");
  assert.equal(resumed.state.records.filter(r => r.stepId === "Q04_NEXT" && r.result === "PASS").length, 1);
  assert.equal(resumed.state.records.filter(r => r.stepId === "Q01_ADMISSION" && r.result === "PASS").length, 2);
  await assert.rejects(step(cp, "test_ai", "Q01_ADMISSION", {
    eventId: latestQa.eventId, actorId: "qa2", sessionId: "qa2-session"
  }), e => e.code === "CHECKPOINT_STEP_ORDER");
  await step(cp, "test_ai", "Q02_TEST", { actorId: "qa2", sessionId: "qa2-session" });
});

test("finished Q04 refuses unchanged, unsupported, mismatched or stopped candidate attempts", async (t) => {
  await Promise.all([
    { candidate: "1".repeat(40) },
    { selfTest: false },
    { testSha: "3".repeat(40) },
    { stop: true }
  ].map(async (options) => {
    const { cp, latestQa, finished } = await newCandidateAfterQ04(t, options);
    const before = await cp.show("fixture", "A-10");
    await assert.rejects(step(cp, "test_ai", "Q01_ADMISSION", {
      eventId: latestQa.eventId, actorId: "qa2", sessionId: "qa2-session"
    }), e => e.code === "CHECKPOINT_STEP_ORDER");
    const after = await cp.show("fixture", "A-10");
    assert.equal(after.sha256, before.sha256);
    assert.equal(after.state.attempts, finished.state.attempts);
    assert.equal(after.state.cursors.test_ai, null);
  }));
});

test("one checkpoint per task preserves existing legacy text and enforces controller step order", async (t) => {
  const {f, cp, taskStore} = await fixture(t);
  const legacy = path.join(f.projectRoot, "cp", "A-10.md");
  await fs.writeFile(legacy, "# 老任务断点\n\n重要旧证据保留\n");
  const start = await cp.show("fixture", "A-10");
  assert.equal(start.legacy, true);
  await assert.rejects(step(cp,"controller_ai","C02_TRIAGE"), (e) => e.code === "CHECKPOINT_STEP_ORDER");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM"), (e) => e.code === "CHECKPOINT_PREDECESSOR_REQUIRED");
  await controllerReady(taskStore,cp);
  const content = await fs.readFile(legacy,"utf8");
  assert.ok(content.includes("重要旧证据保留"));
  assert.ok(content.includes("C04_VERIFY_NEXT"));
  assert.equal((await fs.readdir(path.join(f.projectRoot,"cp"))).filter(x=>x==="A-10.md").length,1);
  assert.equal((await cp.show("fixture","A-10")).state.cursors.controller_ai,null);
});
test("FAIL and BLOCK persist but do not advance; conflict and idempotent retry never overwrite",async(t)=>{
  const {cp}=await fixture(t);
  const original=await cp.show("fixture","A-10");
  const request={operationId:"fixture.retry.0001",expectedSha256:original.sha256,stepId:"C01_SCAN",
    actorType:"controller_ai",actorId:"controller",sessionId:"c-session",
    evidence:"真实扫描失败：缺少服务连接",result:"FAIL"};
  const failed=await cp.record("fixture","A-10",request);
  assert.equal(failed.state.cursors.controller_ai,"C01_SCAN");
  const repeat=await cp.record("fixture","A-10",request);
  assert.equal(repeat.duplicate,true);
  assert.equal(repeat.state.records.length,1);
  await assert.rejects(cp.record("fixture","A-10",{...request,operationId:"fixture.retry.0002",result:"PASS"}),
    (e)=>e.code==="CHECKPOINT_REVISION_CONFLICT");
  const done=await step(cp,"controller_ai","C01_SCAN");
  assert.equal(done.state.records.length,2);
  assert.equal(done.state.cursors.controller_ai,"C02_TRIAGE");
  const blocked=await step(cp,"controller_ai","C02_TRIAGE",{result:"BLOCK"});
  assert.equal(blocked.state.cursors.controller_ai,"C02_TRIAGE");
});
test("real claim and handoff events are required; after handoff QA can resume from same task file",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM"),e=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  const claimed=await claimDev(taskStore);
  const dev=await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)) await step(cp,"developer_ai",id);
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION"),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  const s=await taskStore.snapshot("fixture");
  const handoff=await taskStore.updateTask("fixture","A-10", {status:"待独测"}, {
    expectedRevision:s.registryRevision, operationId:"fixture.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  await assert.rejects(step(cp,"developer_ai","D09_MERGE_MAIN"),e=>e.code==="CHECKPOINT_QA_PASS_REQUIRED");
  const qaClaim=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qaclaim.0001",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await step(cp,"test_ai","Q02_TEST");
  assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q03_RESULT");
  const checkpointPath = (await cp.show("fixture","A-10")).file;
  assert.equal(path.isAbsolute(checkpointPath), false);
  assert.equal((await fs.readFile(path.join((await cp.taskStore.projects.context("fixture")).rootRealPath, checkpointPath),"utf8")).includes("正式派给合法开发"),false);
});
test("different task IDs are separate, other-role and invalid events are refused",async(t)=>{
  const {cp}=await fixture(t);
  const one=await cp.show("fixture","A-10"),two=await cp.show("fixture","B-10");
  assert.notEqual(one.file,two.file);
  assert.equal(path.isAbsolute(one.file),false);
  assert.equal(one.file.includes("\\\\"),false);
  await assert.rejects(step(cp,"test_ai","C01_SCAN"),e=>e.code==="CHECKPOINT_ROLE_STEP_INVALID");
  await assert.rejects(cp.show("fixture","../fake"),e=>e.code==="INVALID_TASK_ID");
  await assert.rejects(cp.show("fixture","NONE"),e=>e.code==="TASK_NOT_FOUND");
  await assert.rejects(cp.record("fixture","A-10",{stepId:"C01_SCAN",
    actorType:"controller_ai",actorId:"controller",sessionId:"c",operationId:"fixture.invalid.0001",
    expectedSha256:one.sha256,evidence:"short"}),e=>e.code==="CHECKPOINT_EVIDENCE_REQUIRED");
});
test("substep PROGRESS saves a durable checkpoint and rejects forged developer Session",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  const state=await cp.show("fixture","A-10");
  await assert.rejects(cp.record("fixture","A-10",{
    operationId:"fixture.spoof.0001",expectedSha256:state.sha256,
    stepId:"D02_WORKTREE",actorType:"developer_ai",actorId:"intruder",sessionId:"different-session",
    evidence:"有原始worktree命令输出和退出码",result:"PASS"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{result:"PROGRESS"}),e=>e.code==="CHECKPOINT_SUBSTEP_REQUIRED");
  const progress=await step(cp,"developer_ai","D02_WORKTREE",{result:"PROGRESS",substepId:"WORKTREE_VERIFIED"});
  assert.equal(progress.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(progress.state.lastAction.substepId,"WORKTREE_VERIFIED");
  const done=await step(cp,"developer_ai","D02_WORKTREE");
  assert.equal(done.state.cursors.developer_ai,"D03_WRITE_SCOPE");
});
test("takeover revokes the old developer Session for PASS and PROGRESS; new owner resumes the same cursor", async(t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  await step(cp,"developer_ai","D02_WORKTREE");
  await step(cp,"developer_ai","D03_WRITE_SCOPE");
  const taken=await taskStore.updateTask("fixture","A-10",{
    assignee:"replacement",sessionWindowName:"replacement",sessionId:"replacement-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.takeover.dev.0001",eventType:"takeover",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session"
  });
  assert.ok(taken.eventId);
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT"),
    (e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT",{
    result:"PROGRESS",substepId:"BAD_STALE_PROGRESS"
  }),(e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  await assert.rejects(step(cp,"developer_ai","D04_IMPLEMENT",{
    actorId:"replacement",sessionId:"developer_ai.session"
  }),(e)=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D04_IMPLEMENT",{
    actorId:"replacement",sessionId:"replacement-session"
  });
  assert.equal(resumed.state.lastAction.actorId,"replacement");
  assert.equal(resumed.state.cursors.developer_ai,"D05_TEST_1");
});
test("missing D08 recovers only from a genuine latest handoff bound to the owner before QA claim", async(t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.lost-d08.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.lost-d08.qaclaim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D08_HANDOFF");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:"evt_fake"}),
    (e)=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const accepted=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  const recovered=accepted.state.records.find(r=>r.operationId==="recovered."+handoff.eventId);
  assert.equal(recovered.eventId,handoff.eventId);
  assert.equal(recovered.actorId,"developer");
  assert.match(recovered.note,/历史事件投影恢复/);
  assert.equal(accepted.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(accepted.state.cursors.test_ai,"Q02_TEST");
  await assert.rejects(step(cp,"developer_ai","D09_MERGE_MAIN"),
    (e)=>e.code==="CHECKPOINT_QA_PASS_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).state.records.filter(r=>r.operationId===recovered.operationId).length,1);
});
test("real handoff and latest QA claim restore Q01 when the entire developer checkpoint is absent", async(t) => {
  const {cp,taskStore}=await fixture(t);
  const devClaim=await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-checkpoint.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-checkpoint.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const empty=await cp.show("fixture","A-10");
  assert.equal(empty.state.records.length,0);
  assert.equal(empty.state.cursors.developer_ai,"D01_CLAIM");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:devClaim.eventId}),
    e=>e.code==="CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,empty.sha256);
  const recovered=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  assert.equal(recovered.state.cursors.test_ai,"Q02_TEST");
  assert.equal(recovered.state.cursors.developer_ai,"D01_CLAIM");
  assert.equal(recovered.state.records.filter(r=>/^D0[1-8]_/.test(r.stepId)).length,0);
  const marker=recovered.state.records.find(r=>r.operationId==="recovered."+handoff.eventId);
  assert.equal(marker.stepId,"HISTORICAL_HANDOFF");
  assert.equal(marker.result,"RECOVERED");
  assert.equal(marker.eventId,handoff.eventId);
  assert.match(marker.note,/不补造D01-D08/);
  assert.equal(recovered.state.records.length,2);
});
test("existing Q01 FAIL history may be retained during zero-developer-checkpoint recovery", async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-fail.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.zero-fail.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const initial=await step(cp,"test_ai","Q01_ADMISSION",{result:"FAIL"});
  assert.equal(initial.state.cursors.test_ai,"Q01_ADMISSION");
  const recovered=await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  assert.equal(recovered.state.records[0].result,"FAIL");
  assert.equal(recovered.state.records[1].stepId,"HISTORICAL_HANDOFF");
  assert.equal(recovered.state.records[1].eventId,handoff.eventId);
  assert.equal(recovered.state.records[2].result,"PASS");
});
test("new QA Q01 reopens only with a real controller-requeued Q02 BLOCK or finished Q04", async(t) => {
  await Promise.all([false, true].map(async (finished) => {
    const {cp,taskStore}=await fixture(t);
    const label=finished?"finished":"q02block";
    await claimDev(taskStore);
    const handoff=await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",finished?{}:{result:"BLOCK"});
    const testResult=await taskStore.updateTask("fixture","A-10",
      {status:finished?"待交付":"阻断",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".result",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:finished?"pass":"blocked",
          acceptanceScope:"system",deliveryActions:finished?["candidate_merge"]:[],
          reportPath:"reports/qa-"+label+".md"}});
    if(finished) {
      await step(cp,"test_ai","Q03_RESULT",{eventId:testResult.eventId});
      await step(cp,"test_ai","Q04_NEXT");
      assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,null);
      await taskStore.updateTask("fixture","A-10",
        {status:"交付中",assignee:"controller",sessionId:"controller-session",sessionWindowName:"controller"},
        {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
          operationId:"fixture.resume.finished.controller-claim",eventType:"claim",
          actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
      await taskStore.updateTask("fixture","A-10",
        {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
        {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
          operationId:"fixture.resume.finished.delivery-block",eventType:"controller_postmerge_regression_blocked",
          actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    } else {
      assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q02_TEST");
    }
    await taskStore.updateTask("fixture","A-10",{status:"待复测"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".controller-requeue",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"new-qa-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.resume."+label+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"new-qa-session"});
    // The real legacy ledger contains event_type=true; malformed rows must not crash Q01.
    const readHistory = taskStore.taskHistory.bind(taskStore);
    taskStore.taskHistory = async (...args) => {
      const rows = await readHistory(...args);
      const claimAt = rows.findIndex((e) => e.event_id === qa2.eventId);
      assert.ok(claimAt > 0, "official QA claim is visible in returned history");
      const legacy = [true, null, 17, {}].map((value, i) => ({
        event_id: i === 0 ? "evt_0843ae860946441ef6fc0020" : "fixture-legacy-" + i,
        event_type: value, actor_type: "controller_ai", actor_id: "historical",
        old_status: "其他", new_status: "其他"
      }));
      return [...rows.slice(0, claimAt), ...legacy, ...rows.slice(claimAt)];
    };
    const before=await cp.show("fixture","A-10");
    if(!finished) {
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.resume.q02block.stop",eventType:"stop_request",
        actorType:"user",note:"暂停此独测"});
      await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"new-qa-session",eventId:qa2.eventId
      }),e=>e.code==="CHECKPOINT_STEP_ORDER");
      assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.resume.q02block.resume",eventType:"resume",
        actorType:"user",note:"重新授权后继续"});
    }
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa",sessionId:"test_ai.session",eventId:qa2.eventId
    }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
    assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
    const newStart=await step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa-new",sessionId:"new-qa-session",eventId:qa2.eventId
    });
    assert.equal(newStart.state.attempts,before.state.attempts+1);
    assert.equal(newStart.state.cursors.test_ai,"Q02_TEST");
    assert.equal(newStart.state.records.some(r=>r.attempt===before.state.attempts
      && (finished?r.stepId==="Q04_NEXT"&&r.result==="PASS":r.stepId==="Q02_TEST"&&r.result==="BLOCK")),true);
    assert.equal(newStart.state.records.some(r=>r.attempt===newStart.state.attempts
      && r.stepId==="D08_HANDOFF"&&r.result==="PASS"),false);
    assert.ok(handoff.eventId);
  }));
});

test("Q02 recovery rejects fake controller restoration and true QA FAIL without repair", async(t) => {
  await Promise.all(["fake-controller", "unrepaired-fail"].map(async (mode) => {
    const {cp,taskStore}=await fixture(t);
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
    const realBlock = mode === "fake-controller";
    await taskStore.updateTask("fixture","A-10",
      {status:realBlock?"阻断":"测试失败待修复",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".result",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:realBlock?"blocked":"fail",
          reportPath:"reports/qa-"+mode+".md",commitSha:"1".repeat(40)}});
    if (!realBlock) {
      await taskStore.updateTask("fixture","A-10",{status:"阻断"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative.fail.controllerblock",eventType:"controller_block",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"});
    }
    await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.q02negative."+mode+".requeue",
      eventType:realBlock?"fake_requeue":"controller_requeue",
      actorType:realBlock?"developer_ai":"controller_ai",
      actorId:realBlock?"developer":"controller",
      sessionId:realBlock?"developer_ai.session":"controller-session"});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"qa-new-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.q02negative."+mode+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"});
    const previous=await cp.show("fixture","A-10");
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
    }),e=>e.code==="CHECKPOINT_STEP_ORDER");
    assert.equal((await cp.show("fixture","A-10")).sha256,previous.sha256);
    assert.equal((await cp.show("fixture","A-10")).state.attempts,previous.state.attempts);
  }));
});

test("a genuine QA FAIL reopens Q01 after repaired handoff but rejects reused candidate SHA",async(t)=>{
  await Promise.all([false,true].map(async (unchanged) => {
    const {cp,taskStore}=await fixture(t);
    const label=unchanged?"same":"new";
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",
      {status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".handoff",eventType:"handoff",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
        metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
          commitSha:"1".repeat(40)}});
    const qa1=await taskStore.updateTask("fixture","A-10",
      {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".qa1",eventType:"claim",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
    await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa1.eventId});
    await step(cp,"test_ai","Q02_TEST",{result:"FAIL"});
    await taskStore.updateTask("fixture","A-10",
      {status:"测试失败待修复",assignee:"",sessionWindowName:"",sessionId:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".fail",eventType:"test_result",
        actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
        metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/real-fail.md",
          commitSha:"1".repeat(40)}});
    await taskStore.updateTask("fixture","A-10",
      {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".devclaim",eventType:"claim",
        actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
    await taskStore.updateTask("fixture","A-10",
      {status:"待复测",assignee:"",sessionId:"",sessionWindowName:""},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".repaired",eventType:"handoff",
        actorType:"developer_ai",actorId:"repair",sessionId:"repair-session",
        metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
          commitSha:unchanged?"1".repeat(40):"2".repeat(40)}});
    const qa2=await taskStore.updateTask("fixture","A-10",
      {status:"复测中",assignee:"qa-new",sessionWindowName:"qa-new",sessionId:"qa-new-session"},
      {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.failqa."+label+".qa2",eventType:"claim",
        actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"});
    const before=await cp.show("fixture","A-10");
    if(unchanged) {
      await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
      }),e=>e.code==="CHECKPOINT_STEP_ORDER");
      assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
    } else {
      const done=await step(cp,"test_ai","Q01_ADMISSION",{
        actorId:"qa-new",sessionId:"qa-new-session",eventId:qa2.eventId
      });
      assert.equal(done.state.attempts,before.state.attempts+1);
      assert.equal(done.state.cursors.test_ai,"Q02_TEST");
      assert.equal(done.state.records.some(r=>r.attempt===before.state.attempts
        && r.stepId==="Q02_TEST" && r.result==="FAIL"),true);
    }
  }));
});

test("independent BLOCK followed by real controller requeue permits new QA to recover unchanged handoff",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionWindowName:"",sessionId:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.qa1",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{result:"FAIL"});
  const blocked=await taskStore.updateTask("fixture","A-10",{
    status:"阻断",plannedRole:"独立测试AI"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.block",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md"}
  });
  assert.ok(blocked.eventId);
  const resumed=await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.controller",eventType:"controller_requeue",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  assert.ok(resumed.eventId);
  const qa2=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"qa2",sessionWindowName:"qa2",sessionId:"qa2-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.block-requeue.qa2",eventType:"claim",
    actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa",sessionId:"test_ai.session",eventId:qa2.eventId
  }), e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const result=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa2",sessionId:"qa2-session",eventId:qa2.eventId
  });
  assert.equal(result.state.cursors.test_ai,"Q02_TEST");
  assert.equal(result.state.records[0].result,"FAIL");
  const marker=result.state.records.find(r=>r.eventId===handoff.eventId);
  assert.equal(marker.stepId,"HISTORICAL_HANDOFF");
  assert.equal(marker.result,"RECOVERED");
  assert.equal(result.state.records.filter(r=>/^D0[1-8]_/.test(r.stepId)).length,0);
});
test("QA recovery refuses BLOCK requeued by non-controller and refuses real failed test verdict",async(t)=>{
  for(const verdict of ["blocked","fail"]){
    const {cp,taskStore}=await fixture(t);
    await claimDev(taskStore);
    await taskStore.updateTask("fixture","A-10",{
      status:"待独测",assignee:"",sessionWindowName:"",sessionId:""
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.handoff."+verdict,eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
    });
    await taskStore.updateTask("fixture","A-10",{
      status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.qa."+verdict,eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
    });
    await taskStore.updateTask("fixture","A-10",{
      status:verdict==="blocked"?"阻断":"测试失败待修复",
      ...(verdict==="blocked"?{plannedRole:"独立测试AI"}:{})
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.result."+verdict,eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:verdict,reportPath:"reports/qa-verdict.md"}
    });
    if(verdict==="blocked") {
      await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.requeue",eventType:"fake_requeue",
        actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
      });
    } else {
      // Malformed historical requeue event must never erase a genuine FAIL.
      await taskStore.appendTaskEvent("fixture","A-10",{
        operationId:"fixture.block-negative.fake-controller",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
      await taskStore.updateTask("fixture","A-10",{status:"阻断",plannedRole:"开发AI"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.to-block",eventType:"controller_block",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
      await taskStore.updateTask("fixture","A-10",{status:"待复测"},{
        expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
        operationId:"fixture.block-negative.retest",eventType:"controller_requeue",
        actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
      });
    }
    const qa=await taskStore.updateTask("fixture","A-10",{
      status:"复测中",assignee:"qa2",sessionWindowName:"qa2",sessionId:"qa2-session"
    },{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-negative.qa2."+verdict,eventType:"claim",
      actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
    });
    const before=await cp.show("fixture","A-10");
    await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
      actorId:"qa2",sessionId:"qa2-session",eventId:qa.eventId
    }),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
    assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  }
});
test("partially written developer steps cannot be silently skipped by historical handoff projection",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.partial.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  assert.ok(handoff.eventId);
  const claim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.partial.qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:claim.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});
test("an old Session cannot forge the latest handoff after a developer takeover",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  await taskStore.updateTask("fixture","A-10",{
    assignee:"replacement",sessionId:"replacement-session",sessionWindowName:"replacement"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.takeover.0001",eventType:"takeover",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session"
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.legit.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"replacement",sessionId:"replacement-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  // Inject a historical event with the old identity after the authentic handoff.
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.stale-handoff.fake.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
  });
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.stale-handoff.qaclaim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});
test("controller takeover invalidates its former Session without losing the already recorded scan",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await step(cp,"controller_ai","C01_SCAN");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.controller.takeover.0001",eventType:"takeover",
    actorType:"controller_ai",actorId:"controller-new",sessionId:"controller-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"controller_ai","C02_TRIAGE"),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const resumed=await step(cp,"controller_ai","C02_TRIAGE",{
    actorId:"controller-new",sessionId:"controller-new-session"
  });
  assert.equal(resumed.state.cursors.controller_ai,"C03_DISPATCH");
});
test("independent QA takeover revokes old QA before Q02, preserving the predecessor event",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handed=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.handoff.0001",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handed.eventId});
  const qaClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.claim.0001",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await taskStore.updateTask("fixture","A-10",{
    assignee:"qa-new",sessionId:"qa-new-session",sessionWindowName:"qa-new"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.qa-takeover.transfer.0001",eventType:"takeover",
    actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q02_TEST"),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const resumed=await step(cp,"test_ai","Q02_TEST",{
    actorId:"qa-new",sessionId:"qa-new-session"
  });
  assert.equal(resumed.state.cursors.test_ai,"Q03_RESULT");
});
test("QA can enter Q01 via latest formal takeover when handoff D08 was not recorded",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const dev=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:dev.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  assert.ok(handoff.eventId);
  const oldClaim=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const takeover=await taskStore.updateTask("fixture","A-10",{
    assignee:"qa-new",sessionId:"qa-new-session",sessionWindowName:"qa-new"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.q01-takeover.transfer",eventType:"takeover",
    actorType:"test_ai",actorId:"qa-new",sessionId:"qa-new-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{eventId:oldClaim.eventId}),
    e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  const accepted=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa-new",sessionId:"qa-new-session",eventId:takeover.eventId
  });
  assert.equal(accepted.state.cursors.test_ai,"Q02_TEST");
  assert.equal(accepted.state.records.filter(e=>e.stepId==="D08_HANDOFF" && e.eventId===handoff.eventId).length,1);
});
test("QA FAIL returns to developer without reusing the prior PASS attempt",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const claimed=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const beforeHandoff=await taskStore.snapshot("fixture");
  const handed=await taskStore.updateTask("fixture","A-10",{status:"待独测"},{
    operationId:"fixture.qa.retry.handoff.0001",expectedRevision:beforeHandoff.registryRevision,
    eventType:"handoff",actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handed.eventId});
  const qaClaim=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qa.retry.claim.0001",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
    });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qaClaim.eventId});
  await step(cp,"test_ai","Q02_TEST");
  const qaFail=await taskStore.updateTask("fixture","A-10",
    {status:"测试失败待修复"},{
      expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.qa.retry.failed.0001",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/independent-qa-fail.md"}
    });
  await step(cp,"test_ai","Q03_RESULT",{eventId:qaFail.eventId});
  assert.equal((await cp.show("fixture","A-10")).state.cursors.test_ai,"Q04_NEXT");
  await step(cp,"test_ai","Q04_NEXT");
  const result=(await cp.show("fixture","A-10")).state;
  assert.equal(result.attempts,2);
  assert.equal(result.cursors.developer_ai,"D04_IMPLEMENT");
  assert.equal(result.cursors.test_ai,"Q01_ADMISSION");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION"),e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
});

test("controller-authorized QA BLOCK return reopens D01 without erasing old Q02 or letting old Session write",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"controller_hold_qa",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"controller_return_dev_for_qa_gate",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.dispatch",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session",
    note:"正式解阻派工回原开发修复步骤门禁"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.stop",eventType:"stop_request",actorType:"user",note:"用户停止"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.resume",eventType:"resume",actorType:"user",note:"用户恢复"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"developer",sessionId:"developer_ai.session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  });
  assert.equal(resumed.state.attempts,before.state.attempts+1);
  assert.equal(resumed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(resumed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(resumed.state.records.some(x=>x.attempt===before.state.attempts
    && x.stepId==="Q02_TEST" && x.result==="BLOCK"));
  assert.ok(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="D01_CLAIM" && x.eventId===repair.eventId));
  assert.equal(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="Q01_ADMISSION"),false);
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
});
test("user-command authorized QA BLOCK return reopens D01 without erasing old Q02 or letting old Session write",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"developer_user_directed_bugfix_hold",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"developer_user_directed_bugfix_requeue",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.stop",eventType:"stop_request",actorType:"user",note:"用户停止"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.return-block.resume",eventType:"resume",actorType:"user",note:"用户恢复"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"developer",sessionId:"developer_ai.session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  const resumed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  });
  assert.equal(resumed.state.attempts,before.state.attempts+1);
  assert.equal(resumed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(resumed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(resumed.state.records.some(x=>x.attempt===before.state.attempts
    && x.stepId==="Q02_TEST" && x.result==="BLOCK"));
  assert.ok(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="D01_CLAIM" && x.eventId===repair.eventId));
  assert.equal(resumed.state.records.some(x=>x.attempt===resumed.state.attempts
    && x.stepId==="Q01_ADMISSION"),false);
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }),e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
});
test("spoofed user-command bugfix transitions cannot reopen D01",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const original=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:original.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const priorHandoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionWindowName:"",sessionId:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
        commitSha:"1".repeat(40)}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:priorHandoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.qa-claim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md",
        commitSha:"1".repeat(40)}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.hold",eventType:"developer_user_directed_bugfix_hold",
      actorType:"developer_ai",actorId:"intruder",sessionId:"fake-session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.return-dev",eventType:"developer_user_directed_bugfix_requeue",
      actorType:"developer_ai",actorId:"intruder",sessionId:"fake-session"});
  const repair=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.return-block.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"});
  const before=await cp.show("fixture","A-10");
  assert.equal(before.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(before.state.cursors.test_ai,"Q02_TEST");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:repair.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});

test("QA BLOCK return cannot restart developer D01 with forged or late controller dispatch",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const first=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:first.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",
    {status:"待独测",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.handoff",eventType:"handoff",
      actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
      metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}});
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  const qa=await taskStore.updateTask("fixture","A-10",
    {status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.qaclaim",eventType:"claim",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"});
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:qa.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"BLOCK"});
  await taskStore.updateTask("fixture","A-10",
    {status:"阻断",assignee:"",sessionId:"",sessionWindowName:""},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.result",eventType:"test_result",
      actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
      metadata:{atomicLifecycle:true,testResult:"blocked",reportPath:"reports/qa-block.md"}});
  await taskStore.updateTask("fixture","A-10",{status:"HOLD"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.hold",eventType:"controller_hold",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.return",eventType:"controller_return_developer",
      actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session"});
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.block-no-dispatch.spoof",eventType:"controller_dispatch_p0",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    note:"伪造调度"});
  const dev=await taskStore.updateTask("fixture","A-10",
    {status:"修复中",assignee:"new-dev",sessionWindowName:"new-dev",sessionId:"new-session"},
    {expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
      operationId:"fixture.block-no-dispatch.devclaim",eventType:"claim",
      actorType:"developer_ai",actorId:"new-dev",sessionId:"new-session"});
  const checkpoint=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:dev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,checkpoint.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.block-no-dispatch.too-late",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller_ai.session",
    note:"开发已经认领后的迟到派工不得回溯补授权"});
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:dev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,checkpoint.sha256);
});
test("a real QA Q02 failure and fresh developer claim reopen D01 without losing the old attempt", async (t) => {
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const first=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:first.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)) await step(cp,"developer_ai",id);
  const oldHandoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.old-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
      commitSha:"1".repeat(40)}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:oldHandoff.eventId});
  const firstQA=await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionWindowName:"qa",sessionId:"test_ai.session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.old-qa",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await step(cp,"test_ai","Q01_ADMISSION",{eventId:firstQA.eventId});
  await step(cp,"test_ai","Q02_TEST",{result:"FAIL"});
  const fail=await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.result",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/qa-fail.md",
      commitSha:"1".repeat(40)}
  });
  const newDev=await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"repair",sessionWindowName:"repair",sessionId:"repair-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.claim",eventType:"claim",
    actorType:"developer_ai",actorId:"repair",sessionId:"repair-session"
  });
  const prior=await cp.show("fixture","A-10");
  assert.equal(prior.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(prior.state.cursors.test_ai,"Q02_TEST");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.fail-restart.stop",eventType:"stop_request",actorType:"user",note:"暂停返修"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  }), e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture","A-10")).sha256,prior.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.fail-restart.resume",eventType:"resume",actorType:"user",note:"正式恢复返修"
  });
  const renewed=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  });
  assert.equal(renewed.state.attempts,2);
  assert.equal(renewed.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(renewed.state.cursors.test_ai,"Q01_ADMISSION");
  assert.ok(renewed.state.records.some(r=>r.stepId==="Q02_TEST"&&r.result==="FAIL"&&r.attempt===1));
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{
    actorId:"repair",sessionId:"repair-session",eventId:newDev.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  await assert.rejects(step(cp,"developer_ai","D02_WORKTREE",{
    actorId:"developer",sessionId:"developer_ai.session"
  }), e=>e.code==="CHECKPOINT_SESSION_MISMATCH");
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7)){
    await step(cp,"developer_ai",id,{actorId:"repair",sessionId:"repair-session"});
  }
  const fixed=await taskStore.updateTask("fixture","A-10",{
    status:"待复测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.new-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"repair",sessionId:"repair-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
      commitSha:"2".repeat(40)}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{
    actorId:"repair",sessionId:"repair-session",eventId:fixed.eventId
  });
  const newQA=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"new-qa",sessionWindowName:"new-qa",sessionId:"new-qa-session"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.fail-restart.new-qa",eventType:"claim",
    actorType:"test_ai",actorId:"new-qa",sessionId:"new-qa-session"
  });
  const passed=await step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"new-qa",sessionId:"new-qa-session",eventId:newQA.eventId
  });
  assert.equal(passed.state.cursors.test_ai,"Q02_TEST");
  assert.ok(passed.state.records.some(r=>r.stepId==="Q02_TEST"&&r.result==="FAIL"));
  assert.ok(fail.eventId);
});

test("a genuine independent FAIL still reopens D01 when old QA checkpoint steps were never written",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await controllerReady(taskStore,cp);
  const old=await claimDev(taskStore);
  await step(cp,"developer_ai","D01_CLAIM",{eventId:old.eventId});
  for(const id of ROLE_STAGE_STEPS.developer_ai.slice(1,7))await step(cp,"developer_ai",id);
  const handoff=await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测"}
  });
  await step(cp,"developer_ai","D08_HANDOFF",{eventId:handoff.eventId});
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  const failed=await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.fail",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/qa-fail.md"}
  });
  const newDev=await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"new-dev",sessionId:"new-session",sessionWindowName:"new-dev"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.missing-qa.new-claim",eventType:"claim",
    actorType:"developer_ai",actorId:"new-dev",sessionId:"new-session"
  });
  const oldState=await cp.show("fixture","A-10");
  assert.equal(oldState.state.cursors.developer_ai,"D09_MERGE_MAIN");
  assert.equal(oldState.state.cursors.test_ai,"Q01_ADMISSION");
  const restored=await step(cp,"developer_ai","D01_CLAIM",{
    actorId:"new-dev",sessionId:"new-session",eventId:newDev.eventId
  });
  assert.equal(restored.state.attempts,2);
  assert.equal(restored.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(restored.state.records.filter(r=>r.stepId==="Q01_ADMISSION").length,0);
  assert.ok(failed.eventId);
});

test("a formally dispatched and claimed task can start D01 without fabricated old controller steps",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  const current=await cp.show("fixture","A-10");
  const claimed=await claimDev(taskStore);
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  assert.equal((await cp.show("fixture","A-10")).sha256,current.sha256);
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.dev-forged",eventType:"controller_dispatch_p0",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  await taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.controller",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  await assert.rejects(step(cp,"developer_ai","D01_CLAIM",{eventId:claimed.eventId}),
    e=>e.code==="CHECKPOINT_PREDECESSOR_REQUIRED");
  const fresh=await fixture(t);
  const dispatched=await fresh.taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dispatch.controller-before-claim",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  const properlyClaimed=await claimDev(fresh.taskStore);
  const approved=await step(fresh.cp,"developer_ai","D01_CLAIM",{eventId:properlyClaimed.eventId});
  assert.equal(approved.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(approved.state.cursors.controller_ai,"C01_SCAN");
  await assert.rejects(step(fresh.cp,"developer_ai","D01_CLAIM",{
    eventId:properlyClaimed.eventId
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
  assert.ok(dispatched.event.event_id);
  assert.equal(approved.state.records.filter(r=>r.actorType==="controller_ai").length,0);
  const blocked=await fixture(t);
  const original=await fs.readFile(blocked.f.registryPath,"utf8");
  assert.ok(original.includes("read/A-10.md"));
  await fs.writeFile(blocked.f.registryPath,original.replace("read/A-10.md","B-10完成"));
  await blocked.taskStore.appendTaskEvent("fixture","A-10",{
    operationId:"fixture.dependency.dispatch",eventType:"controller_dispatch_p0",
    actorType:"controller_ai",actorId:"controller",sessionId:"controller-session"
  });
  const before=await blocked.cp.show("fixture","A-10");
  await assert.rejects(claimDev(blocked.taskStore),
    e=>e.code==="CLAIM_DEPENDENCY_NOT_COMPLETED");
  assert.equal((await blocked.cp.show("fixture","A-10")).sha256,before.sha256);
});

test("a formally failed candidate cannot reuse the same Git SHA for a new QA admission",async(t)=>{
  const {cp,taskStore}=await fixture(t);
  await claimDev(taskStore);
  await taskStore.updateTask("fixture","A-10",{
    status:"待独测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.old-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"developer",sessionId:"developer_ai.session",
    metadata:{atomicLifecycle:true,completedFromStatus:"开发中",handoffTarget:"待独测",
      commitSha:"a".repeat(40)}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"独测中",assignee:"qa",sessionId:"test_ai.session",sessionWindowName:"qa"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.qa-claim",eventType:"claim",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session"
  });
  await taskStore.updateTask("fixture","A-10",{status:"测试失败待修复"},{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.failed",eventType:"test_result",
    actorType:"test_ai",actorId:"qa",sessionId:"test_ai.session",
    metadata:{atomicLifecycle:true,testResult:"fail",reportPath:"reports/same-sha-fail.md",
      commitSha:"a".repeat(40)}
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"修复中",assignee:"fix",sessionId:"fix-session",sessionWindowName:"fix"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.fix-claim",eventType:"claim",
    actorType:"developer_ai",actorId:"fix",sessionId:"fix-session"
  });
  await taskStore.updateTask("fixture","A-10",{
    status:"待复测",assignee:"",sessionId:"",sessionWindowName:""
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.new-handoff",eventType:"handoff",
    actorType:"developer_ai",actorId:"fix",sessionId:"fix-session",
    metadata:{atomicLifecycle:true,completedFromStatus:"修复中",handoffTarget:"待复测",
      commitSha:"a".repeat(40)}
  });
  const qa=await taskStore.updateTask("fixture","A-10",{
    status:"复测中",assignee:"qa2",sessionId:"qa2-session",sessionWindowName:"qa2"
  },{
    expectedRevision:(await taskStore.snapshot("fixture")).registryRevision,
    operationId:"fixture.same-sha.qa2",eventType:"claim",
    actorType:"test_ai",actorId:"qa2",sessionId:"qa2-session"
  });
  const before=await cp.show("fixture","A-10");
  await assert.rejects(step(cp,"test_ai","Q01_ADMISSION",{
    actorId:"qa2",sessionId:"qa2-session",eventId:qa.eventId
  }),e=>e.code==="CHECKPOINT_CANDIDATE_UNCHANGED");
  assert.equal((await cp.show("fixture","A-10")).sha256,before.sha256);
});

test("portable flow paths stay relative and published template matches canonical steps",async()=>{
  const root=path.resolve("流程文档"), template=path.resolve("templates/webcodex-v1/流程文档");
  async function visit(folder,prefix=""){
    const output=[];
    for(const entry of await fs.readdir(folder,{withFileTypes:true})){
      const relative=prefix?prefix+"/"+entry.name:entry.name;
      if(entry.isDirectory())output.push(...await visit(path.join(folder,entry.name),relative));
      else if(entry.isFile())output.push(relative);
    }
    return output;
  }
  const canonical=(await visit(root)).sort();
  const copies=(await visit(template)).sort();
  assert.deepEqual(copies,canonical);
  assert.ok(canonical.length >= 25, "required flow documents unexpectedly missing");
  for(const relative of canonical){
    const original=await fs.readFile(path.join(root,relative),"utf8");
    const copy=await fs.readFile(path.join(template,relative),"utf8");
    assert.equal(copy,original,"out-of-sync portable template: "+relative);
    assert.doesNotMatch(original,/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|Users|mnt|opt|tmp)\/)/,
      "machine-specific absolute path found in "+relative);
  }
  const readme=await fs.readFile(path.resolve("templates/webcodex-v1/README.md"),"utf8");
  assert.doesNotMatch(readme,/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:home|Users|mnt|opt|tmp)\/)/);
  assert.match(await fs.readFile(path.join(root,"00_统一入口.md"),"utf8"),/相对路径强制规则/);
});

async function v2AuthorizedDeveloperTakeover(t, { dispatch = "fresh", grant = "valid",
  link = true, stop = false, suspicion = "valid", revoked = false, quote = "异常接管" } = {}) {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  const appendDispatch = () => taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.d01.reentry.dispatch." + String(sequence++).padStart(8, "0"),
    eventType: "controller_dispatch", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller-session"
  });
  if (dispatch === "stale") await appendDispatch();
  const original = await claimDev(taskStore);
  if (dispatch === "fresh") await appendDispatch();
  const suspicionOperation = "fixture.d01.reentry.suspect." + String(sequence++).padStart(8, "0");
  if (suspicion !== "missing") await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: suspicionOperation, eventType: "suspected_disconnect",
    actorType: "developer_ai", actorId: "new-developer", sessionId: "new-dev-session"
  });
  const allowOperation = "fixture.d01.reentry.allow." + String(sequence++).padStart(8, "0");
  if (grant !== "missing") await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: allowOperation, eventType: "takeover_allowed",
    actorType: "developer_ai", actorId: "new-developer", sessionId: "new-dev-session",
    metadata: {
      explicitUserOverride: grant !== "unapproved",
      authorizationSource: grant === "forged" ? "developer_note" : "chat_user_instruction_cooperative",
      authorizationScope: "task", authorizationForwardedBy: "new-developer",
      authorizationForwardingSessionId: "new-dev-session",
      authorizedFromStatus: "开发中", authorizedFromSessionId: "developer_ai.session",
      authorizationQuote: quote,
      suspicionOperationId: suspicion === "wrong" ? "fixture.nonmatching.suspect" : suspicionOperation
    }
  });
  if (revoked) await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.d01.reentry.revoke." + String(sequence++).padStart(8, "0"),
    eventType: "takeover_revoked", actorType: "developer_ai",
    actorId: "new-developer", sessionId: "new-dev-session"
  });
  const takeover = await taskStore.updateTask("fixture", "A-10", {
    status: "开发中", assignee: "new-developer", sessionWindowName: "new-dev",
    sessionId: "new-dev-session"
  }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.d01.reentry.takeover." + String(sequence++).padStart(8, "0"),
    eventType: "takeover", actorType: "developer_ai",
    actorId: "new-developer", sessionId: "new-dev-session",
    metadata: {
      authorizationOperationId: link ? allowOperation : "fixture.mismatched.allow",
      previousSessionId: "developer_ai.session"
    }
  });
  if (dispatch === "late") await appendDispatch();
  if (stop) await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.d01.reentry.stop." + String(sequence++).padStart(8, "0"),
    eventType: "stop_request", actorType: "user", note: "停止本任务"
  });
  return { cp, taskStore, original, takeover };
}

test("v2 D01 accepts a freshly dispatched, user-authorized, server-linked takeover", async (t) => {
  const { cp, original, takeover } = await v2AuthorizedDeveloperTakeover(t);
  const before = await cp.show("fixture", "A-10");
  assert.equal(before.state.cursors.developer_ai, "D01_CLAIM");
  await assert.rejects(step(cp, "developer_ai", "D01_CLAIM", {
    eventId: original.eventId
  }), (e) => e.code === "CHECKPOINT_SESSION_MISMATCH");
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  const admitted = await step(cp, "developer_ai", "D01_CLAIM", {
    eventId: takeover.eventId, actorId: "new-developer", sessionId: "new-dev-session"
  });
  assert.equal(admitted.state.cursors.developer_ai, "D02_WORKTREE");
  assert.equal(admitted.state.records.filter(r => r.stepId === "D01_CLAIM" && r.result === "PASS").length, 1);
  await step(cp, "developer_ai", "D02_WORKTREE", {
    actorId: "new-developer", sessionId: "new-dev-session"
  });
});

test("v2 D01 never retroactively accepts late/stale dispatch or untrusted takeover authorizations", async (t) => {
  for (const scenario of [
    { dispatch: "missing" }, { dispatch: "stale" }, { dispatch: "late" },
    { grant: "missing" }, { grant: "unapproved" }, { grant: "forged" }, { link: false },
    { suspicion: "missing" }, { suspicion: "wrong" }, { quote: "" }, { revoked: true },
    { stop: true }
  ]) {
    const { cp, takeover } = await v2AuthorizedDeveloperTakeover(t, scenario);
    const before = await cp.show("fixture", "A-10");
    await assert.rejects(step(cp, "developer_ai", "D01_CLAIM", {
      eventId: takeover.eventId, actorId: "new-developer", sessionId: "new-dev-session"
    }), (e) => ["CHECKPOINT_PREDECESSOR_REQUIRED", "CHECKPOINT_FORMAL_EVENT_REQUIRED"].includes(e.code),
    JSON.stringify(scenario));
    const after = await cp.show("fixture", "A-10");
    assert.equal(after.sha256, before.sha256, "failed admission cannot write a checkpoint");
    assert.equal(after.state.attempts, before.state.attempts);
  }
});

test("v2 C00 PASS requires fresh, scoped evidence events before any scan", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  const append = async (eventType, metadata, actorId = "controller", sessionId = "controller_ai.session") =>
    (await taskStore.appendTaskEvent("fixture", "A-10", {
      operationId: "fixture.c00.negative." + String(sequence++).padStart(8, "0"),
      eventType, actorType: "controller_ai", actorId, sessionId, metadata
    })).event.event_id;
  const rejectWithoutAdvance = async (stepId, eventId) => {
    const before = await cp.show("fixture", "A-10");
    await assert.rejects(step(cp, "controller_ai", stepId, { eventId }),
      (error) => error.code === "CHECKPOINT_C00_EVIDENCE_REQUIRED");
    assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  };

  await rejectWithoutAdvance("C00_A_REQUIREMENTS", "evt_nonexistent");
  await rejectWithoutAdvance("C00_A_REQUIREMENTS", await append("controller_requirements_reviewed",
    { requirementsReviewed: false, requirementEvidence: "reports/review.md" }));
  await rejectWithoutAdvance("C00_A_REQUIREMENTS", await append("controller_requirements_reviewed",
    { requirementsReviewed: true, requirementEvidence: "reports/review.md" }, "other-controller"));
  await step(cp, "controller_ai", "C00_A_REQUIREMENTS");
  await assert.rejects(step(cp, "controller_ai", "C01_SCAN"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");

  await rejectWithoutAdvance("C00_B_MAIN_VERSION", await append("controller_main_version_verified",
    { gitExitCode: 0, localMainSha: "a".repeat(40), remoteMainSha: "b".repeat(40), packageVersion: "0.6.63" }));
  await rejectWithoutAdvance("C00_B_MAIN_VERSION", await append("controller_main_version_verified",
    { gitExitCode: 1, localMainSha: "a".repeat(40), remoteMainSha: "a".repeat(40), packageVersion: "0.6.63" }));
  await step(cp, "controller_ai", "C00_B_MAIN_VERSION");

  await rejectWithoutAdvance("C00_C_SAFE_CLEANUP", await append("controller_safe_cleanup_verified",
    { resourcesChecked: true, cleanupOutcome: "preserved", cleanupEvidence: "reports/cleanup.md" }));
  await rejectWithoutAdvance("C00_C_SAFE_CLEANUP", await append("controller_safe_cleanup_verified",
    { resourcesChecked: false, cleanupOutcome: "clean", cleanupEvidence: "reports/cleanup.md" }));
  await step(cp, "controller_ai", "C00_C_SAFE_CLEANUP");
  assert.equal((await cp.show("fixture", "A-10")).state.cursors.controller_ai, "C01_SCAN");
});

test("v2 cursor enters C00, permits optional environment check and bypasses delivery-only C04 after ordinary dispatch", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  const start = await cp.show("fixture", "A-10");
  assert.equal(start.state.flowVersion, "role-steps-v2");
  assert.equal(start.state.cursors.controller_ai, "C00_A_REQUIREMENTS");
  assert.equal(start.state.cursors.developer_ai, "D01_CLAIM");
  await assert.rejects(step(cp, "controller_ai", "C01_SCAN"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP"]) {
    await step(cp, "controller_ai", id);
  }
  assert.equal((await cp.show("fixture", "A-10")).state.cursors.controller_ai, "C01_SCAN");
  const env = await step(cp, "controller_ai", "C00_D_ENVIRONMENT");
  assert.equal(env.state.cursors.controller_ai, "C01_SCAN");
  await assert.rejects(step(cp, "controller_ai", "C00_D_ENVIRONMENT"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  await step(cp, "controller_ai", "C01_SCAN");
  await step(cp, "controller_ai", "C02_TRIAGE");
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.001", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  const result = await step(cp, "controller_ai", "C03_DISPATCH", {
    eventId: dispatch.event.event_id
  });
  assert.equal(result.state.cursors.controller_ai, "C08_NEXT");
  await assert.rejects(step(cp, "controller_ai", "C04_MERGE_MAIN"),
    (error) => error.code === "CHECKPOINT_STEP_ORDER");
  await step(cp, "controller_ai", "C08_NEXT");
  assert.equal((await cp.show("fixture", "A-10")).state.cursors.controller_ai, null);
  assert.equal((await cp.show("fixture", "A-10")).state.records
    .filter((entry) => ["C04_MERGE_MAIN", "C05_POSTMERGE", "C06_CLEANUP", "C07_COMPLETE"]
      .includes(entry.stepId)).length, 0, "no fabricated delivery steps");
});

test("v2 developer moves D08 handoff to D09_NEXT without assuming QA PASS or developer merge ownership", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) await step(cp, "controller_ai", id);
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.002", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: dispatch.event.event_id });
  await step(cp, "controller_ai", "C08_NEXT");
  const claimed = await claimDev(taskStore);
  await step(cp, "developer_ai", "D01_CLAIM", { eventId: claimed.eventId });
  for (const id of ["D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3"]) await step(cp, "developer_ai", id);
  const handoff = await taskStore.updateTask("fixture", "A-10", { status: "待独测" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.handoff.002", eventType: "handoff",
    actorType: "developer_ai", actorId: "developer", sessionId: "developer_ai.session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }
  });
  const handed = await step(cp, "developer_ai", "D08_HANDOFF", { eventId: handoff.eventId });
  assert.equal(handed.state.cursors.developer_ai, "D09_NEXT");
  await assert.rejects(step(cp, "developer_ai", "D09_MERGE_MAIN"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  await assert.rejects(step(cp, "developer_ai", "D10_POSTMERGE"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  const done = await step(cp, "developer_ai", "D09_NEXT");
  assert.equal(done.state.cursors.developer_ai, null);
  assert.equal((await taskStore.getTask("fixture", "A-10")).task.status, "待独测");
});

test("v1 checkpoints remain on their original cursor sequence when reopened by v2 runtime", async (t) => {
  const { f, cp: legacy, taskStore } = await fixture(t);
  await step(legacy, "controller_ai", "C01_SCAN");
  await step(legacy, "controller_ai", "C02_TRIAGE");
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.old.dispatch.003", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  const third = await step(legacy, "controller_ai", "C03_DISPATCH", {
    eventId: dispatch.event.event_id
  });
  const v2 = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  assert.equal((await v2.show("fixture", "A-10")).state.flowVersion, "role-steps-v1");
  const resumed = await step(v2, "controller_ai", "C04_VERIFY_NEXT");
  assert.equal(resumed.state.cursors.controller_ai, null);
  assert.equal(resumed.state.records.length, third.state.records.length + 1);
  assert.equal(resumed.state.flowVersion, "role-steps-v1");
  await assert.rejects(step(v2, "controller_ai", "C08_NEXT"),
    (error) => error.code === "CHECKPOINT_ROLE_STEP_INVALID");
  const newTask = await v2.show("fixture", "T-01");
  assert.equal(newTask.state.flowVersion, "role-steps-v2");
  assert.equal(newTask.state.cursors.controller_ai, "C00_A_REQUIREMENTS");
});

test("new checkpoint rejects unknown step versions and forged old cursor before writing anything", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  assert.throws(() => new TaskStepCheckpoint(f.boardRoot, { taskStore, flowVersion: "untrusted-version" }),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
  await step(cp, "controller_ai", "C00_A_REQUIREMENTS");
  const shown = await cp.show("fixture", "A-10");
  const filename = path.join(f.projectRoot, shown.file);
  const raw = await fs.readFile(filename, "utf8");
  const malformed = raw.replace('"controller_ai": "C00_B_MAIN_VERSION"',
    '"controller_ai": "D09_MERGE_MAIN"');
  assert.notEqual(malformed, raw);
  await fs.writeFile(filename, malformed, "utf8");
  await assert.rejects(cp.show("fixture", "A-10"),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
  await assert.rejects(step(cp, "controller_ai", "C00_B_MAIN_VERSION"),
    (error) => error.code === "CHECKPOINT_FLOW_VERSION_INVALID");
});

test("v2 real QA PASS plus new controller delivery claim reopens C00 then gates C04/C07", async (t) => {
  const { f, taskStore } = await fixture(t);
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore }).init();
  for (const id of ["C00_A_REQUIREMENTS", "C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) await step(cp, "controller_ai", id);
  const dispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.004", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller", sessionId: "controller_ai.session"
  });
  await step(cp, "controller_ai", "C03_DISPATCH", { eventId: dispatch.event.event_id });
  await step(cp, "controller_ai", "C08_NEXT");
  const claimed = await claimDev(taskStore);
  await step(cp, "developer_ai", "D01_CLAIM", { eventId: claimed.eventId });
  for (const id of ["D02_WORKTREE", "D03_WRITE_SCOPE", "D04_IMPLEMENT", "D05_TEST_1",
    "D06_TEST_2", "D07_TEST_3"]) await step(cp, "developer_ai", id);
  const handoff = await taskStore.updateTask("fixture", "A-10", { status: "待独测" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.handoff.004", eventType: "handoff",
    actorType: "developer_ai", actorId: "developer", sessionId: "developer_ai.session",
    metadata: { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" }
  });
  await step(cp, "developer_ai", "D08_HANDOFF", { eventId: handoff.eventId });
  await step(cp, "developer_ai", "D09_NEXT");
  await taskStore.updateTask("fixture", "A-10", {
    status: "独测中", assignee: "qa", sessionWindowName: "qa", sessionId: "qa-session"
  }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.qa-claim.004", eventType: "claim",
    actorType: "test_ai", actorId: "qa", sessionId: "qa-session"
  });
  const qa = await taskStore.updateTask("fixture", "A-10", { status: "待交付" }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.qa-result.004", eventType: "test_result",
    actorType: "test_ai", actorId: "qa", sessionId: "qa-session",
    metadata: {
      atomicLifecycle: true, testResult: "pass", reportPath: "reports/qa.md",
      deliveryDisposition: "required", deliveryActions: ["candidate_merge"],
      commitSha: "a".repeat(40), headBranch: "candidate/qa"
    }
  });
  assert.equal(qa.after.status, "待交付");
  const newController = await taskStore.updateTask("fixture", "A-10", {
    status: "交付中", assignee: "controller-2",
    sessionWindowName: "controller-2", sessionId: "controller-2-session"
  }, {
    expectedRevision: (await taskStore.snapshot("fixture")).registryRevision,
    operationId: "fixture.modern.controller-claim.004", eventType: "claim",
    actorType: "controller_ai", actorId: "controller-2", sessionId: "controller-2-session"
  });
  assert.equal(newController.after.status, "交付中");
  const before = await cp.show("fixture", "A-10");
  assert.equal(before.state.cursors.controller_ai, null);
  await assert.rejects(step(cp, "controller_ai", "C00_A_REQUIREMENTS", {
    actorId: "forged-controller", sessionId: "forged-session"
  }), (error) => error.code === "CHECKPOINT_STEP_ORDER");
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  const reopened = await step(cp, "controller_ai", "C00_A_REQUIREMENTS", {
    actorId: "controller-2", sessionId: "controller-2-session"
  });
  assert.equal(reopened.state.attempts, 2);
  assert.equal(reopened.state.records.filter((e) => e.stepId === "C08_NEXT" && e.attempt === 1).length, 1);
  for (const id of ["C00_B_MAIN_VERSION", "C00_C_SAFE_CLEANUP",
    "C01_SCAN", "C02_TRIAGE"]) {
    await step(cp, "controller_ai", id, { actorId: "controller-2", sessionId: "controller-2-session" });
  }
  const deliveryDispatch = await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "fixture.modern.dispatch.005", eventType: "controller_dispatch",
    actorType: "controller_ai", actorId: "controller-2", sessionId: "controller-2-session"
  });
  const c03 = await step(cp, "controller_ai", "C03_DISPATCH", {
    actorId: "controller-2", sessionId: "controller-2-session", eventId: deliveryDispatch.event.event_id
  });
  assert.equal(c03.state.cursors.controller_ai, "C04_MERGE_MAIN");
  await step(cp, "controller_ai", "C04_MERGE_MAIN",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  await step(cp, "controller_ai", "C05_POSTMERGE",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  await step(cp, "controller_ai", "C06_CLEANUP",
    { actorId: "controller-2", sessionId: "controller-2-session" });
  const beforeClose = await cp.show("fixture", "A-10");
  await assert.rejects(step(cp, "controller_ai", "C07_COMPLETE", {
    actorId: "controller-2", sessionId: "controller-2-session"
  }), (error) => error.code === "CHECKPOINT_FORMAL_EVENT_REQUIRED");
  assert.equal((await cp.show("fixture", "A-10")).sha256, beforeClose.sha256);
});


async function modernDeliveryRework(t, options = {}) {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const row = ["A-10", "F-DELIVERY", "product", "P0", "开发中", "开发AI",
    "developer", "dev", options.oldSession ? "old-session" : "new-session", "2026-11-06T01:00:00Z",
    "现代交付冲突D01返修", "测试计划.md", "cp/A-10.md"];
  let registry = registryText([row]);
  if (options.dependency) registry = registry.replace("read/A-10.md", "MISSING-UPSTREAM完成");
  await fs.writeFile(f.registryPath, registry, "utf8");
  const taskStore = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore, flowVersion: "role-steps-v2" }).init();
  const oldDev = "developer", oldSession = "old-session", newSession = options.oldSession ? oldSession : "new-session";
  let serial = 0;
  async function event(type, role, actor, session, from, to, meta = {}) {
    const saved = await taskStore.events.append("fixture", {
      operation_id: "delivery.rework.fixture." + String(++serial).padStart(8, "0"),
      project_id: "fixture", task_id: "A-10", event_type: type,
      actor_type: role, actor_id: actor, session_id: session,
      old_status: from, new_status: to, old_priority: "P0", new_priority: "P0",
      old_track: "product", new_track: "product", metadata: meta
    });
    return saved.event;
  }
  await event("controller_dispatch", "controller_ai", "controller", "controller-session", "待开发", "待开发");
  const originalClaim = await event("claim", "developer_ai", oldDev, oldSession, "待开发", "开发中");
  const originalHandoff = options.noHandoff ? null : await event("handoff", "developer_ai", oldDev,
    oldSession, "开发中", "待独测", { atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测" });
  await event("claim", "test_ai", "qa", "qa-session", "待独测", "独测中");
  const qaPass = await event("test_result", "test_ai", "qa", "qa-session", "独测中",
    "待交付", { atomicLifecycle: true, testResult: options.failQa ? "fail" : "pass",
      reportPath: options.noReport ? "" : "reports/old-QA-PASS.md",
      commitSha: "a".repeat(40), headBranch: "feature/candidate",
      deliveryActions: ["candidate_merge"] });
  await event("claim", "controller_ai", "controller", "controller-session", "待交付", "交付中");
  const failure = options.noFailure ? null : await event("delivery_attempt_failed", "controller_ai",
    "controller", "controller-session", "交付中", "交付中",
    { failureStage: "merge", failureCode: options.wrongFailureCode ? "UNRELATED" : "GIT_MERGE_CONFLICT",
      candidateSha: "a".repeat(40) });
  if (!options.noRework && options.controllerRequeue) {
    if (!options.noBlock) await event("controller_c04_candidate_new_main_merge_conflict",
      "controller_ai", "controller", "controller-session", "交付中", "阻断", {
        failureEventId: options.wrongFailurePointer ? "evt_fake" : failure?.event_id,
        failureCode: "GIT_MERGE_CONFLICT",
        candidateSha: "a".repeat(40)
      });
    if (!options.noReady) await event("controller_rework_ready", "controller_ai",
      "controller-requeue", "requeue-session", "阻断", "阻断");
    await event("controller_rework_requeue",
      options.spoofController ? "developer_ai" : "controller_ai",
      "controller-requeue", "requeue-session", options.wrongStatus ? "HOLD" : "阻断", "待开发", {
        requiresIndependentRetest: !options.noConflict,
        priorCandidateSha: options.wrongCandidate ? "c".repeat(40) : "a".repeat(40),
        reasonCode: options.wrongReason ? "NOT_A_MERGE" : "GIT_MERGE_CONFLICT"
      });
    if (options.staleRequeue) await event("unrelated_reblock", "controller_ai",
      "controller-requeue", "requeue-session", "待开发", "阻断");
  } else if (!options.noRework) await event("delivery_merge_conflict_rework",
    options.spoofController ? "developer_ai" : "controller_ai",
    "controller", "controller-session", options.wrongStatus ? "HOLD" : "交付中", "待开发", {
      mergeConflictVerified: !options.noConflict, invalidatesTestEvidence: true,
      requiresIndependentRetest: true, independentPassEventId: options.fakeQaEvent ? "evt_fake" : qaPass.event_id,
      deliveryFailureEventId: failure?.event_id, candidateSha: options.wrongCandidate ? "c".repeat(40) : "a".repeat(40),
      mainSha: "b".repeat(40),
      originalDeveloperActorId: options.wrongOldActor ? "someone-else" : oldDev,
      originalDeveloperSessionId: oldSession,
      originalControllerActorId: "controller", originalControllerSessionId: "controller-session"
    });
  const newActor = options.wrongNewActor ? "someone-else" : options.controllerRequeue ? "new-developer" : oldDev;
  const newClaim = await event("claim", "developer_ai", newActor, newSession, "待开发", "开发中");
  if (options.stop) await event("stop_request", "user", "user", "", "开发中", "开发中");
  const state = {
    version: 1, projectId: "fixture", taskId: "A-10", flowVersion: "role-steps-v2",
    cursors: { controller_ai: "C00_A_REQUIREMENTS", developer_ai: "D09_NEXT", test_ai: null },
    attempts: 1,
    records: [
      { stepId: "D01_CLAIM", actorType: "developer_ai", actorId: oldDev,
        sessionId: oldSession, result: "PASS", attempt: 1, eventId: originalClaim.event_id },
      { stepId: "D08_HANDOFF", actorType: "developer_ai", actorId: oldDev,
        sessionId: oldSession, result: "PASS", attempt: 1, eventId: originalHandoff?.event_id },
      { stepId: "Q03_RESULT", actorType: "test_ai", actorId: "qa",
        sessionId: "qa-session", result: "PASS", verdict: "pass", attempt: 1, eventId: qaPass.event_id }
    ],
    lastAction: { stepId: "D09_NEXT", result: "PASS" }
  };
  await fs.writeFile(path.join(f.projectRoot, "cp", "A-10.md"),
    "## 曾完成的旧轮步骤\n<!-- TASK_STEP_CHECKPOINT_START v1 -->\n" +
    JSON.stringify(state, null, 2) + "\n<!-- TASK_STEP_CHECKPOINT_END -->\n", "utf8");
  return { cp, taskStore, newClaim, oldSession, newSession, f };
}

test("modern merge rework accepts genuine committed chain and starts new D01/D02 without erasing old PASS", async t => {
  const x = await modernDeliveryRework(t);
  const old = await x.cp.show("fixture", "A-10");
  const started = await step(x.cp, "developer_ai", "D01_CLAIM", {
    actorId: "developer", sessionId: x.newSession, eventId: x.newClaim.event_id
  });
  assert.equal(started.state.attempts, 2);
  assert.equal(started.state.cursors.developer_ai, "D02_WORKTREE");
  assert.equal(started.state.cursors.test_ai, "Q01_ADMISSION");
  assert.equal(started.state.records.filter(r => r.attempt === 1 && r.stepId === "Q03_RESULT").length, 1);
  assert.equal(started.state.records.filter(r => r.attempt === 1 && r.stepId === "D08_HANDOFF").length, 1);
  assert.ok(started.state.records.length > old.state.records.length);
  await step(x.cp, "developer_ai", "D02_WORKTREE", { actorId: "developer", sessionId: x.newSession });
  await assert.rejects(step(x.cp, "developer_ai", "D01_CLAIM", {
    actorId: "developer", sessionId: x.newSession, eventId: x.newClaim.event_id
  }), e => e.code === "CHECKPOINT_STEP_ORDER");
});


test("modern controller_rework_requeue accepts real QA→merge fail→block→requeue→new claim chain", async t => {
  const x=await modernDeliveryRework(t,{controllerRequeue:true});
  const before=await x.cp.show("fixture","A-10");
  const accepted=await step(x.cp,"developer_ai","D01_CLAIM",{
    actorId:"new-developer",sessionId:x.newSession,eventId:x.newClaim.event_id
  });
  assert.equal(accepted.state.attempts,before.state.attempts+1);
  assert.equal(accepted.state.cursors.developer_ai,"D02_WORKTREE");
  assert.equal(accepted.state.cursors.test_ai,"Q01_ADMISSION");
  assert.equal(accepted.state.records.filter(e=>e.attempt===1&&e.stepId==="Q03_RESULT").length,1);
  assert.equal(accepted.state.records.filter(e=>e.attempt===1&&e.stepId==="D08_HANDOFF").length,1);
  await step(x.cp,"developer_ai","D02_WORKTREE",{
    actorId:"new-developer",sessionId:x.newSession
  });
  await assert.rejects(step(x.cp,"developer_ai","D01_CLAIM",{
    actorId:"new-developer",sessionId:x.newSession,eventId:x.newClaim.event_id
  }),e=>e.code==="CHECKPOINT_STEP_ORDER");
});

test("modern controller_rework_requeue rejects forged/stale/replayed chains without cursor changes",async t=>{
  const cases=[
    ["missing requeue",{noRework:true}],
    ["not a controller",{spoofController:true}],
    ["wrong source state",{wrongStatus:true}],
    ["wrong root cause",{wrongReason:true}],
    ["unproven retest",{noConflict:true}],
    ["missing blocker",{noBlock:true}],
    ["missing ready",{noReady:true}],
    ["bad failure pointer",{wrongFailurePointer:true}],
    ["missing original failure",{noFailure:true}],
    ["wrong failure code",{wrongFailureCode:true}],
    ["wrong candidate",{wrongCandidate:true}],
    ["QA did not pass",{failQa:true}],
    ["missing QA report",{noReport:true}],
    ["missing old handoff",{noHandoff:true}],
    ["STOP",{stop:true}],
    ["hard dependency",{dependency:true}],
    ["replayed session",{oldSession:true}],
    ["stale requeue",{staleRequeue:true}]
  ];
  for(const [name,options] of cases){
    const x=await modernDeliveryRework(t,{controllerRequeue:true,...options});
    const before=await x.cp.show("fixture","A-10");
    await assert.rejects(step(x.cp,"developer_ai","D01_CLAIM",{
      actorId:"new-developer",sessionId:x.newSession,eventId:x.newClaim.event_id
    }),e=>e.code==="CHECKPOINT_STEP_ORDER"||e.code==="CHECKPOINT_PREDECESSOR_REQUIRED",name);
    const after=await x.cp.show("fixture","A-10");
    assert.equal(after.sha256,before.sha256,name);
    assert.equal(after.state.attempts,1,name);
  }
  const x=await modernDeliveryRework(t,{controllerRequeue:true});
  const before=await x.cp.show("fixture","A-10");
  await assert.rejects(step(x.cp,"developer_ai","D01_CLAIM",{
    actorId:"developer",sessionId:x.newSession,eventId:x.newClaim.event_id
  }),e=>["CHECKPOINT_STEP_ORDER","CHECKPOINT_SESSION_MISMATCH"].includes(e.code));
  assert.equal((await x.cp.show("fixture","A-10")).sha256,before.sha256);
});
test("modern merge rework refuses missing or forged chain, wrong actor/session, STOP and unfinished dependencies without altering checkpoint", async t => {
  const cases = [
    ["missing event", { noRework: true }],
    ["forged developer claim eventId", { fakeClaimEvent: true }],
    ["wrong QA event pointer", { fakeQaEvent: true }],
    ["wrong candidate SHA", { wrongCandidate: true }],
    ["fake controller", { spoofController: true }],
    ["wrong rework status", { wrongStatus: true }],
    ["missing conflict proof", { noConflict: true }],
    ["missing delivery failure", { noFailure: true }],
    ["wrong original actor", { wrongOldActor: true }],
    ["old session reuse", { oldSession: true }],
    ["wrong new actor", { wrongNewActor: true }],
    ["missing QA PASS", { failQa: true }],
    ["missing QA report", { noReport: true }],
    ["missing real handoff", { noHandoff: true }],
    ["STOP", { stop: true }],
    ["hard dependency", { dependency: true }]
  ];
  for (const [label, options] of cases) {
    const x = await modernDeliveryRework(t, options);
    const before = await x.cp.show("fixture", "A-10");
    await assert.rejects(step(x.cp, "developer_ai", "D01_CLAIM", {
      actorId: options.wrongNewActor ? "someone-else" : "developer",
      sessionId: x.newSession, eventId: options.fakeClaimEvent ? "evt_forged" : x.newClaim.event_id
    }), e => e.code === "CHECKPOINT_STEP_ORDER" ||
      e.code === "CHECKPOINT_PREDECESSOR_REQUIRED", label);
    const after = await x.cp.show("fixture", "A-10");
    assert.equal(after.sha256, before.sha256, label);
    assert.equal(after.state.attempts, 1, label);
    assert.equal(after.state.records.length, 3, label);
  }
});

test("step reports bind real start, completion and exception events to checkpoint SHA without chat delivery claims", async (t) => {
  const { cp, taskStore } = await fixture(t);
  const before = await cp.show("fixture", "A-10");
  const args = {
    operationId: "fixture.report." + String(sequence++).padStart(8, "0"),
    expectedSha256: before.sha256, stepId: "C01_SCAN", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller_ai.session", result: "PROGRESS",
    substepId: "START_C01_SCAN", evidence: "controller actually started this inspection step"
  };
  const started = await cp.record("fixture", "A-10", args);
  const history = await taskStore.taskHistory("fixture", "A-10", { all: true });
  const start = history.find((event) => event.event_type === "step_report_started"
    && event.metadata?.stepOperationId === args.operationId);
  assert.ok(start, "real event must be persisted before checkpoint advances");
  assert.equal(start.metadata.expectedCheckpointSha256, started.sha256);
  assert.equal(start.metadata.priorCheckpointSha256, before.sha256);
  assert.equal(start.metadata.chatDeliveryStatus, "unknown");
  assert.equal(start.actor_id, args.actorId);
  assert.equal(start.session_id, args.sessionId);
  const replay = await cp.record("fixture", "A-10", args);
  assert.equal(replay.duplicate, true);
  assert.equal((await taskStore.taskHistory("fixture", "A-10", { all: true }))
    .filter((event) => event.metadata?.stepOperationId === args.operationId).length, 1);
  const completed = await step(cp, "controller_ai", "C01_SCAN");
  const blocked = await step(cp, "controller_ai", "C02_TRIAGE", { result: "BLOCK" });
  const later = await taskStore.taskHistory("fixture", "A-10", { all: true });
  const completeEvent = later.find((event) => event.event_type === "step_report_complete"
    && event.metadata?.stepOperationId === completed.state.lastAction.operationId);
  const blockedEvent = later.find((event) => event.event_type === "step_report_exception"
    && event.metadata?.stepOperationId === blocked.state.lastAction.operationId);
  assert.equal(completeEvent?.metadata?.expectedCheckpointSha256, completed.sha256);
  assert.equal(blockedEvent?.metadata?.expectedCheckpointSha256, blocked.sha256);
  assert.equal(blockedEvent?.metadata?.result, "BLOCK");
  assert.ok(!later.some((event) => event.event_type === "user_message_ack"
    && event.metadata?.stepOperationId), "step reporting cannot forge chat acknowledgement");
});

test("step report storage failure and forged report reuse must not advance the checkpoint", async (t) => {
  const { cp, taskStore } = await fixture(t);
  const before = await cp.show("fixture", "A-10");
  const args = {
    operationId: "fixture.failreport." + String(sequence++).padStart(8, "0"),
    expectedSha256: before.sha256, stepId: "C01_SCAN", actorType: "controller_ai",
    actorId: "controller", sessionId: "controller_ai.session", result: "PASS",
    evidence: "confirmed controller step evidence before event write"
  };
  const original = taskStore.appendTaskEvent.bind(taskStore);
  taskStore.appendTaskEvent = async () => { throw Object.assign(new Error("audit unavailable"), { code: "AUDIT_UNAVAILABLE" }); };
  await assert.rejects(cp.record("fixture", "A-10", args), /audit unavailable/);
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
  taskStore.appendTaskEvent = original;
  await taskStore.appendTaskEvent("fixture", "A-10", {
    operationId: "step.report." + args.operationId,
    eventType: "step_report_complete", actorType: "controller_ai",
    actorId: "forged-controller", sessionId: args.sessionId,
    metadata: { stepOperationId: args.operationId, expectedCheckpointSha256: "0".repeat(64) }
  });
  await assert.rejects(cp.record("fixture", "A-10", args),
    (error) => error.code === "CHECKPOINT_REPORT_CONFLICT");
  assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256);
});
