import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

async function startFixture(t) {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  const auth = JSON.parse(await fs.readFile(fixture.boardRoot + "/config/admin-secret.json", "utf8"));
  const login = await fetch(base + "/api/auth/session");
  const loginBody = await login.json();
  const cookie = "";
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  return {
    fixture, base, secret: auth.adminSecret, cookie,
    browserHeaders: { Origin: base, "Content-Type": "application/json" },
    bearerHeaders: { Authorization: "Bearer " + auth.adminSecret, "Content-Type": "application/json" }
  };
}

test("takeover needs explicit user authorization and preserves execution status", async (t) => {
  const fx = await startFixture(t);
  let task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();

  const denied = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({
      operationId: "takeover.denied.001",
      expectedRevision: task.registryRevision,
      assignee: "new-worker",
      sessionWindowName: "新窗口",
      sessionId: "wc_sess_new"
    })
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "TAKEOVER_NOT_ALLOWED");

  const suspected = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover/suspect", {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({
      operationId: "takeover.suspect.001",
      note: "原Session无法恢复；已核对无活跃Job和未完成写入"
    })
  });
  assert.equal(suspected.status, 200);

  const bearerAllow = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover/allow", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "takeover.allow.bearer.001", note: "invalid" })
  });
  assert.equal(bearerAllow.status, 403);
  assert.equal((await bearerAllow.json()).error.code, "USER_SESSION_REQUIRED");

  const allowed = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover/allow", {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({
      operationId: "takeover.allow.001",
      note: "用户确认现场已重新核验，允许一次异常接管"
    })
  });
  assert.equal(allowed.status, 200);

  task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();
  assert.equal(task.takeover.suspectedDisconnect, true);
  assert.equal(task.takeover.takeoverAllowed, true);

  const takeover = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({
      operationId: "takeover.execute.001",
      expectedRevision: task.registryRevision,
      assignee: "new-worker",
      sessionWindowName: "B-10异常接管窗口",
      sessionId: "wc_sess_new",
      actorType: "developer_ai",
      actorId: "new-worker",
      note: "按用户一次性授权接管"
    })
  });
  assert.equal(takeover.status, 200);
  const result = await takeover.json();
  assert.equal(result.after.status, "开发中");
  assert.equal(result.after.assignee, "new-worker");
  assert.equal(result.after.sessionId, "wc_sess_new");

  const after = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();
  assert.equal(after.takeover.suspectedDisconnect, false);
  assert.equal(after.takeover.takeoverAllowed, false);
});

test("explicit current chat user authorization can replace browser clicking, scoped and audited", async (t) => {
  const fx = await startFixture(t);
  const path = fx.base + "/api/projects/fixture/tasks/B-10/takeover";
  const who = { actorType: "developer_ai", actorId: "chat-ai", sessionWindowName: "ChatGPT当前会话", sessionId: "wc_sess_chat" };
  const suspect = await fetch(path + "/suspect", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "chat.suspect.01", ...who, note: "原Session无法恢复、无活动Job、无未结写入；已核对资源" })
  });
  assert.equal(suspect.status, 200);
  const allow = async (operationId, chatAuthorization) => fetch(path + "/allow", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId, ...who, note: "用户在当前对话中明确授权接管", chatAuthorization })
  });
  const valid = { source: "direct_user_message", projectId: "fixture", taskId: "B-10", scope: "task", quote: "我允许异常接管 B-10" };
  for (const [id, proof] of [
    ["chat.denied.scope", { ...valid, taskId: "OTHER" }],
    ["chat.denied.source", { ...valid, source: "ai_inference" }],
    ["chat.denied.negative", { ...valid, quote: "不允许异常接管 B-10" }],
    ["chat.denied.not-permitted", { ...valid, quote: "我不可以异常接管 B-10" }],
    ["chat.denied.not-approved", { ...valid, quote: "我没有允许异常接管 B-10" }],
    ["chat.denied.not-needed", { ...valid, quote: "不需要异常接管，你自行处理" }],
    ["chat.denied.mixed", { ...valid, quote: "有需要异常接管你自行处理，但不要执行" }],
    ["chat.denied.project", { ...valid, projectId: "another" }]
  ]) {
    const denied = await allow(id, proof);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, "USER_SESSION_REQUIRED");
  }
  const authorized = await allow("chat.allow.01", valid);
  assert.equal(authorized.status, 200);
  const task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();
  const taken = await fetch(path, {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "chat.execute.01", expectedRevision: task.registryRevision, assignee: "chat-ai", ...who })
  });
  assert.equal(taken.status, 200);
  assert.equal((await taken.json()).after.assignee, "chat-ai");
  const history = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10/history", { headers: fx.bearerHeaders })).json();
  const events = Array.isArray(history) ? history : (history.events || []);
  assert.equal(events.find((event) => event.event_type === "takeover_allowed")?.metadata?.authorizationSource, "chat_user_instruction_cooperative");
  const replay = await fetch(path, {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "chat.execute.replay", expectedRevision: (await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json()).registryRevision, assignee: "other-ai", ...who })
  });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "TAKEOVER_NOT_ALLOWED");
});

