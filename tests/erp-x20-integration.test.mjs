import test from "node:test";
import assert from "node:assert/strict";
import { TaskStore } from "../server/task-store.mjs";
import path from "node:path";

test("real erp-x20 registry is readable through independent project mapping", {
  skip: process.env.WYERP_ERP_X20_INTEGRATION !== "1" && "external ERP not registered: set WYERP_ERP_X20_INTEGRATION=1 to test real connection"
}, async () => {
  const store = await new TaskStore(process.env.WYERP_ERP_X20_TASKBOARD_ROOT || path.resolve(import.meta.dirname,"..")).init();
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
