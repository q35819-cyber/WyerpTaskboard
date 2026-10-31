import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

async function startFixture(t, serverOptions = {}) {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0, ...serverOptions });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const port = app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  const secret = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "admin-secret.json"), "utf8")).adminSecret;
  const base = `http://127.0.0.1:${port}`;
  return { fixture, app, port, base, secret };
}

async function login(base, secret) {
  const response = await fetch(base + "/api/auth/session");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "session");
  assert.ok(body.csrfToken);
  return { cookie: "", csrf: body.csrfToken };
}

let preclaimSequence = 0;
async function recordPreclaim(base, secret, taskId, {
  actorType = "developer_ai",
  actorId,
  sessionId,
  note = "已向用户汇报任务ID、主要内容、当前阶段/可认领依据和本轮边界"
} = {}) {
  const response = await fetch(base + "/api/projects/fixture/tasks/" + encodeURIComponent(taskId) + "/preclaim-report", {
    method: "POST",
    headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "preclaim.http." + (++preclaimSequence) + ".fixture",
      actorType, actorId, sessionId, note
    })
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("taskboard opens without a password and retires the legacy login endpoint", async (t) => {
  const { base } = await startFixture(t);
  assert.equal((await fetch(base + "/healthz")).status, 200);
  const projects = await fetch(base + "/api/projects");
  assert.equal(projects.status, 200);
  assert.equal((await projects.json()).projects[0].id, "fixture");
  const legacyLogin = await fetch(base + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ secret: "not-used" })
  });
  assert.equal(legacyLogin.status, 410);
  assert.equal((await legacyLogin.json()).error.code, "LOGIN_DISABLED");
});

test("local browser access lists projects without a password and rejects bad origin", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie } = await login(base, secret);
  const ok = await fetch(base + "/api/projects", { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).projects[0].id, "fixture");
  const bad = await fetch(base + "/api/projects", {
    headers: { Cookie: cookie, Origin: "http://evil.invalid" },
  });
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).error.code, "ORIGIN_REJECTED");
});

test("browser user write is not blocked by stale registry revision", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);

  const opened = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();
  const staleRevision = opened.registryRevision;

  const aiChanged = await fetch(base + "/api/projects/fixture/tasks/A-10", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "http.ai.registry.moves.0001",
      expectedRevision: staleRevision,
      eventType: "priority_change",
      actorType: "developer_ai",
      actorId: "dev-a",
      patch: { priority: "P1" }
    })
  });
  assert.equal(aiChanged.status, 200);

  const userChanged = await fetch(base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "http.user.stale.never.blocked.0001",
      expectedRevision: staleRevision,
      eventType: "priority_change",
      patch: { priority: "P2" }
    })
  });
  assert.equal(userChanged.status, 200);
  const userBody = await userChanged.json();
  assert.equal(userBody.after.priority, "P2");

  const a = await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers: { Cookie: cookie } })).json();
  const b = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();
  assert.equal(a.priority, "P1", "AI change must survive user rebase");
  assert.equal(b.priority, "P2", "user action must succeed without refreshing stale dialog");

  const staleAi = await fetch(base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "http.ai.stale.still.rejected.0001",
      expectedRevision: staleRevision,
      eventType: "priority_change",
      actorType: "developer_ai",
      actorId: "dev-b",
      patch: { priority: "P1" }
    })
  });
  assert.equal(staleAi.status, 409);
  assert.equal((await staleAi.json()).error.code, "REVISION_CONFLICT");
});
test("browser admin can register a local project path and read it immediately", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const extraRoot = path.join(fixture.boardRoot, "extra-project");
  await fs.mkdir(extraRoot, { recursive: true });
  await fs.writeFile(path.join(extraRoot, "待办任务总清单.md"), registryText(), "utf8");

  const denied = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ root: extraRoot, id: "extra-denied" })
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, "BROWSER_ADMIN_REQUIRED");

  const added = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ root: extraRoot, id: "extra", name: "Extra Project" })
  });
  assert.equal(added.status, 201);
  const result = await added.json();
  assert.equal(result.project.id, "extra");
  assert.equal(result.health.status, "healthy");
  assert.equal(result.validation.taskCount, 3);

  const projects = await (await fetch(base + "/api/projects", { headers: { Cookie: cookie } })).json();
  const extra = projects.projects.find((item) => item.id === "extra");
  assert.equal(extra.health.status, "healthy");
  assert.equal(extra.taskRegistry, "待办任务总清单.md");

  const snapshot = await fetch(base + "/api/projects/extra/tasks", { headers: { Cookie: cookie } });
  assert.equal(snapshot.status, 200);
  assert.equal((await snapshot.json()).tasks.length, 3);
});

test("browser PATCH requires CSRF and writes through TaskStore", async (t) => {
  const { base, secret, app } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const snap = await (await fetch(base + "/api/projects/fixture/tasks", { headers: { Cookie: cookie } })).json();

  const noCsrf = await fetch(base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({
      patch: { priority: "P1" },
      expectedRevision: snap.registryRevision,
      operationId: "api.patch.no.csrf.001",
    }),
  });
  assert.equal(noCsrf.status, 403);

  const good = await fetch(base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH",
    headers: {
      Cookie: cookie, Origin: base, "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify({
      patch: { priority: "P1" },
      expectedRevision: snap.registryRevision,
      operationId: "api.patch.good.001",
      eventType: "priority_change",
      note: "api test",
    }),
  });
  assert.equal(good.status, 200);
  const result = await good.json();
  assert.equal(result.after.priority, "P1");
  assert.ok(await app.taskStore.events.findByOperationId("fixture", "api.patch.good.001"));
});

test("bearer auth supports local CLI-style read without ERP auth", async (t) => {
  const { base, secret } = await startFixture(t);
  const response = await fetch(base + "/api/projects", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(response.status, 200);
});


test("automation HTTP start requires a one-time non-injected manual proof", async (t) => {
  const { base, fixture } = await startFixture(t);
  const saved = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "data", "runtime", "automation-control", "control-token.json"), "utf8"));
  const token = encodeURIComponent(saved.token);
  const post = (route, body) => fetch(base + "/api/automation-control/" + route + "?token=" + token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const naked = await post("start", {});
  assert.equal(naked.status, 409);
  assert.equal((await naked.json()).error.code, "AUTOMATION_MANUAL_START_REQUIRED");
  const injected = await post("manual-start-proof", { injected: true, input_type: "mouse" });
  assert.equal(injected.status, 409);
  assert.equal((await injected.json()).error.code, "AUTOMATION_MANUAL_START_PROOF_REJECTED");
  const proofResponse = await post("manual-start-proof", { injected: false, input_type: "mouse" });
  assert.equal(proofResponse.status, 200);
  const proof = await proofResponse.json();
  assert.ok(proof.proof_id);
  const started = await post("start", { proof_id: proof.proof_id });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).running, true);
  const replay = await post("start", { proof_id: proof.proof_id });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error.code, "AUTOMATION_MANUAL_START_REQUIRED");
});

test("static web and workflow metadata are served from independent service", async (t) => {
  const { base, secret } = await startFixture(t);
  const web = await fetch(base + "/");
  assert.equal(web.status, 200);
  assert.match(await web.text(), /独立任务看板/);
  const planIndex = await fetch(base + "/plan-index.mjs");
  assert.equal(planIndex.status, 200);
  assert.match(await planIndex.text(), /buildPlanIndex/);

  const { cookie } = await login(base, secret);
  const workflow = await fetch(base + "/api/projects/fixture/workflow", { headers: { Cookie: cookie } });
  assert.equal(workflow.status, 200);
  const body = await workflow.json();
  assert.equal(body.id, "wyerp-ai-flow-v1");
  assert.ok(body.priorities.includes("P0"));

  assert.deepEqual(body.roles, ["开发AI", "独立测试AI", "用户", "—"]);
  assert.deepEqual(body.boardColumns.find((column) => column.id === "todo"), { id: "todo", title: "待处理 / 待认领", statuses: ["待确认", "待准备", "待开发"], derived: "developer_candidate_state" });


  assert.deepEqual(body.boardColumns.find((column) => column.id === "awaiting_delivery_user")?.statuses, ["待交付", "待用户验收"]);

  assert.equal(body.boardColumns.length, 6);
});

