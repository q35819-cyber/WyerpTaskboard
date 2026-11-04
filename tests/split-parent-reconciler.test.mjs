import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { TaskStore } from "../server/task-store.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";
import { SplitParentReconciler, approvedSplitParents } from "../server/split-parent-reconciler.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

let sequence = 0;
const parentIds = Object.keys(approvedSplitParents);
const childIds = id => approvedSplitParents[id].splits.flatMap(split => split.children);
const sha = "a".repeat(40);
const mainSha = "b".repeat(40);

const row = (id, status, track = "bugfix") => [
  id, "F-SPLIT", track, "P0", status, ["HOLD", "阻断", "已完成"].includes(status) ? "—" : "开发AI",
  "—", "—", "—", "—", "split-parent fixture", "plan.md", "trace/" + id,
  "", "write/" + id + ".mjs", "cp/" + id + ".md"
];

async function setup(t, { completed = false, parentStatuses = ["HOLD", "阻断"] } = {}) {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const rows = parentIds.map((id, i) => row(id, parentStatuses[i], i ? "product" : "bugfix"));
  for (const parent of parentIds) {
    rows.push(...childIds(parent).map(id => row(id, completed ? "已完成" : "待开发")));
  }
  rows.push(row("UNRELATED-BLOCKED", "阻断"));
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const store = await new TaskStore(fixture.boardRoot).init();
  const requirements = await new RequirementStore(fixture.boardRoot).init();
  const reconciler = new SplitParentReconciler(store, { requirementStore: requirements });
  const events = async (taskId, type, actor, metadata = {}, eventId = null, note = "") => {
    sequence += 1;
    const timestamp = new Date(Date.parse("2026-11-05T02:00:00Z") + sequence * 1000).toISOString();
    const result = await store.events.append("fixture", {
      event_id: eventId || undefined, operation_id: "fixture.split." + sequence,
      project_id: "fixture", task_id: taskId, event_type: type,
      actor_type: actor, actor_id: actor === "controller_ai" ? "controller" :
        actor === "test_ai" ? "tester" : "user",
      timestamp,
      old_status: type === "delivery_complete" ? "交付中" : type === "test_result" ? "独测中"
        : taskId === parentIds[0] ? "HOLD" : "阻断",
      new_status: type === "delivery_complete" ? "已完成" : type === "test_result" ? "待交付"
        : taskId === parentIds[0] ? "HOLD" : "阻断", metadata, note
    });
    return result.event;
  };
  const split = async (parentId, { omit = null, wrongActor = false } = {}) => {
    for (const item of approvedSplitParents[parentId].splits) {
      if (item.id === omit) continue;
      await events(parentId, item.type, wrongActor ? "user" : "controller_ai",
        {}, item.id, item.children.join("、"));
    }
  };
  const deliver = async (parentId, { missingJournalId = null, badQaId = null,
    incompleteId = null, missingDeliveryId = null } = {}) => {
    for (const id of childIds(parentId)) {
      if (id === incompleteId) continue;
      const qa = await events(id, "test_result", id === badQaId ? "user" : "test_ai", {
        testResult: "pass", commitSha: sha, reportPath: "reports/" + id + "/QA.md"
      });
      if (id === missingDeliveryId) continue;
      const delivery = await events(id, "delivery_complete", "controller_ai", {
        deliveryVerified: true, independentPassEventId: qa.event_id,
        candidateCommitSha: sha, mergeCommitSha: mainSha, remoteMainSha: mainSha,
        postMergeRegressionResult: "PASS", postMergeReportSha256: "c".repeat(64)
      });
      if (id !== missingJournalId) {
        await store.transactions.prepare({
          operationId: delivery.operation_id, projectId: "fixture", taskId: id,
          event: delivery, expectedRevision: "fixture"
        });
        await store.transactions.phase(delivery.operation_id, "committed", {
          eventId: delivery.event_id, result: { eventId: delivery.event_id }
        });
      }
    }
  };
  const approve = async (parentId, overrides = {}) => events(
    parentId, "controller_split_parent_integration_verified", "controller_ai", {
      parentTaskId: parentId, splitEventIds: approvedSplitParents[parentId].splits.map(item => item.id),
      childTaskIds: childIds(parentId), integrationResult: "NO_REMAINING_SCOPE",
      noIndependentIntegrationRequired: true, outstandingIntegrationActions: [],
      ...overrides
    });
  return { ...fixture, store, requirements, reconciler, events, split, deliver, approve };
}
const status = async (store, parentId) => (await store.getTask("fixture", parentId)).task.status;

