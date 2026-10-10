import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../server/task-store.mjs";

test("real erp-x20 registry is readable through independent project mapping", async () => {
  const store = await new TaskStore("D:\\WyerpTaskboard").init();
  const health = await store.projects.health("erp-x20");
  assert.equal(health.status, "healthy");
  const snap = await store.snapshot("erp-x20");
  const b10 = snap.tasks.find((task) => task.id === "B-10");
  assert.ok(b10);
  assert.equal(b10.track, "infrastructure");
  assert.ok(typeof b10.status === "string" && b10.status.length > 0);
  assert.equal(Boolean(b10.assignee), Boolean(b10.sessionId));
  if (b10.assignee) {
    assert.ok(b10.sessionWindowName);
    assert.match(b10.sessionId, /^wc_sess_/);
  }
  assert.match(snap.registryRevision, /^[a-f0-9]{64}$/);
});