test("browser-signed standing authorization allows verified disconnect without a new quote, and revocation is effective", async (t) => {
  const fx = await startFixture(t);
  const standing = fx.base + "/api/projects/fixture/takeover/standing-authorization";
  const takeover = fx.base + "/api/projects/fixture/tasks/B-10/takeover";
  const who = { actorType: "developer_ai", actorId: "standing-dev", sessionWindowName: "standing dev", sessionId: "wc_sess_standing_new" };
  const browserGrant = (operationId, action, roles = []) => fetch(standing, {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId, action, roles })
  });
  const bearerGrant = await fetch(standing, {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.spoof.001", action: "grant", roles: ["developer_ai"] })
  });
  assert.equal(bearerGrant.status, 403);
  assert.equal((await bearerGrant.json()).error.code, "USER_SESSION_REQUIRED");
  const initial = await (await fetch(standing, { headers: fx.bearerHeaders })).json();
  assert.equal(initial.enabled, false);
  assert.equal(initial.requiresBrowserRegistration, true);

  const granted = await browserGrant("standing.grant.001", "grant", ["developer_ai"]);
  assert.equal(granted.status, 200);
  const registered = await granted.json();
  assert.equal(registered.enabled, true);
  assert.ok(registered.grantEventId);
  const suspect = await fetch(takeover + "/suspect", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.suspect.001", ...who, note: "已核查旧 Session 失联，无正在执行的作业" })
  });
  assert.equal(suspect.status, 200);
  const allow = (operationId, quote) => fetch(takeover + "/allow", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId, ...who, note: "系统核验后依用户持久授权接管",
      ...(quote ? { chatAuthorization: { source: "direct_user_message", projectId: "fixture", taskId: "B-10",
        scope: "task", quote } } : {}) })
  });
  const permitted = await allow("standing.allow.001", "开发中有失联的");
  assert.equal(permitted.status, 200);
  const history = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10/history", { headers: fx.bearerHeaders })).json();
  const approval = history.events.find(event => event.event_type === "takeover_allowed");
  assert.equal(approval.metadata.authorizationSource, "browser_user_session");
  assert.equal(approval.metadata.authorizationScope, "task");
  assert.equal(approval.metadata.standingGrantEventId, registered.grantEventId);

  const revoked = await browserGrant("standing.revoke.001", "revoke");
  assert.equal(revoked.status, 200);
  assert.equal((await revoked.json()).enabled, false);
  let task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json();
  const blocked = await fetch(takeover, {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.execute.denied", expectedRevision: task.registryRevision,
      assignee: "standing-dev", ...who })
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "TAKEOVER_STANDING_AUTH_REVOKED");
  const afterBlocked = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json();
  assert.equal(afterBlocked.sessionId, task.sessionId);

  const grantedAgain = await browserGrant("standing.grant.002", "grant", ["developer_ai", "test_ai"]);
  assert.equal(grantedAgain.status, 200);
  assert.equal((await allow("standing.allow.002")).status, 200);
  task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json();
  const taken = await fetch(takeover, {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.execute.ok", expectedRevision: task.registryRevision,
      assignee: "standing-dev", ...who })
  });
  assert.equal(taken.status, 200);
  assert.equal((await taken.json()).after.sessionId, who.sessionId);
});