test("unfinished approved parent cards stay HOLD/blocked and expose exact missing child counts", async t => {
  const x = await setup(t);
  for (const id of parentIds) await x.split(id);
  const findings = await x.reconciler.reconcile("fixture");
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(f => f.children_total), [6, 5]);
  assert.deepEqual(findings.map(f => f.children_remaining), [6, 5]);
  assert.ok(findings.every(f => !f.archived && f.blockers.some(b => b.includes("子任务未完成"))));
  assert.equal(await status(x.store, parentIds[0]), "HOLD");
  assert.equal(await status(x.store, parentIds[1]), "阻断");
  assert.equal(await status(x.store, "UNRELATED-BLOCKED"), "阻断");
  assert.deepEqual((await x.store.taskHistory("fixture", parentIds[0], { all: true }))
    .filter(event => event.event_type === "split_parent_reconciled"), []);
});

test("complete evidence, all child delivery transactions and controller clearance atomically cancel only known parents", async t => {
  const x = await setup(t, { completed: true });
  for (const id of parentIds) {
    await x.split(id);
    await x.deliver(id);
    await x.approve(id);
  }
  const first = await x.reconciler.reconcile("fixture");
  assert.equal(first.length, 2);
  assert.ok(first.every(item => item.archived && item.children_remaining === 0 && item.event_id), JSON.stringify(first));
  assert.equal(await status(x.store, parentIds[0]), "已取消");
  assert.equal(await status(x.store, parentIds[1]), "已取消");
  assert.equal(await status(x.store, "UNRELATED-BLOCKED"), "阻断");
  const second = await x.reconciler.reconcile("fixture");
  assert.ok(second.every(item => item.archived));
  for (const id of parentIds) {
    const history = await x.store.taskHistory("fixture", id, { all: true });
    const archive = history.filter(event => event.event_type === "split_parent_reconciled");
    assert.equal(archive.length, 1, "idempotent archive event");
    assert.equal(archive[0].actor_type, "system");
    assert.equal(archive[0].new_status, "已取消");
    assert.equal((await x.store.transactions.read(archive[0].operation_id)).state, "committed");
  }
});

test("missing QA, missing transaction or no clearance never auto-cancels formally completed children", async t => {
  const x = await setup(t, { completed: true });
  const id = parentIds[0];
  await x.split(id);
  const children = childIds(id);
  await x.deliver(id, { missingJournalId: children[0], badQaId: children[1] });
  await x.approve(id);
  const result = (await x.reconciler.reconcile("fixture"))[0];
  assert.equal(result.archived, false);
  assert.equal(await status(x.store, id), "HOLD");
  assert.ok(result.blockers.some(b => b.includes("交付事务未正式提交")), JSON.stringify(result));
  assert.ok(result.blockers.some(b => b.includes("独测/总控交付证据不足")));
  assert.equal(await status(x.store, parentIds[1]), "阻断");
});

test("wrong split evidence, incomplete work, STOP, outstanding integration or wrong clearance preserve originals", async t => {
  const x = await setup(t, { completed: true });
  const id = parentIds[1];
  await x.split(id, { wrongActor: true });
  await x.deliver(id);
  await x.approve(id, { outstandingIntegrationActions: ["remaining UI acceptance"] });
  await x.events(id, "stop_request", "user");
  const result = (await x.reconciler.reconcile("fixture")).find(f => f.parent_id === id);
  assert.ok(result.blockers.some(b => b.includes("正式拆分事件缺失或不匹配")));
  assert.ok(result.blockers.some(b => b.includes("STOP")));
  assert.ok(result.blockers.some(b => b.includes("总控无剩余")));
  assert.equal(await status(x.store, id), "阻断");
  assert.equal(await status(x.store, "UNRELATED-BLOCKED"), "阻断");
});

test("scanOnce reports the two exact parents without altering incomplete source tasks", async t => {
  const x = await setup(t);
  for (const id of parentIds) await x.split(id);
  const scanner = await new TaskScanner(x.boardRoot, { taskStore: x.store, requirementStore: x.requirements }).init();
  const scan = await scanner.scanOnce();
  assert.equal(scan.state, "completed");
  assert.equal(scan.project_errors, 0);
  assert.deepEqual(scan.split_parent_reconciliation.map(i => i.children_remaining), [6, 5]);
  assert.equal(scan.split_parent_reconciliation.length, 2);
  assert.equal(await status(x.store, parentIds[0]), "HOLD");
  assert.equal(await status(x.store, parentIds[1]), "阻断");
});

test("crash after registry write is recovered by next scan without duplicate cancellation", async t => {
  const x = await setup(t, { completed: true });
  const id = parentIds[0];
  await x.split(id);
  await x.deliver(id);
  await x.approve(id);
  const faultyStore = await new TaskStore(x.boardRoot, { faultAfter: "registry_written" }).init();
  const faulty = new SplitParentReconciler(faultyStore, { requirementStore: x.requirements });
  await assert.rejects(() => faulty.reconcile("fixture"), error => error.code === "INJECTED_CRASH");
  assert.equal(await status(x.store, id), "已取消");
  const recovered = await x.reconciler.reconcile("fixture");
  assert.equal(recovered.find(f => f.parent_id === id).archived, true);
  const history = await x.store.taskHistory("fixture", id, { all: true });
  assert.equal(history.filter(event => event.event_type === "split_parent_reconciled").length, 1);
});