test("session endpoint restores CSRF token for browser refresh", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const response = await fetch(base + "/api/auth/session", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.csrfToken, csrf);
  assert.equal(body.mode, "session");
});

test("user review comment is append-only and does not change registry", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const before = await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers: { Cookie: cookie } })).json();

  const response = await fetch(base + "/api/projects/fixture/tasks/A-10/review", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "review.comment.001", action: "comment", note: "只记录意见" }),
  });
  assert.equal(response.status, 200);

  const after = await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers: { Cookie: cookie } })).json();
  assert.equal(after.status, before.status);
  assert.equal(after.registryRevision, before.registryRevision);

  const history = await (await fetch(base + "/api/projects/fixture/tasks/A-10/history", { headers: { Cookie: cookie } })).json();
  assert.ok(history.events.some((event) => event.operation_id === "review.comment.001"));
});

test("active stop is cooperative request and resume cancels request without fake HOLD", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const task = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();

  const stop = await fetch(base + "/api/projects/fixture/tasks/B-10/stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "stop.request.001",
      expectedRevision: task.registryRevision,
      note: "请求停止",
    }),
  });
  assert.equal(stop.status, 202);
  assert.equal((await stop.json()).cooperative, true);

  const guard1 = await (await fetch(base + "/api/projects/fixture/tasks/B-10/guard", { headers: { Cookie: cookie } })).json();
  assert.equal(guard1.stopRequested, true);
  const stillRunning = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();
  assert.equal(stillRunning.status, "开发中");

  const resume = await fetch(base + "/api/projects/fixture/tasks/B-10/resume", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "stop.resume.001",
      expectedRevision: stillRunning.registryRevision,
      note: "取消停止请求",
    }),
  });
  assert.equal(resume.status, 200);
  const guard2 = await (await fetch(base + "/api/projects/fixture/tasks/B-10/guard", { headers: { Cookie: cookie } })).json();
  assert.equal(guard2.stopRequested, false);
});



test("independent test claim rejects same implementer actor/session and accepts distinct identity", async (t) => {
  const { base, secret } = await startFixture(t);
  const bearer = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };

  const changed = await fetch(base + "/api/projects/fixture/tasks/T-01/events", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.seed.001",
      eventType: "code_change",
      actorType: "developer_ai",
      actorId: "dev-A",
      sessionId: "sess-A",
      sessionWindowName: "实现窗口",
      note: "implementation"
    }),
  });
  assert.equal(changed.status, 200);

  const task = await (await fetch(base + "/api/projects/fixture/tasks/T-01", {
    headers: { Authorization: `Bearer ${secret}` },
  })).json();

  const sameActor = await fetch(base + "/api/projects/fixture/tasks/T-01/claim", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.claim.same.actor.001",
      expectedRevision: task.registryRevision,
      actorType: "test_ai",
      actorId: "dev-A",
      assignee: "tester",
      sessionId: "sess-B",
      sessionWindowName: "独测窗口"
    }),
  });
  assert.equal(sameActor.status, 409);
  assert.equal((await sameActor.json()).error.code, "INDEPENDENT_TEST_CONFLICT");

  const sameSession = await fetch(base + "/api/projects/fixture/tasks/T-01/claim", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.claim.same.session.001",
      expectedRevision: task.registryRevision,
      actorType: "test_ai",
      actorId: "tester-B",
      assignee: "tester",
      sessionId: "sess-A",
      sessionWindowName: "独测窗口"
    }),
  });
  assert.equal(sameSession.status, 409);
  assert.equal((await sameSession.json()).error.code, "INDEPENDENT_TEST_CONFLICT");

  const testerEvidence = await fetch(base + "/api/projects/fixture/tasks/T-01/events", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.test.report.001",
      eventType: "doc_change",
      actorType: "test_ai",
      actorId: "tester-B",
      sessionId: "sess-B",
      sessionWindowName: "独测窗口",
      note: "previous independent test report only"
    }),
  });
  assert.equal(testerEvidence.status, 200);

  const developerDocOnly = await fetch(base + "/api/projects/fixture/tasks/T-01/events", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.developer.doc.only.001",
      eventType: "doc_change",
      actorType: "developer_ai",
      actorId: "tester-B",
      sessionId: "doc-only-session",
      sessionWindowName: "文档窗口",
      note: "governance/report-only documentation"
    }),
  });
  assert.equal(developerDocOnly.status, 200);

  await recordPreclaim(base, secret, "T-01", {
    actorType: "test_ai", actorId: "tester-B", sessionId: "sess-B"
  });
  const accepted = await fetch(base + "/api/projects/fixture/tasks/T-01/claim", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "independent.claim.ok.001",
      expectedRevision: task.registryRevision,
      actorType: "test_ai",
      actorId: "tester-B",
      assignee: "tester",
      sessionId: "sess-B",
      sessionWindowName: "独测窗口"
    }),
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).after.status, "独测中");
});


test("claim rejects tasks already occupied by another execution and still allows a free task", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };

  const running = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers })).json();
  const duplicate = await fetch(base + "/api/projects/fixture/tasks/B-10/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.occupied.running.001",
      expectedRevision: running.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-other",
      assignee: "other developer",
      sessionId: "sess-other",
      sessionWindowName: "另一个开发窗口"
    })
  });
  assert.equal(duplicate.status, 409);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.error.code, "TASK_ALREADY_OCCUPIED");
  assert.equal(duplicateBody.error.details.status, "开发中");
  assert.equal(duplicateBody.error.details.sessionId, "wc_sess_test");

  await fs.writeFile(fixture.registryPath, registryText([
    ["STALE-OWNER","F-S","product","P0","待开发","开发AI","other-ai","旧窗口","sess-old","2026-09-29T00:00:00Z","残留占用","计划.md","trace/S.md","read/S.md","write/S.js","cp/S.md"],
    ["FREE-1","F-F","product","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","可认领任务","计划.md","trace/F.md","read/F.md","write/F.js","cp/F.md"]
  ]), "utf8");

  const stale = await (await fetch(base + "/api/projects/fixture/tasks/STALE-OWNER", { headers })).json();
  const staleClaim = await fetch(base + "/api/projects/fixture/tasks/STALE-OWNER/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.occupied.owner.001",
      expectedRevision: stale.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-new",
      assignee: "new developer",
      sessionId: "sess-new",
      sessionWindowName: "新窗口"
    })
  });
  assert.equal(staleClaim.status, 409);
  assert.equal((await staleClaim.json()).error.code, "TASK_ALREADY_OCCUPIED");

  const free = await (await fetch(base + "/api/projects/fixture/tasks/FREE-1", { headers })).json();
  await recordPreclaim(base, secret, "FREE-1", {
    actorType: "developer_ai", actorId: "dev-free", sessionId: "sess-free"
  });
  const freeClaim = await fetch(base + "/api/projects/fixture/tasks/FREE-1/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.free.ok.001",
      expectedRevision: free.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-free",
      assignee: "free developer",
      sessionId: "sess-free",
      sessionWindowName: "空闲任务窗口"
    })
  });
  assert.equal(freeClaim.status, 200);
  assert.equal((await freeClaim.json()).after.status, "开发中");
});

