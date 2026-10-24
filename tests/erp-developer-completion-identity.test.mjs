import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

test("ERP atomic developer handoff requires the claimed developer, not a CLI alias", async t => {
  const fixture = await makeFixture();
  const root = fixture.boardRoot;
  const configPath = path.join(root, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.projects[0].id = "erp-x20";
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  const app = await createTaskboardServer({ rootDir: root, host: "127.0.0.1", port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = "http://127.0.0.1:" + app.server.address().port;
  const secret = JSON.parse(await fs.readFile(path.join(root, "config", "admin-secret.json"), "utf8")).adminSecret;
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const route = "/api/projects/erp-x20/tasks/A-10";
  let counter = 0;
  const request = async (suffix, payload) => {
    const response = await fetch(base + route + suffix, {
      method: "POST", headers,
      body: JSON.stringify({ operationId: "erp.developer.proof." + (++counter), ...payload })
    });
    return { status: response.status, body: await response.json() };
  };
  const get = async () => {
    const response = await fetch(base + route, { headers });
    assert.equal(response.status, 200);
    return response.json();
  };

  const developer = "developer-real", sessionId = "dev-real-session";
  const preclaim = await request("/preclaim-report", {
    actorType: "developer_ai", actorId: developer, sessionId,
    note: "已向用户汇报当前ERP开发任务、项目范围和实施边界"
  });
  assert.equal(preclaim.status, 200);
  const claimed = await request("/claim", {
    expectedRevision: (await get()).registryRevision,
    actorType: "developer_ai", actorId: developer, sessionId,
    assignee: developer, sessionWindowName: "真实ERP开发AI"
  });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.body.after.status, "开发中");

  for (const invalidActor of ["taskctl", "developer-forged", ""]) {
    const reply = await request("/complete-execution", {
      expectedRevision: (await get()).registryRevision,
      actorType: "developer_ai", actorId: invalidActor, sessionId
    });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error.code, "DEVELOPER_COMPLETION_IDENTITY_MISMATCH");
    assert.equal((await get()).status, "开发中");
  }

  const completed = await request("/complete-execution", {
    expectedRevision: (await get()).registryRevision,
    actorType: "developer_ai", actorId: developer, sessionId
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.after.status, "待独测");

  const historyResponse = await fetch(base + route + "/history?limit=100", { headers });
  assert.equal(historyResponse.status, 200);
  const events = (await historyResponse.json()).events;
  const handoff = events.find(e => e.event_type === "handoff");
  assert.equal(handoff.actor_id, developer);
  assert.equal(handoff.metadata.releasedAssignee, developer);
  assert.equal(handoff.metadata.releasedSessionId, sessionId);
});
