import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventStore } from "../server/event-store.mjs";

test("event store rotates and logically seals completed segment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-event-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root, { maxSegmentBytes: 1 });

  await store.append("p1", {
    operation_id: "event.rotate.001",
    project_id: "p1",
    task_id: "T1",
    event_type: "developer_note",
    actor_type: "developer_ai",
    actor_id: "dev"
  });
  await store.append("p1", {
    operation_id: "event.rotate.002",
    project_id: "p1",
    task_id: "T1",
    event_type: "developer_note",
    actor_type: "developer_ai",
    actor_id: "dev"
  });

  const dir = path.join(root, "data", "events", "p1");
  const manifests = (await fs.readdir(dir)).filter((x) => x.endsWith(".manifest.json")).sort();
  assert.equal(manifests.length, 2);
  const first = JSON.parse(await fs.readFile(path.join(dir, manifests[0]), "utf8"));
  const second = JSON.parse(await fs.readFile(path.join(dir, manifests[1]), "utf8"));
  assert.equal(first.sealed, true);
  assert.equal(second.sealed, false);
  assert.equal((await store.verifyProject("p1")).ok, true);
});