test("direct HTTP claim requires a current preclaim report and rejects stale reports", async (t) => {
  const { base, secret } = await startFixture(t);
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };

  const initial = await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers })).json();
  const missing = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.preclaim.missing.001",
      expectedRevision: initial.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-preclaim-http",
      assignee: "developer",
      sessionId: "sess-preclaim-http",
      sessionWindowName: "开发窗口"
    })
  });
  assert.equal(missing.status, 409);
  assert.equal((await missing.json()).error.code, "PRECLAIM_REPORT_REQUIRED");

  await recordPreclaim(base, secret, "A-10", {
    actorType: "developer_ai", actorId: "dev-preclaim-http", sessionId: "sess-preclaim-http"
  });
  const guard = await (await fetch(
    base + "/api/projects/fixture/tasks/A-10/guard?actorType=developer_ai&actorId=dev-preclaim-http&sessionId=sess-preclaim-http",
    { headers }
  )).json();
  assert.equal(guard.preclaimReport.valid, true);

  const changed = await fetch(base + "/api/projects/fixture/tasks/A-10", {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      operationId: "claim.preclaim.change.001",
      expectedRevision: initial.registryRevision,
      eventType: "priority_change",
      actorType: "developer_ai",
      actorId: "dev-preclaim-http",
      patch: { priority: "P1" }
    })
  });
  assert.equal(changed.status, 200);
  const changedBody = await changed.json();

  const stale = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.preclaim.stale.001",
      expectedRevision: changedBody.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-preclaim-http",
      assignee: "developer",
      sessionId: "sess-preclaim-http",
      sessionWindowName: "开发窗口"
    })
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error.code, "PRECLAIM_REPORT_REQUIRED");
  assert.equal(staleBody.error.details.reason, "task_changed");

  await recordPreclaim(base, secret, "A-10", {
    actorType: "developer_ai", actorId: "dev-preclaim-http", sessionId: "sess-preclaim-http"
  });
  const accepted = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "claim.preclaim.accepted.001",
      expectedRevision: changedBody.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-preclaim-http",
      assignee: "developer",
      sessionId: "sess-preclaim-http",
      sessionWindowName: "开发窗口"
    })
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).after.status, "开发中");
});

test("active stop can be acknowledged to HOLD only after stop_request and then resumed", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const task = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();

  const noRequest = await fetch(base + "/api/projects/fixture/tasks/B-10/ack-stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "stop.ack.none.001", expectedRevision: task.registryRevision })
  });
  assert.equal(noRequest.status, 409);
  assert.equal((await noRequest.json()).error.code, "STOP_ACK_NOT_REQUESTED");

  const stop = await fetch(base + "/api/projects/fixture/tasks/B-10/stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "stop.request.ack.001", expectedRevision: task.registryRevision, note: "request" })
  });
  assert.equal(stop.status, 202);

  const acknowledged = await fetch(base + "/api/projects/fixture/tasks/B-10/ack-stop", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "stop.ack.001", expectedRevision: task.registryRevision, note: "resources released" })
  });
  assert.equal(acknowledged.status, 200);
  const ackBody = await acknowledged.json();
  assert.equal(ackBody.after.status, "HOLD");

  const guard = await (await fetch(base + "/api/projects/fixture/tasks/B-10/guard", { headers: { Cookie: cookie } })).json();
  assert.equal(guard.stopRequested, false);

  const held = await (await fetch(base + "/api/projects/fixture/tasks/B-10", { headers: { Cookie: cookie } })).json();
  const resumed = await fetch(base + "/api/projects/fixture/tasks/B-10/resume", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "stop.resume.after.ack.001", expectedRevision: held.registryRevision })
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).after.status, "待开发");
});

test("user messages are surfaced by guard and must be acknowledged before claim", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const task = await (await fetch(base + "/api/projects/fixture/tasks/A-10", { headers: { Cookie: cookie } })).json();

  const review = await fetch(base + "/api/projects/fixture/tasks/A-10/review", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "user.message.review.001",
      action: "comment",
      note: "请先确认权限收口范围，再继续开发"
    })
  });
  assert.equal(review.status, 200);

  const snapshot = await (await fetch(base + "/api/projects/fixture/tasks", {
    headers: { Cookie: cookie }
  })).json();
  const card = snapshot.tasks.find((item) => item.id === "A-10");
  assert.equal(card.presentation.latestUserMessage.note, "请先确认权限收口范围，再继续开发");
  assert.match(card.presentation.responsibility, /权限收口/);
  assert.ok(card.presentation.currentProgress);
  assert.ok(card.presentation.userAssistance);

  const bearer = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const query = "?actorType=developer_ai&actorId=dev-1&sessionId=sess-1";
  const guard1 = await (await fetch(base + "/api/projects/fixture/tasks/A-10/guard" + query, {
    headers: { Authorization: `Bearer ${secret}` }
  })).json();
  assert.equal(guard1.userMessages.requiresAcknowledgement, true);
  assert.equal(guard1.userMessages.unreadCount, 1);
  assert.equal(guard1.userMessages.unreadMessages[0].note, "请先确认权限收口范围，再继续开发");

  const blocked = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "user.message.claim.blocked.001",
      expectedRevision: task.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-1",
      assignee: "developer",
      sessionId: "sess-1",
      sessionWindowName: "开发窗口"
    })
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.code, "USER_MESSAGE_ACK_REQUIRED");

  const ack = await fetch(base + "/api/projects/fixture/tasks/A-10/ack-user-messages", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "user.message.ack.001",
      actorType: "developer_ai",
      actorId: "dev-1",
      sessionId: "sess-1",
      note: "已阅读用户留言"
    })
  });
  assert.equal(ack.status, 200);
  const ackBody = await ack.json();
  assert.equal(ackBody.acknowledged.length, 1);
  assert.equal(ackBody.userMessages.requiresAcknowledgement, false);

  const guard2 = await (await fetch(base + "/api/projects/fixture/tasks/A-10/guard" + query, {
    headers: { Authorization: `Bearer ${secret}` }
  })).json();
  assert.equal(guard2.userMessages.requiresAcknowledgement, false);

  await recordPreclaim(base, secret, "A-10", {
    actorType: "developer_ai", actorId: "dev-1", sessionId: "sess-1"
  });
  const claimed = await fetch(base + "/api/projects/fixture/tasks/A-10/claim", {
    method: "POST",
    headers: bearer,
    body: JSON.stringify({
      operationId: "user.message.claim.ok.001",
      expectedRevision: task.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-1",
      assignee: "developer",
      sessionId: "sess-1",
      sessionWindowName: "开发窗口"
    })
  });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).after.status, "开发中");
});


test("developer can claim a preparation task and enter development", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["PREP-1","F-P","product","P0","待准备","开发AI","—","—","—","2026-09-29T00:00:00Z","补齐证据","计划.md","trace/P.md","read/P.md","src/prep.js","cp/PREP-1.md"]
  ]), "utf8");
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const task = await (await fetch(base + "/api/projects/fixture/tasks/PREP-1", { headers })).json();
  await recordPreclaim(base, secret, "PREP-1", {
    actorType: "developer_ai", actorId: "dev-prep", sessionId: "sess-prep"
  });
  const claimed = await fetch(base + "/api/projects/fixture/tasks/PREP-1/claim", {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationId: "prep.claim.developer.001",
      expectedRevision: task.registryRevision,
      actorType: "developer_ai",
      actorId: "dev-prep",
      assignee: "developer",
      sessionId: "sess-prep",
      sessionWindowName: "准备修复窗口"
    })
  });
  assert.equal(claimed.status, 200);
  const body = await claimed.json();
  assert.equal(body.before.status, "待准备");
  assert.equal(body.after.status, "开发中");
});

test("registered task plan opens by plan index and unknown index is rejected", async (t) => {
  const { base, secret } = await startFixture(t);
  const headers = { Authorization: `Bearer ${secret}` };

  const plan = await fetch(base + "/api/projects/fixture/tasks/B-10/plans/0", { headers });
  assert.equal(plan.status, 200);
  const body = await plan.json();
  assert.equal(body.name, "任务看板与AI协作控制开发计划.md");
  assert.equal(body.path, "任务看板与AI协作控制开发计划.md");
  assert.match(body.content, /B-10夹具计划内容/);

  const missing = await fetch(base + "/api/projects/fixture/tasks/B-10/plans/1", { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "TASK_PLAN_NOT_FOUND");
});


test("task documents expose checkpoint and report only through registered task targets", async (t) => {
  const { base, secret } = await startFixture(t);
  const headers = { Authorization: `Bearer ${secret}` };

  const checkpoint = await fetch(base + "/api/projects/fixture/tasks/B-10/documents/0", { headers });
  assert.equal(checkpoint.status, 200);
  const checkpointBody = await checkpoint.json();
  assert.equal(checkpointBody.kind, "checkpoint");
  assert.match(checkpointBody.content, /夹具断点内容/);

  const report = await fetch(base + "/api/projects/fixture/tasks/B-10/documents/1", { headers });
  assert.equal(report.status, 200);
  const reportBody = await report.json();
  assert.equal(reportBody.kind, "report");
  assert.match(reportBody.content, /夹具测试报告内容/);

  const missing = await fetch(base + "/api/projects/fixture/tasks/B-10/documents/2", { headers });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "TASK_DOCUMENT_NOT_FOUND");
});