test("standing grant is role-scoped and denies forged, stale, and mismatched actor evidence", async (t) => {
  const fx = await startFixture(t);
  const standing = fx.base + "/api/projects/fixture/takeover/standing-authorization";
  const url = fx.base + "/api/projects/fixture/tasks/B-10/takeover";
  const who = { actorType: "developer_ai", actorId: "fresh-dev", sessionId: "wc_sess_fresh", sessionWindowName: "new worker" };
  const grant = await fetch(standing, { method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "standing.r2.grant", action: "grant", roles: ["developer_ai"] }) });
  assert.equal(grant.status, 200);
  const duplicateWrongAction = await fetch(standing, { method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "standing.r2.grant", action: "revoke" }) });
  assert.equal(duplicateWrongAction.status, 409);
  const forgedEvent = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/events", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.r2.forge", eventType: "takeover_standing_granted",
      actorType: "user", actorId: "forged", metadata: { authorizationSource: "browser_user_session", scope: "project" } })
  });
  assert.equal(forgedEvent.status, 403);
  assert.equal((await fetch(url + "/suspect", { method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.r2.suspect", ...who, note: "核对旧Session确实停滞" }) })).status, 200);
  const allow = async (operationId, identity, chatAuthorization) => fetch(url + "/allow", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId, ...identity, note: "核验失联后申请常设授权", ...(chatAuthorization ? { chatAuthorization } : {}) })
  });
  assert.equal((await allow("standing.r2.qa", { ...who, actorType: "test_ai" })).status, 403);
  assert.equal((await allow("standing.r2.old", { ...who, actorId: "dev", sessionId: "wc_sess_test" })).status, 409);
  assert.equal((await allow("standing.r2.negative", who, { source: "direct_user_message", projectId: "fixture",
    taskId: "B-10", scope: "task", quote: "不允许接管" })).status, 403);
  assert.equal((await allow("standing.r2.wrongtask", who, { source: "direct_user_message", projectId: "fixture",
    taskId: "OTHER", scope: "task", quote: "开发中有失联的" })).status, 403);
  const authorized = await allow("standing.r2.ok", who);
  assert.equal(authorized.status, 200);
  const task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json();
  const crossActor = await fetch(url, { method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.r2.crossactor", expectedRevision: task.registryRevision,
      ...who, actorId: "fake-dev", assignee: "fake-dev" }) });
  assert.equal(crossActor.status, 409);
  assert.equal((await crossActor.json()).error.code, "TAKEOVER_STANDING_CONTEXT_INVALID");
  const after = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: fx.bearerHeaders })).json();
  assert.equal(after.sessionId, task.sessionId);
});

test("standing authorization cannot override a browser STOP request", async (t) => {
  const fx = await startFixture(t);
  const route = fx.base + "/api/projects/fixture/tasks/B-10";
  const grant = await fetch(fx.base + "/api/projects/fixture/takeover/standing-authorization", {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "standing.stop.grant", action: "grant", roles: ["developer_ai"] })
  });
  assert.equal(grant.status, 200);
  const initial = await (await fetch(route, { headers: fx.bearerHeaders })).json();
  const who = { actorType: "developer_ai", actorId: "new-dev", sessionId: "wc_sess_new", sessionWindowName: "new dev" };
  assert.equal((await fetch(route + "/takeover/suspect", { method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.stop.suspect", ...who, note: "旧会话无可核实进展" }) })).status, 200);
  const stop = await fetch(route + "/stop", { method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "standing.stop.request", expectedRevision: initial.registryRevision,
      note: "用户要求停止" }) });
  assert.equal(stop.status, 202);
  const denied = await fetch(route + "/takeover/allow", { method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({ operationId: "standing.stop.deny", ...who, note: "尝试使用常设授权" }) });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "TAKEOVER_STANDING_STOP_REQUESTED");
  const after = await (await fetch(route, { headers: fx.bearerHeaders })).json();
  assert.equal(after.sessionId, initial.sessionId);
  assert.equal(after.takeover.takeoverAllowed, false);
});

test("takeover authorization expires when registry revision changes", async (t) => {
  const fx = await startFixture(t);
  let task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();

  assert.equal((await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover/suspect", {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "takeover.stale.suspect.001", note: "现场核验" })
  })).status, 200);

  assert.equal((await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover/allow", {
    method: "POST", headers: fx.browserHeaders,
    body: JSON.stringify({ operationId: "takeover.stale.allow.001", note: "允许一次异常接管" })
  })).status, 200);

  const priority = await fetch(fx.base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH", headers: fx.browserHeaders,
    body: JSON.stringify({
      operationId: "takeover.stale.priority.001",
      expectedRevision: task.registryRevision,
      eventType: "priority_change",
      patch: { priority: "P1" },
      note: "并发修改使旧接管授权失效"
    })
  });
  assert.equal(priority.status, 200);

  task = await (await fetch(fx.base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: fx.cookie } })).json();
  const response = await fetch(fx.base + "/api/projects/fixture/tasks/B-10/takeover", {
    method: "POST", headers: fx.bearerHeaders,
    body: JSON.stringify({
      operationId: "takeover.stale.execute.001",
      expectedRevision: task.registryRevision,
      assignee: "new-worker",
      sessionWindowName: "新窗口",
      sessionId: "wc_sess_new",
      actorType: "developer_ai",
      actorId: "new-worker"
    })
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "TAKEOVER_AUTHORIZATION_STALE");
});
