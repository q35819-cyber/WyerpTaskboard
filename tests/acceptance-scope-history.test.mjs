import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

test("snapshot preserves each task acceptance scope beyond the project-wide recent-event window", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  await fs.writeFile(fixture.registryPath, registryText([
    ["A-10", "F-001", "product", "P0", "待开发", "开发AI", "—", "—", "—", "—", "用户验收范围历史", "plan.md", "cp/A-10.md"],
    ["B-10", "F-002", "product", "P0", "待用户验收", "用户", "—", "—", "—", "2026-10-31T00:00:00.000Z", "系统验收范围历史", "plan.md", "cp/B-10.md"]
  ]), "utf8");
  const eventDir = path.join(fixture.boardRoot, "data", "events", "fixture");
  await fs.mkdir(eventDir, { recursive: true });
  const events = [{
    operation_id: "scope.user.created.0001",
    event_id: "evt_scope_user_created_0001",
    project_id: "fixture",
    task_id: "A-10",
    event_type: "task_created",
    timestamp: "2026-10-31T00:00:00.000Z",
    actor_type: "system",
    actor_id: "fixture",
    metadata: { acceptanceScope: "user_ui_business" }
  }, {
    operation_id: "scope.system.created.0001",
    event_id: "evt_scope_system_created_0001",
    project_id: "fixture",
    task_id: "B-10",
    event_type: "task_created",
    timestamp: "2026-10-31T00:00:00.500Z",
    actor_type: "system",
    actor_id: "fixture",
    metadata: { acceptanceScope: "system" }
  }];
  for (let index = 0; index < 1000; index++) {
    events.push({
      operation_id: `noise.event.${String(index).padStart(4, "0")}`,
      event_id: `evt_noise_${String(index).padStart(4, "0")}`,
      project_id: "fixture",
      task_id: "B-10",
      event_type: "comment",
      timestamp: new Date(Date.parse("2026-10-31T00:00:01.000Z") + index).toISOString(),
      actor_type: "system",
      actor_id: "fixture",
      metadata: null
    });
  }
  await fs.writeFile(path.join(eventDir, "2026-10-31-001.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");

  const store = await new TaskStore(fixture.boardRoot).init();
  const snapshot = await store.snapshot("fixture");
  assert.equal(snapshot.tasks.find((task) => task.id === "A-10").acceptanceScope, "user_ui_business");
  assert.equal(snapshot.tasks.find((task) => task.id === "B-10").acceptanceScope, "system");
  await assert.rejects(() => store.updateTask("fixture", "B-10", { status: "已完成" }, {
    expectedRevision: snapshot.registryRevision,
    operationId: "scope.system.user-accept.denied.0001",
    eventType: "user_accept",
    actorType: "user",
    actorId: "local-user"
  }), (error) => error.code === "USER_ACCEPTANCE_STAGE_REQUIRED");
});