test("AI reply is explicitly linked to the user question", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const review = await fetch(base + "/api/projects/fixture/tasks/A-10/review", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "reply.review.001",
      action: "comment",
      note: "这条问题需要AI直接回复"
    })
  });
  assert.equal(review.status, 200);
  const reviewBody = await review.json();
  const messageEventId = reviewBody.event.event_id;

  const replied = await fetch(base + "/api/projects/fixture/tasks/A-10/reply-user-message", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "reply.answer.001",
      messageEventId,
      actorType: "developer_ai",
      actorId: "dev-1",
      sessionId: "sess-1",
      note: "这是对应问题的AI回复"
    })
  });
  assert.equal(replied.status, 200);
  const replyBody = await replied.json();
  assert.equal(replyBody.event.metadata.replyToEventId, messageEventId);

  const detail = await (await fetch(base + "/api/projects/fixture/tasks/A-10", {
    headers: { Cookie: cookie }
  })).json();
  assert.equal(detail.userMessages.messages.length, 1);
  assert.equal(detail.userMessages.messages[0].eventId, messageEventId);
  assert.equal(detail.userMessages.messages[0].replies.length, 1);
  assert.equal(detail.userMessages.messages[0].replies[0].note, "这是对应问题的AI回复");
  assert.equal(detail.userMessages.messages[0].replies[0].inferred, false);
});

test("user accept is a decision with state change and is not rendered as a normal message", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const rows = [
    ["U-01","F-U","product","P0","待用户验收","开发AI","—","—","—","—","用户验收夹具","账号登录与权限开发计划.md","cp/B-10.md"],
    ["B-10","F-022","infrastructure","P0","开发中","开发AI","worker","B-10窗口","wc_sess_test","2026-09-28T11:30:00Z","看板","任务看板与AI协作控制开发计划.md","cp/B-10.md；reports/B-10/report.md"],
    ["T-01","F-TEST","product","P1","待独测","独立测试AI","—","—","—","—","独立测试夹具","测试计划.md","cp/B-10.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const { cookie, csrf } = await login(base, secret);
  const before = await (await fetch(base + "/api/projects/fixture/tasks/U-01", { headers: { Cookie: cookie } })).json();

  const accepted = await fetch(base + "/api/projects/fixture/tasks/U-01/review", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "decision.accept.001",
      expectedRevision: before.registryRevision,
      action: "accept",
      note: "用户确认通过"
    })
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.before.status, "待用户验收");
  assert.equal(acceptedBody.after.status, "已完成");

  const detail = await (await fetch(base + "/api/projects/fixture/tasks/U-01", { headers: { Cookie: cookie } })).json();
  assert.equal(detail.userMessages.messages.length, 0);
  assert.equal(detail.presentation.latestUserDecision.type, "user_accept");
  assert.equal(detail.presentation.latestUserDecision.oldStatus, "待用户验收");
  assert.equal(detail.presentation.latestUserDecision.newStatus, "已完成");
});

test("release rejects active execution and handoff atomically clears ownership", async (t) => {
  const { base, secret } = await startFixture(t);
  const headers = { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
  const initial = await (await fetch(base + "/api/projects/fixture/tasks/B-10", {
    headers: { Authorization: `Bearer ${secret}` }
  })).json();

  const activeRelease = await fetch(base + "/api/projects/fixture/tasks/B-10/release", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "release.active.001",
      expectedRevision: initial.registryRevision,
      actorType: "developer_ai",
      actorId: "dev",
      sessionId: "wc_sess_test"
    })
  });
  assert.equal(activeRelease.status, 409);
  assert.equal((await activeRelease.json()).error.code, "RELEASE_EXECUTION_STAGE_INVALID");

  const genericHandoff = await fetch(base + "/api/projects/fixture/tasks/B-10", {
    method: "PATCH", headers,
    body: JSON.stringify({
      operationId: "release.handoff.generic.001",
      expectedRevision: initial.registryRevision,
      eventType: "handoff",
      actorType: "developer_ai",
      actorId: "dev",
      sessionId: "wc_sess_test",
      patch: { status: "待独测" }
    })
  });
  assert.equal(genericHandoff.status, 409);

  const handedOff = await fetch(base + "/api/projects/fixture/tasks/B-10/complete-execution", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "release.handoff.001",
      expectedRevision: initial.registryRevision,
      actorType: "developer_ai",
      actorId: "dev",
      sessionId: "wc_sess_test"
    })
  });
  assert.equal(handedOff.status, 200);
  const handoffBody = await handedOff.json();
  assert.equal(handoffBody.after.status, "待独测");
  assert.equal(handoffBody.after.plannedRole, "独立测试AI");
  assert.equal(handoffBody.after.assignee, "");
  assert.equal(handoffBody.after.sessionWindowName, "");
  assert.equal(handoffBody.after.sessionId, "");

  const released = await fetch(base + "/api/projects/fixture/tasks/B-10/release", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "release.idempotent.001",
      expectedRevision: handoffBody.registryRevision,
      actorType: "developer_ai",
      actorId: "dev",
      sessionId: "other-session",
      note: "交接已原子释放；重复release保持幂等"
    })
  });
  assert.equal(released.status, 200);
  const releaseBody = await released.json();
  assert.equal(releaseBody.after.status, "待独测");
  assert.equal(releaseBody.after.plannedRole, "独立测试AI");
  assert.equal(releaseBody.after.assignee, "");
  assert.equal(releaseBody.after.sessionWindowName, "");
  assert.equal(releaseBody.after.sessionId, "");
  assert.ok(releaseBody.eventId);
});


test("requirement intake is browser-created, visible in guard, blocks claim, and can be completed by AI", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);

  const denied = await fetch(base + "/api/projects/fixture/requirements", {
    method:"POST",
    headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"req.http.denied.001",text:"不能由bearer冒充用户创建"})
  });
  assert.equal(denied.status,403);

  const created = await fetch(base + "/api/projects/fixture/requirements", {
    method:"POST",
    headers:{Cookie:cookie,Origin:base,"X-CSRF-Token":csrf,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"req.http.create.001",text:"新增库存预警入口"})
  });
  assert.equal(created.status,201);
  const requirement=(await created.json()).requirement;
  assert.equal(requirement.status,"待AI拆解");

  const guard=await (await fetch(base+"/api/projects/fixture/tasks/A-10/guard?actorType=developer_ai&actorId=dev&sessionId=sess",{
    headers:{Authorization:`Bearer ${secret}`}
  })).json();
  assert.equal(guard.requirements.pendingCount,1);
  assert.equal(guard.requirements.items[0].id,requirement.id);

  const task=await (await fetch(base+"/api/projects/fixture/tasks/A-10",{headers:{Authorization:`Bearer ${secret}`}})).json();
  const blocked=await fetch(base+"/api/projects/fixture/tasks/A-10/claim",{
    method:"POST",
    headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      operationId:"req.http.claim.001",expectedRevision:task.registryRevision,
      actorType:"developer_ai",actorId:"dev",assignee:"developer",sessionId:"sess",sessionWindowName:"开发窗口"
    })
  });
  assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).error.code,"REQUIREMENT_INTAKE_PENDING");

  const aiReply=await fetch(base+"/api/projects/fixture/requirements/"+encodeURIComponent(requirement.id)+"/reply",{
    method:"POST",
    headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"req.http.reply.001",actorType:"developer_ai",actorId:"dev",sessionId:"sess",note:"需要确认阈值"})
  });
  assert.equal(aiReply.status,200);

  const waitUser=await fetch(base+"/api/projects/fixture/requirements/"+encodeURIComponent(requirement.id)+"/status",{
    method:"POST",
    headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"req.http.wait.001",actorType:"developer_ai",actorId:"dev",status:"待用户补充",note:"等待用户确认阈值"})
  });
  assert.equal(waitUser.status,200);

  const userReply=await fetch(base+"/api/projects/fixture/requirements/"+encodeURIComponent(requirement.id)+"/reply",{
    method:"POST",
    headers:{Cookie:cookie,Origin:base,"X-CSRF-Token":csrf,"Content-Type":"application/json"},
    body:JSON.stringify({operationId:"req.http.user.reply.001",note:"阈值设为20"})
  });
  assert.equal(userReply.status,200);
  assert.equal((await userReply.json()).message.actorType,"user");

  const done=await fetch(base+"/api/projects/fixture/requirements/"+encodeURIComponent(requirement.id)+"/status",{
    method:"POST",
    headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/json"},
    body:JSON.stringify({
      operationId:"req.http.done.001",actorType:"developer_ai",actorId:"dev",status:"已拆解",
      planPaths:["账号登录与权限开发计划.md"],taskIds:["A-10"],keyFiles:["server/auth.mjs"],note:"已归入现有计划"
    })
  });
  assert.equal(done.status,200);
  assert.equal((await done.json()).requirement.status,"已拆解");
  const pending=await (await fetch(base+"/api/projects/fixture/requirements?pending=1",{headers:{Authorization:`Bearer ${secret}`}})).json();
  assert.equal(pending.pendingCount,0);
});


