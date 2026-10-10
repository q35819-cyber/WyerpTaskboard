import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture } from "./helpers.mjs";

async function crashAt(t, phase, operationId) {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const crashStore = await new TaskStore(f.boardRoot, { faultAfter: phase }).init();
  const before = await crashStore.snapshot("fixture");
  await assert.rejects(
    crashStore.updateTask("fixture", "B-10", { priority: "P1" }, {
      expectedRevision: before.registryRevision,
      operationId,
      eventType: "priority_change"
    }),
    (error) => error.code === "INJECTED_CRASH"
  );
  return { f, before };
}

test("prepared crash leaves registry untouched and recovers as no-effect abort", async (t) => {
  const { f, before } = await crashAt(t, "prepared", "op.crash.prepared");
  const store = await new TaskStore(f.boardRoot).init();
  const results = await store.recoverPendingTransactions();
  assert.equal(results[0].action, "aborted_no_effect");
  assert.equal((await store.snapshot("fixture")).registryRevision, before.registryRevision);
  assert.equal(await store.events.findByOperationId("fixture", "op.crash.prepared"), null);
});

test("registry-written crash appends missing event and commits", async (t) => {
  const { f, before } = await crashAt(t, "registry_written", "op.crash.registry");
  const store = await new TaskStore(f.boardRoot).init();
  const mid = await store.snapshot("fixture");
  assert.notEqual(mid.registryRevision, before.registryRevision);
  assert.equal(await store.events.findByOperationId("fixture", "op.crash.registry"), null);
  const results = await store.recoverPendingTransactions();
  assert.equal(results[0].action, "append_missing_event");
  assert.ok(await store.events.findByOperationId("fixture", "op.crash.registry"));
  assert.equal((await store.transactions.read("op.crash.registry")).state, "committed");
});

test("event-written crash commits without duplicating event", async (t) => {
  const { f } = await crashAt(t, "event_written", "op.crash.event");
  const store = await new TaskStore(f.boardRoot).init();
  assert.ok(await store.events.findByOperationId("fixture", "op.crash.event"));
  const results = await store.recoverPendingTransactions();
  assert.equal(results[0].action, "commit_existing_event");
  assert.equal((await store.events.verifyProject("fixture")).events, 1);
  assert.equal((await store.transactions.read("op.crash.event")).state, "committed");
});
