import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parseRegistryText, patchRegistryText, appendRegistryTaskText } from "../server/adapters/markdown-task-registry-v1.mjs";
import { hardDependencyBlockers } from "../server/candidate-evaluator.mjs";
import { getWorkflowProfile } from "../server/workflows/index.mjs";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

const workflow = getWorkflowProfile("wyerp-ai-flow-v1");
test("structured dependsOn persists via safe migration while old descriptions stay intact", () => {
  const source = registryText();
  const old = parseRegistryText(source);
  assert.equal(old.indexes.dependsOn, -1);
  const changed = patchRegistryText(source, {}, "A-10", { dependsOn: "B-10" }, workflow);
  assert.equal(changed.beforeRevision, old.registryRevision);
  assert.equal(changed.beforeFileSha256, old.fileSha256);
  assert.equal(changed.after.dependsOn, "B-10");
  assert.equal(changed.after.readDependencies, "read/A-10.md");
  assert.ok(changed.text.includes("| 前置任务ID |"));
  const reloaded = parseRegistryText(changed.text);
  assert.equal(reloaded.tasks.find(t => t.id === "A-10").dependsOn, "B-10");
  assert.equal(reloaded.tasks.find(t => t.id === "B-10").dependsOn, "");
  assert.equal(patchRegistryText(changed.text, {}, "A-10", { dependsOn: "B-10" }, workflow).after.dependsOn, "B-10");
});

test("new task dependsOn can add a column without breaking legacy registration rows", () => {
  const source = registryText();
  const item = { id: "NEW-1", parent: "F", track: "product", priority: "P1",
    status: "待开发", plannedRole: "开发AI", boundary: "测试", plan: "测试计划.md",
    traceability: "tests", writeTargets: "server/a.mjs", targets: "cp/A-10.md", dependsOn: "A-10" };
  const out = appendRegistryTaskText(source, {}, item);
  assert.equal(out.task.dependsOn, "A-10");
  assert.equal(parseRegistryText(out.text).tasks.length, parseRegistryText(source).tasks.length + 1);
  assert.ok(out.beforeRevision !== out.afterRevision);
});

test("server guard and claim reject unmet dependency without writing history; recovered prerequisite unlocks", async t => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  const input = await fs.readFile(f.registryPath, "utf8");
  const migrated = patchRegistryText(input, {}, "A-10", { dependsOn: "B-10" }, workflow);
  await fs.writeFile(f.registryPath, migrated.text);
  const app = await createTaskboardServer({ rootDir: f.boardRoot, port: 0 });
  await new Promise(ok => app.server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise(ok => app.server.close(ok)));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const secret = JSON.parse(await fs.readFile(path.join(f.boardRoot, "config", "admin-secret.json"))).adminSecret;
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const snapshot = await (await fetch(base + "/api/projects/fixture/tasks", { headers })).json();
  const guard = await (await fetch(base + "/api/projects/fixture/tasks/A-10/guard", { headers })).json();
  assert.equal(guard.dependencyBlockers.length, 1);
  assert.match(guard.dependencyBlockers[0], /B-10/);
  const response = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", { method: "POST", headers,
    body: JSON.stringify({ operationId: "dep.block.claim.01", expectedRevision: snapshot.registryRevision,
      actorType: "developer_ai", actorId: "dev-A", assignee: "dev-A", sessionId: "wc_sess_dev_a",
      sessionWindowName: "dev-A" }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "TASK_DEPENDENCY_INCOMPLETE");
  assert.equal((await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers })).json()).status, "待开发");
  const events = (await (await fetch(base + "/api/projects/fixture/tasks/A-10/history", { headers })).json()).events;
  assert.equal(events.length, 0);
  const releasedText = (await fs.readFile(f.registryPath, "utf8")).replace(/(\| B-10 \|[^\r\n]*?\| )开发中( \|)/, "$1已完成$2");
  assert.notEqual(releasedText, migrated.text);
  await fs.writeFile(f.registryPath, releasedText);
  const ready = await (await fetch(base + "/api/projects/fixture/tasks/A-10/guard", { headers })).json();
  assert.deepEqual(ready.dependencyBlockers, []);
});

test("self, invalid, missing and incomplete prerequisites always block", () => {
  const map = new Map([["A-10", { id: "A-10", status: "待开发" }], ["B-10", { id: "B-10", status: "HOLD" }]]);
  assert.match(hardDependencyBlockers({ id: "A-10", dependsOn: "A-10" }, map)[0], /不能依赖自身/);
  assert.match(hardDependencyBlockers({ id: "A-10", dependsOn: "B-10" }, map)[0], /未完成/);
  assert.match(hardDependencyBlockers({ id: "A-10", dependsOn: "NOT-HERE" }, map)[0], /未登记/);
  assert.match(hardDependencyBlockers({ id: "A-10", dependsOn: "../INVALID" }, map)[0], /非法/);
});