test("user can reject directly from awaiting-test stages without test AI claiming first", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const cases = [
    ["W-D1","待独测","defect","测试失败待修复","开发AI"],
    ["W-E1","待独测","evidence","待准备","开发AI"],
    ["W-Q1","待独测","decision","待确认","用户"],
    ["W-H1","待独测","hold","HOLD",""],
    ["R-D1","待复测","defect","测试失败待修复","开发AI"],
    ["R-E1","待复测","evidence","待准备","开发AI"],
    ["R-Q1","待复测","decision","待确认","用户"],
    ["R-H1","待复测","hold","HOLD",""]
  ];
  const rows = cases.map(([id,status]) => [
    id,"F-WAIT","infrastructure","P0",status,"独立测试AI","—","—","—","—",
    "等待测试阶段用户直接打回夹具","任务看板与AI协作控制开发计划.md","cp/B-10.md"
  ]);
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const { cookie, csrf } = await login(base, secret);

  for (const [id, fromStatus, reason, expectedStatus, expectedRole] of cases) {
    const before = await (await fetch(base + "/api/projects/fixture/tasks/" + id, {
      headers: { Cookie: cookie }
    })).json();

    const rejected = await fetch(base + "/api/projects/fixture/tasks/" + id + "/review", {
      method: "POST",
      headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "waiting-test.reject." + id + "." + reason,
        expectedRevision: before.registryRevision,
        action: "reject",
        reason,
        note: "用户在等待测试阶段直接打回"
      })
    });
    assert.equal(rejected.status, 200, id + " " + reason);
    const body = await rejected.json();
    assert.equal(body.before.status, fromStatus);
    assert.equal(body.after.status, expectedStatus);
    assert.equal(body.after.plannedRole, expectedRole);
    assert.ok(body.eventId);
  }
});


test("task-scan status endpoint reports scheduler and candidate summary", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const scanDir = path.join(fixture.boardRoot, "data", "runtime", "task-scan");
  await fs.writeFile(path.join(fixture.boardRoot, "config", "ai-execution.json"), JSON.stringify({ scan_interval_minutes: 7, max_requests_per_chat: 25 }, null, 2), "utf8");
  await fs.mkdir(scanDir, { recursive: true });
  await fs.writeFile(path.join(scanDir, "scheduler.json"), JSON.stringify({
    version: 1, installed: true, state: "installed", task_name: "WyerpTaskboard-TaskScan", interval_minutes: 10
  }, null, 2), "utf8");
  await fs.writeFile(path.join(scanDir, "status.json"), JSON.stringify({
    version: 1, state: "completed", last_scan_at: "2026-09-29T00:00:00.000Z",
    scan_interval_minutes: 10,
    next_due_at: "2026-09-29T00:10:00.000Z",
    instant_trigger: "disabled_unverified", chatgpt_consumer: "hourly_or_manual_fallback"
  }, null, 2), "utf8");
  await fs.writeFile(path.join(scanDir, "events.jsonl"), JSON.stringify({ timestamp: "2026-09-29T00:05:00.000Z", type: "candidate_consumed", detection_id: "det_old", claim_event_id: "evt_claim_1" }) + "\n", "utf8");

  await fs.writeFile(path.join(scanDir, "candidates.json"), JSON.stringify({
    version: 1,
    updated_at: "2026-09-29T00:00:00.000Z",
    candidates: {
      det_fixture: {
        detection_id: "det_fixture",
        first_detected_at: "2026-09-29T00:00:00.000Z",
        last_confirmed_at: "2026-09-29T00:00:00.000Z",
        expires_at: "2099-09-29T00:30:00.000Z",
        consumed_at: null, stale_at: null,
        project_id: "fixture", task_id: "A-10", track: "product", priority: "P0",
        status: "待开发", planned_role: "开发AI", eligible_role: "developer_ai",
        eligible: true, blockers: [], reason: "开发任务已就绪", dedupe_key: "fixture", source_fingerprint: "fixture"
      }
    }
  }, null, 2), "utf8");

  const { cookie } = await login(base, secret);
  const response = await fetch(base + "/api/task-scan/status", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.scheduler.installed, true);
  assert.equal(body.scheduler.interval_minutes, 10);
  assert.equal(body.scan.state, "completed");
  assert.equal(body.executionSettings.scan_interval_minutes, 7);
  assert.equal(body.executionSettings.max_requests_per_chat, 25);
  assert.equal(body.schedulerSync.in_sync, false);
  assert.equal(body.schedulerSync.configured_interval_minutes, 7);
  assert.equal(body.schedulerSync.scheduler_interval_minutes, 10);
  assert.equal(body.nextExpectedAt, "2026-09-29T00:07:00.000Z");
  assert.equal(body.lastConsumption.claim_event_id, "evt_claim_1");
  assert.equal(body.candidateCount, 1);
  assert.equal(body.eligibleCount, 1);
  assert.equal(body.highestCandidate.taskId, "A-10");
  assert.equal(body.highestCandidate.eligibleRole, "developer_ai");
  assert.equal(body.developerCandidates.length, 1);
  assert.equal(body.developerCandidates[0].taskId, "A-10");
  assert.equal(body.developerCandidates[0].eligible, true);
});


test("browser admin can auto-adapt an incompatible project without overwriting legacy text", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const legacyRoot = path.join(fixture.boardRoot, "http-legacy-project");
  await fs.mkdir(legacyRoot, { recursive: true });
  const original = "# legacy\n\nkeep me\n";
  await fs.writeFile(path.join(legacyRoot, "待办任务总清单.md"), original, "utf8");

  const added = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ root: legacyRoot, id: "http-legacy", name: "HTTP Legacy" })
  });
  assert.equal(added.status, 201);
  const addedBody = await added.json();
  assert.equal(addedBody.validation.adaptationRequired, true);

  const adapted = await fetch(base + "/api/projects/http-legacy/adapt", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "project_adapt.http_test" })
  });
  assert.equal(adapted.status, 200);
  const body = await adapted.json();
  assert.equal(body.createdGovernanceTaskId, "BOARD-PLAN-AUDIT-001");
  assert.equal(body.health.status, "healthy");
  const text = await fs.readFile(path.join(legacyRoot, "待办任务总清单.md"), "utf8");
  assert.ok(text.startsWith(original));
  assert.match(text, /BOARD-PLAN-AUDIT-001/);
});


