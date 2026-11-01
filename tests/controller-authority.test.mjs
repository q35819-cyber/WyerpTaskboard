import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

test("developer/QA body role spoof never creates task; separate server-verified controller proof is required", async t => {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, port: 0 });
  await new Promise(ok => app.server.listen(0, "127.0.0.1", ok));
  t.after(async () => {
    await new Promise(ok => app.server.close(ok));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const bearer = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "admin-secret.json"))).adminSecret;
  const proof = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "controller-proof.json"))).proof;
  const headers = { "Authorization": "Bearer " + bearer, "Content-Type": "application/json" };
  const before = await (await fetch(base + "/api/projects/fixture/tasks", { headers })).json();
  const task = { id: "AUTH-CREATE-01", parent: "F", track: "infrastructure", priority: "P0",
    status: "待开发", plannedRole: "开发AI", boundary: "受控创建", plan: "测试计划.md",
    traceability: "tests", readDependencies: "read/auth.md", writeTargets: "server/a.mjs", targets: "cp/A-10.md" };
  const body = JSON.stringify({ operationId: "controller.auth.create.01", expectedRevision: before.registryRevision,
    actorType: "controller_ai", actorId: "spoof-controller", task });
  async function request(customHeaders) {
    const res = await fetch(base + "/api/projects/fixture/tasks", {
      method: "POST", headers: customHeaders, body
    });
    return { code: res.status, response: await res.json() };
  }
  const noProof = await request(headers);
  assert.equal(noProof.code, 403);
  assert.equal(noProof.response.error.code, "CONTROLLER_AUTH_REQUIRED");
  const wrongProof = await request({ ...headers, "X-Wyerp-Controller-Proof": "x".repeat(48) });
  assert.equal(wrongProof.code, 403);
  assert.equal(wrongProof.response.error.code, "CONTROLLER_AUTH_REQUIRED");
  const fakeBrowser = await request({ Origin: base, "Content-Type": "application/json", "X-Wyerp-Controller-Proof": proof });
  assert.equal(fakeBrowser.code, 403);
  assert.equal(fakeBrowser.response.error.code, "CONTROLLER_AUTH_REQUIRED");
  const unchanged = await (await fetch(base + "/api/projects/fixture/tasks", { headers })).json();
  assert.equal(unchanged.registryRevision, before.registryRevision);
  assert.equal(unchanged.tasks.some(item => item.id === task.id), false);
  const allowed = await request({ ...headers, "X-Wyerp-Controller-Proof": proof });
  assert.equal(allowed.code, 201, JSON.stringify(allowed.response));
  assert.equal(allowed.response.task.id, task.id);
  assert.equal(allowed.response.task.assignee, "");
  assert.equal(allowed.response.task.sessionId, "");
  const events = (await (await fetch(base + "/api/projects/fixture/tasks/" + task.id + "/history", { headers })).json()).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_type, "controller_ai");
  assert.equal(events[0].event_type, "task_created");
});