test("chat wake SSE accepts only local token/origin and exposes minimal candidate refs", async (t) => {
  const { base, app } = await startFixture(t);
  const token = "t".repeat(64);
  const detectionId = "det_http_wake_001";
  const now = Date.now();
  await app.scanStore.writeState({
    version: 1,
    updated_at: new Date(now).toISOString(),
    candidates: {
      [detectionId]: {
        detection_id: detectionId,
        project_id: "fixture",
        task_id: "T-01",
        track: "product",
        priority: "P0",
        status: "待独测",
        planned_role: "独立测试AI",
        eligible_role: "test_ai",
        eligible: true,
        current_assignee: "",
        current_session_id: "",
        first_detected_at: new Date(now).toISOString(),
        last_confirmed_at: new Date(now).toISOString(),
        expires_at: new Date(now + 60000).toISOString(),
        consumed_at: null,
        stale_at: null,
        hidden_secret: "must-not-leak"
      }
    }
  });

  const badToken = await fetch(base + "/api/chat-wake/stream?token=bad&client_id=x", {
    headers: { Origin: "https://chatgpt.com" }
  });
  assert.equal(badToken.status, 401);

  const badOrigin = await fetch(base + "/api/chat-wake/stream?token=" + token + "&client_id=x", {
    headers: { Origin: "https://evil.invalid" }
  });
  assert.equal(badOrigin.status, 403);

  const extensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const logPreflight = await fetch(base + "/api/chat-wake/log-event", {
    method: "OPTIONS",
    headers: {
      Origin: extensionOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type"
    }
  });
  assert.equal(logPreflight.status, 204);
  assert.equal(logPreflight.headers.get("access-control-allow-origin"), extensionOrigin);

  app.chatBrowserWake.config.enabled = false;
  const disabledLog = await fetch(base + "/api/chat-wake/log-event?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "background",
      level: "error",
      event: "disabled_runtime_diagnostic",
      extension_version: "0.0-test",
      error_message: "diagnostic while wake disabled"
    })
  });
  assert.equal(disabledLog.status, 202);

  const disabledVersion = await fetch(
    base + "/api/chat-wake/version?token=" + encodeURIComponent(token) + "&extension_version=0.0-test",
    { headers: { Origin: extensionOrigin } }
  );
  assert.equal(disabledVersion.status, 200);
  const disabledVersionBody = await disabledVersion.json();
  assert.equal(disabledVersionBody.compatible, false);
  assert.equal(disabledVersionBody.state, "chat_wake_disabled");
  assert.equal(disabledVersionBody.wake_enabled, false);

  const disabledControl = await fetch(base + "/api/chat-wake/mcp-action?token=" + encodeURIComponent(token), {
    method: "POST",
    headers: { Origin: extensionOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "new_chat" })
  });
  assert.equal(disabledControl.status, 401);
  app.chatBrowserWake.config.enabled = true;

  const health = await fetch(base + "/healthz");
  const taskboardVersion = (await health.json()).version;
  const latestExtensionVersion = String(taskboardVersion) + "-extension-current";
  app.chatBrowserWake.config.expected_extension_version = latestExtensionVersion;
  const staleExtensionVersion = latestExtensionVersion + "-stale";
  assert.ok(taskboardVersion);
  assert.ok(latestExtensionVersion);
  assert.notEqual(latestExtensionVersion, taskboardVersion);

  const currentVersionInfo = await fetch(base + "/api/chat-wake/version?token=" + token + "&extension_version=" + encodeURIComponent(latestExtensionVersion), {
    headers: { Origin: "https://chatgpt.com" }
  });
  assert.equal(currentVersionInfo.status, 200);
  const currentVersionBody = await currentVersionInfo.json();
  assert.equal(currentVersionBody.compatible, true);
  assert.equal(currentVersionBody.version_policy, "independent");
  assert.equal(currentVersionBody.extension_current, true);
  assert.equal(currentVersionBody.extension_version, latestExtensionVersion);
  assert.equal(currentVersionBody.extension_latest_version, latestExtensionVersion);
  assert.equal(currentVersionBody.taskboard_version, taskboardVersion);

  const staleVersionInfo = await fetch(base + "/api/chat-wake/version?token=" + token + "&extension_version=" + encodeURIComponent(staleExtensionVersion), {
    headers: { Origin: "https://chatgpt.com" }
  });
  assert.equal(staleVersionInfo.status, 409);
  assert.equal((await staleVersionInfo.json()).extension_current, false);

  const staleStream = await fetch(base + "/api/chat-wake/stream?token=" + token + "&client_id=old-browser&extension_version=" + encodeURIComponent(staleExtensionVersion) + "&dispatcher_epoch=99", {
    headers: { Origin: "https://chatgpt.com" }
  });
  assert.equal(staleStream.status, 200);

  const controller = new AbortController();
  const stream = await fetch(base + "/api/chat-wake/stream?token=" + token + "&client_id=browser-a&extension_version=" + encodeURIComponent(latestExtensionVersion) + "&dispatcher_epoch=100", {
    headers: { Origin: "https://chatgpt.com" },
    signal: controller.signal
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read();
  const text = new TextDecoder().decode(first.value);
  controller.abort();
  const match = text.match(/data: (\{.*\})/);
  assert.ok(match);
  const candidate = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(candidate).sort(), ["detection_id","eligible_role","project_id","task_id"]);
  assert.equal(candidate.detection_id, detectionId);
  assert.equal(JSON.stringify(candidate).includes("must-not-leak"), false);

  const ack = await fetch(base + "/api/chat-wake/ack?token=" + token, {
    method: "POST",
    headers: { Origin: "https://chatgpt.com", "Content-Type": "application/json" },
    body: JSON.stringify({ detection_id: detectionId, client_id: "browser-a", dispatcher_epoch: 100 })
  });
  assert.equal(ack.status, 200);
  assert.equal((await ack.json()).state, "acked");
  assert.equal((await app.chatBrowserWake.claim(await app.scanStore.list(), "browser-a", null, 100)).state, "no_candidate");
});

test("AI execution settings endpoint exposes shared defaults to authenticated board", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie } = await login(base, secret);
  const response = await fetch(base + "/api/ai-execution/settings", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.developer.model, "GPT-5.6 Sol");
  assert.equal(body.settings.max_requests_per_chat, 20);
  assert.equal(body.settings.context_warning_at, 15);
});

test("AI execution settings endpoint rejects invalid values before scheduler apply", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const response = await fetch(base + "/api/ai-execution/settings", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: base,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ settings: { max_requests_per_chat: 5, context_warning_at: 6 } })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, "INVALID_AI_EXECUTION_SETTINGS");
});

test("Chat Wake settings endpoint exposes the same execution configuration", async (t) => {
  const { base, fixture } = await startFixture(t);
  const cfg = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "chat-browser-wake.json"), "utf8"));
  const response = await fetch(base + "/api/chat-wake/settings?token=" + encodeURIComponent(cfg.token), {
    headers: { Origin: "https://chatgpt.com" }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.test.model, "GPT-5.6 Sol");
  assert.equal(body.settings.timeout_retry_limit, 3);
  assert.equal(body.settings.max_requests_per_chat, 20);
});

test("Chat Wake MCP action endpoint delegates GPT mutations to the unified MCP executor", async (t) => {
  const executions = [];
  const { base, fixture } = await startFixture(t, {
    chatgptMcpExecutorFactory: async () => ({
      execute: async (body) => {
        executions.push(body);
        return { ok: true, executed: true, action: body.action };
      }
    })
  });
  const cfg = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "chat-browser-wake.json"), "utf8"));
  const response = await fetch(base + "/api/chat-wake/mcp-action?token=" + encodeURIComponent(cfg.token), {
    method: "POST",
    headers: { Origin: "https://chatgpt.com", "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "send_candidate",
      candidate: {
        project_id: "fixture",
        task_id: "T-01",
        detection_id: "det-http-mcp",
        eligible_role: "test_ai"
      }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.executed, true);
  assert.equal(body.action, "send_candidate");
  assert.equal(executions.length, 1);
  assert.equal(executions[0].candidate.detection_id, "det-http-mcp");
});


test("AI execution settings are shared by admin UI and chat wake bridge", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);

  const adminResponse = await fetch(base + "/api/ai-execution/settings", {
    headers: { Cookie: cookie }
  });
  assert.equal(adminResponse.status, 200);
  const admin = await adminResponse.json();
  assert.equal(admin.settings.developer.model, "GPT-5.6 Sol");
  assert.equal(admin.settings.max_requests_per_chat, 20);

  const wakeCfg = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "chat-browser-wake.json"), "utf8"));
  const wakeResponse = await fetch(
    base + "/api/chat-wake/settings?token=" + encodeURIComponent(wakeCfg.token),
    { headers: { Origin: "https://chatgpt.com" } }
  );
  assert.equal(wakeResponse.status, 200);
  const wake = await wakeResponse.json();
  assert.deepEqual(wake.settings.developer, admin.settings.developer);
  assert.equal(wake.settings.context_warning_at, admin.settings.context_warning_at);

  const invalid = await fetch(base + "/api/ai-execution/settings", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: base,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ settings: { max_requests_per_chat: 5, context_warning_at: 6 } })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "INVALID_AI_EXECUTION_SETTINGS");
});

test("AI execution settings can update model policy without rebuilding scheduler", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);
  const response = await fetch(base + "/api/ai-execution/settings", {
    method: "PUT",
    headers: {
      Cookie: cookie,
      Origin: base,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      settings: {
        developer: { model: "GPT-5.6 Sol", reasoning_effort: "medium" }
      }
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.settings.developer.reasoning_effort, "medium");
  assert.equal(body.scheduler.applied, false);
  assert.equal(body.scheduler.reason, "interval_unchanged");

  const verify = await fetch(base + "/api/ai-execution/settings", { headers: { Cookie: cookie } });
  const saved = await verify.json();
  assert.equal(saved.settings.developer.reasoning_effort, "medium");
});

test("project service status endpoint exposes safe state without instance secrets", async (t) => {
  const { base, secret } = await startFixture(t);
  const { cookie } = await login(base, secret);
  const response = await fetch(base + "/api/projects/wyerp-taskboard/service/status", {
    headers: { Cookie: cookie }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.supported, true);
  assert.equal(body.projectId, "wyerp-taskboard");
  assert.equal("instanceToken" in body, false);
  assert.ok(typeof body.state === "string");

  const unsupported = await fetch(base + "/api/projects/other-project/service/status", {
    headers: { Cookie: cookie }
  });
  assert.equal(unsupported.status, 200);
  const unsupportedBody = await unsupported.json();
  assert.equal(unsupportedBody.supported, false);
  assert.equal(unsupportedBody.state, "unsupported");
});

test("待交付 can only be claimed by the original developer AI from the original Session", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-ORIGINAL", "F-DELIVERY", "product", "P0", "待交付", "开发AI", "—", "—", "—", "2026-10-31T00:00:00Z", "原开发者交付认领", "测试计划.md", "cp/D-ORIGINAL.md"]
  ]), "utf8");
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const seed = async (operationId, eventType, actorType, actorId, sessionId, metadata = {}) => {
    const response = await fetch(base + "/api/projects/fixture/tasks/D-ORIGINAL/events", {
      method: "POST", headers,
      body: JSON.stringify({ operationId, eventType, actorType, actorId, sessionId, metadata })
    });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  };
  await seed("delivery.origin.handoff.001", "handoff", "developer_ai", "original-developer", "original-session", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  });
  await seed("delivery.origin.tester.claim.001", "claim", "test_ai", "independent-tester", "test-session", { claimedFromStatus: "待独测" });
  await seed("delivery.origin.tester.pass.001", "test_result", "test_ai", "independent-tester", "test-session", {
    atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required", deliveryActions: ["candidate_merge"],
    commitSha: "a".repeat(40), headBranch: "feature/candidate", reportPath: "reports/D-ORIGINAL/pass.md"
  });

  await recordPreclaim(base, secret, "D-ORIGINAL", {
    actorType: "developer_ai", actorId: "replacement-developer", sessionId: "replacement-session"
  });
  let current = await (await fetch(base + "/api/projects/fixture/tasks/D-ORIGINAL", { headers })).json();
  const replacement = await fetch(base + "/api/projects/fixture/tasks/D-ORIGINAL/claim", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "delivery.claim.replacement.001", expectedRevision: current.registryRevision,
      actorType: "developer_ai", actorId: "replacement-developer", assignee: "replacement-developer",
      sessionId: "replacement-session", sessionWindowName: "替代开发窗口"
    })
  });
  assert.equal(replacement.status, 409);
  assert.equal((await replacement.json()).error.code, "DELIVERY_ORIGINAL_DEVELOPER_REQUIRED");

  await recordPreclaim(base, secret, "D-ORIGINAL", {
    actorType: "developer_ai", actorId: "original-developer", sessionId: "original-session"
  });
  current = await (await fetch(base + "/api/projects/fixture/tasks/D-ORIGINAL", { headers })).json();
  const original = await fetch(base + "/api/projects/fixture/tasks/D-ORIGINAL/claim", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "delivery.claim.original.001", expectedRevision: current.registryRevision,
      actorType: "developer_ai", actorId: "original-developer", assignee: "original-developer",
      sessionId: "original-session", sessionWindowName: "原开发窗口"
    })
  });
  const originalBody = await original.json();
  assert.equal(original.status, 200, JSON.stringify(originalBody));
  const claimed = originalBody;
  assert.equal(claimed.after.status, "交付中");
  assert.equal(claimed.after.assignee, "original-developer");
  assert.equal(claimed.after.sessionId, "original-session");
});

test("delivery failure endpoint records the blocker and keeps original developer ownership", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-FAILURE", "F-DELIVERY", "product", "P0", "交付中", "开发AI", "developer", "交付窗口", "dev-session", "2026-10-31T00:00:00Z", "交付失败恢复", "测试计划.md", "cp/D-FAILURE.md"]
  ]), "utf8");
  const headers = { Authorization: "Bearer " + secret, "Content-Type": "application/json" };
  const seed = async (operationId, eventType, actorType, actorId, sessionId, metadata = {}) => {
    const saved = await fetch(base + "/api/projects/fixture/tasks/D-FAILURE/events", {
      method: "POST", headers,
      body: JSON.stringify({ operationId, eventType, actorType, actorId, sessionId, metadata })
    });
    assert.equal(saved.status, 200, JSON.stringify(await saved.json()));
  };
  await seed("delivery.failure.origin.handoff.001", "handoff", "developer_ai", "developer", "dev-session", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
  });
  await seed("delivery.failure.tester.claim.001", "claim", "test_ai", "independent-tester", "test-session", { claimedFromStatus: "待独测" });
  await seed("delivery.failure.tester.pass.001", "test_result", "test_ai", "independent-tester", "test-session", {
    atomicLifecycle: true, testResult: "pass", deliveryDisposition: "required", deliveryActions: ["candidate_merge"],
    commitSha: "b".repeat(40), headBranch: "feature/candidate", reportPath: "reports/D-FAILURE/pass.md"
  });
  await seed("delivery.failure.developer.claim.001", "claim", "developer_ai", "developer", "dev-session", { claimedFromStatus: "待交付" });
  const before = await (await fetch(base + "/api/projects/fixture/tasks/D-FAILURE", { headers })).json();
  const response = await fetch(base + "/api/projects/fixture/tasks/D-FAILURE/delivery-attempt-failed", {
    method: "POST", headers,
    body: JSON.stringify({
      operationId: "delivery.failure.record.001", expectedRevision: before.registryRevision,
      actorType: "developer_ai", actorId: "developer", sessionId: "dev-session",
      failureStage: "push", failureCode: "REMOTE_REJECTED", note: "远端推送被拒绝",
      nextAction: "先 fetch origin/main，再同步并重试推送"
    })
  });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  const current = await (await fetch(base + "/api/projects/fixture/tasks/D-FAILURE", { headers })).json();
  assert.equal(current.status, "交付中");
  assert.equal(current.assignee, "developer");
  assert.equal(current.sessionId, "dev-session");
  assert.match(current.presentation.currentProgress, /REMOTE_REJECTED/);
  assert.match(current.presentation.currentProgress, /远端推送被拒绝/);
  assert.match(current.presentation.currentProgress, /fetch origin\/main/);
});

test("independent test pass requires an explicit delivery disposition and validates real actions", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-REQ","F-DELIVERY","product","P0","独测中","独立测试AI","tester","独测窗口","sess-delivery-required","2026-10-01T00:00:00Z","交付判定夹具","测试计划.md","cp/D-REQ.md"]
  ]), "utf8");
  const current = async () => (await (await fetch(base + "/api/projects/fixture/tasks/D-REQ", { headers: { Authorization: "Bearer " + secret } })).json());
  const postResult = async (extra = {}) => {
    const before = await current();
    return fetch(base + "/api/projects/fixture/tasks/D-REQ/test-result", {
      method: "POST",
      headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "delivery.required." + crypto.randomUUID(), expectedRevision: before.registryRevision,
        actorType: "test_ai", actorId: "tester", sessionId: "sess-delivery-required",
        testResult: "pass", reportPath: "reports/D-REQ/pass.md", ...extra
      })
    });
  };
  const missing = await postResult();
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "DELIVERY_DISPOSITION_REQUIRED");
  const empty = await postResult({ deliveryDisposition: "required", deliveryActions: [] });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, "DELIVERY_ACTION_REQUIRED");
  const fake = await postResult({ deliveryDisposition: "required", deliveryActions: ["repeat_test"] });
  assert.equal(fake.status, 400);
  assert.equal((await fake.json()).error.code, "INVALID_DELIVERY_ACTION");
  const accepted = await postResult({ deliveryDisposition: "required", deliveryActions: ["deploy_switch"] });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.after.status, "待交付");
  assert.equal(body.after.plannedRole, "开发AI");
});

test("independent test pass with no real delivery goes directly to user acceptance", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-USER","F-DELIVERY","product","P0","独测中","独立测试AI","tester","独测窗口","sess-delivery-user","2026-10-01T00:00:00Z","无交付动作夹具","测试计划.md","cp/D-USER.md"]
  ]), "utf8");
  const before = await (await fetch(base + "/api/projects/fixture/tasks/D-USER", { headers: { Authorization: "Bearer " + secret } })).json();
  const response = await fetch(base + "/api/projects/fixture/tasks/D-USER/test-result", {
    method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "delivery.user.001", expectedRevision: before.registryRevision,
      actorType: "test_ai", actorId: "tester", sessionId: "sess-delivery-user",
      testResult: "pass", reportPath: "reports/D-USER/pass.md", deliveryDisposition: "user_acceptance", deliveryActions: []
    })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.after.status, "待用户验收");
  assert.equal(body.after.plannedRole, "用户");
});

test("automatic close requires a browser-user authorization event", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-AUTO","F-DELIVERY","product","P0","独测中","独立测试AI","tester","独测窗口","sess-delivery-auto","2026-10-01T00:00:00Z","低风险自动闭环夹具","测试计划.md","cp/D-AUTO.md"]
  ]), "utf8");
  const getTask = async () => (await (await fetch(base + "/api/projects/fixture/tasks/D-AUTO", { headers: { Authorization: "Bearer " + secret } })).json());
  let before = await getTask();
  const denied = await fetch(base + "/api/projects/fixture/tasks/D-AUTO/test-result", {
    method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "delivery.auto.denied", expectedRevision: before.registryRevision, actorType: "test_ai", actorId: "tester", sessionId: "sess-delivery-auto", testResult: "pass", reportPath: "reports/D-AUTO/pass.md", deliveryDisposition: "auto_close", deliveryActions: [] })
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error.code, "AUTO_CLOSE_NOT_AUTHORIZED");

  const { cookie, csrf } = await login(base, secret);
  before = await getTask();
  const authorized = await fetch(base + "/api/projects/fixture/tasks/D-AUTO/review", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "delivery.auto.authorize", expectedRevision: before.registryRevision, action: "authorize_auto_close", note: "用户明确授权该低风险任务测试通过后自动完成" })
  });
  assert.equal(authorized.status, 200);
  before = await getTask();
  assert.equal(before.autoCloseAuthorization.authorized, true);
  const closed = await fetch(base + "/api/projects/fixture/tasks/D-AUTO/test-result", {
    method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "delivery.auto.closed", expectedRevision: before.registryRevision, actorType: "test_ai", actorId: "tester", sessionId: "sess-delivery-auto", testResult: "pass", reportPath: "reports/D-AUTO/pass.md", deliveryDisposition: "auto_close", deliveryActions: [] })
  });
  assert.equal(closed.status, 200);
  const body = await closed.json();
  assert.equal(body.after.status, "已完成");
});

test("code changes during delivery invalidate prior test evidence and return to retest", async (t) => {
  const { base, secret, fixture } = await startFixture(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-CHANGE","F-DELIVERY","product","P0","交付中","开发AI","developer","交付窗口","sess-delivery-change","2026-10-01T00:00:00Z","交付变更夹具","测试计划.md","cp/D-CHANGE.md"]
  ]), "utf8");
  const response = await fetch(base + "/api/projects/fixture/tasks/D-CHANGE/events", {
    method: "POST", headers: { Authorization: "Bearer " + secret, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "delivery.change.code", eventType: "code_change", actorType: "developer_ai", actorId: "developer", sessionId: "sess-delivery-change", metadata: { changedPaths: ["server/a.mjs"] } })
  });
  assert.equal(response.status, 200);
  const after = await (await fetch(base + "/api/projects/fixture/tasks/D-CHANGE", { headers: { Authorization: "Bearer " + secret } })).json();
  assert.equal(after.status, "待复测");
  assert.equal(after.plannedRole, "独立测试AI");
  assert.equal(after.assignee, "");
  assert.equal(after.sessionId, "");
});

test("project removal is browser-only, blocks active work/resources, and never deletes project files", async (t) => {
  const { base, secret, fixture, app } = await startFixture(t);
  const { cookie, csrf } = await login(base, secret);

  const bearerDenied = await fetch(base + "/api/projects/fixture", {
    method: "DELETE",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "project.remove.bearer.denied" })
  });
  assert.equal(bearerDenied.status, 403);
  assert.equal((await bearerDenied.json()).error.code, "BROWSER_ADMIN_REQUIRED");

  const activeDenied = await fetch(base + "/api/projects/fixture", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "project.remove.active.denied" })
  });
  assert.equal(activeDenied.status, 409);
  const activeBody = await activeDenied.json();
  assert.equal(activeBody.error.code, "PROJECT_REMOVE_BLOCKED");
  assert.deepEqual(activeBody.error.details.activeTaskIds, ["B-10"]);

  const safeRoot = path.join(fixture.boardRoot, "safe-remove-project");
  const safeRegistry = registryText([
    ["SAFE-1","F-SAFE","product","P1","待开发","开发AI","—","—","—","—","safe","测试计划.md","cp/SAFE-1.md"]
  ]);
  await fs.mkdir(safeRoot, { recursive: true });
  const safeRegistryPath = path.join(safeRoot, "待办任务总清单.md");
  await fs.writeFile(safeRegistryPath, safeRegistry, "utf8");
  const addSafe = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ root: safeRoot, id: "safe-remove", name: "Safe Remove" })
  });
  assert.equal(addSafe.status, 201);

  await app.taskStore.appendTaskEvent("safe-remove", "SAFE-1", {
    operationId: "project.remove.resource.preserve",
    eventType: "test_resource_preserved",
    actorType: "test_ai",
    actorId: "fixture-test",
    metadata: {
      resourceId: "fixture-resource",
      resourceType: "temporary_service",
      locator: "127.0.0.1:49999",
      purpose: "remove project guard fixture",
      safetyStatus: "isolated"
    }
  });
  const resourceDenied = await fetch(base + "/api/projects/safe-remove", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "project.remove.resource.denied" })
  });
  assert.equal(resourceDenied.status, 409);
  const resourceBody = await resourceDenied.json();
  assert.equal(resourceBody.error.code, "PROJECT_REMOVE_BLOCKED");
  assert.deepEqual(resourceBody.error.details.activeResourceIds, ["SAFE-1:fixture-resource"]);

  await app.taskStore.appendTaskEvent("safe-remove", "SAFE-1", {
    operationId: "project.remove.resource.cleaned",
    eventType: "test_resource_cleaned",
    actorType: "developer_ai",
    actorId: "fixture-dev",
    metadata: { resourceId: "fixture-resource" }
  });
  const removed = await fetch(base + "/api/projects/safe-remove", {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ operationId: "project.remove.safe.success" })
  });
  assert.equal(removed.status, 200);
  const removedBody = await removed.json();
  assert.equal(removedBody.removedProject.id, "safe-remove");
  assert.equal((await fs.stat(safeRoot)).isDirectory(), true);
  assert.equal(await fs.readFile(safeRegistryPath, "utf8"), safeRegistry);
  const projects = await (await fetch(base + "/api/projects", { headers: { Cookie: cookie } })).json();
  assert.equal(projects.projects.some((item) => item.id === "safe-remove"), false);
});