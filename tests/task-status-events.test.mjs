import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskboardServer } from "../server/http-server.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture, registryText } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

async function start(t, extra = false) {
  const fixture = await makeFixture();
  const streams = [];
  if (extra) {
    const configFile = path.join(fixture.boardRoot, "config", "projects.json");
    const config = JSON.parse(await fs.readFile(configFile, "utf8"));
    const otherRoot = path.join(fixture.boardRoot, "other-project");
    await fs.mkdir(otherRoot);
    await fs.writeFile(path.join(otherRoot, "tasks.md"), registryText());
    config.projects.push({ ...config.projects[0], id: "other", name: "Other", root: otherRoot });
    await fs.writeFile(configFile, JSON.stringify(config));
  }
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const stream of streams) await stream.close();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  return { base: "http://127.0.0.1:" + app.server.address().port, fixture, app, streams };
}

async function connect(t, base, projectId, streams) {
  const controller = new AbortController();
  const response = await fetch(base + "/api/projects/" + projectId + "/task-status-events",
    { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const waiters = [];
  const reader = response.body.getReader();
  const pump = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const type = block.match(/^event: (.+)$/m)?.[1];
        if (!type) continue;
        const value = block.match(/^data: (.*)$/m)?.[1] || "";
        events.push({ type, value });
        for (const wake of [...waiters]) wake();
      }
    }
  })().catch(e => {
    if (!controller.signal.aborted) throw e;
  });
  const stream = {
    events,
    async until(type, n = 1, timeout = 8000) {
      if (events.filter(x => x.type === type).length >= n) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(check), 1);
          reject(new Error("SSE " + type + " not received"));
        }, timeout);
        function check() {
          if (events.filter(x => x.type === type).length < n) return;
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(check), 1);
          resolve();
        }
        waiters.push(check);
      });
    },
    async close() {
      controller.abort();
      await pump.catch(() => {});
    }
  };
  streams.push(stream);
  t.after(() => stream.close());
  await stream.until("ready");
  return stream;
}

// A separate process writes the same committed journal that HTTP/taskctl/scanner use.
async function externalStatusChange(root, projectId, operationId, patch) {
  const code = `import { TaskStore } from "./server/task-store.mjs";
    const store = await new TaskStore(process.argv[1]).init();
    const project = process.argv[2];
    const before = await store.getTask(project, "B-10");
    const result = await store.updateTask(project, "B-10", JSON.parse(process.argv[4]), {
      expectedRevision: before.snapshot.registryRevision, operationId: process.argv[3],
      eventType: "temporary_block", actorType: "controller_ai",
      actorId: "external-worker", sessionId: "external-session",
      metadata: { conditions: [{ kind: "required_file_exists", path: "read/B-10.md" }] }
    });
    console.log(result.eventId);`;
  const result = await execFileAsync(process.execPath,
    ["--input-type=module", "-e", code, root, projectId, operationId, JSON.stringify(patch)],
    { cwd: process.cwd(), timeout: 12000 });
  assert.match(result.stdout, /evt_[a-f0-9]+/);
}

test("developer block requires recorded external issue instead of a bare note", async t => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const store = await new TaskStore(fixture.boardRoot).init();
  const expectedRevision = (await store.snapshot("fixture")).registryRevision;
  const base = { expectedRevision, actorType: "developer_ai", actorId: "worker", sessionId: "wc_sess_test" };
  await assert.rejects(store.updateTask("fixture", "B-10", { status: "阻断" }, {
    ...base, operationId: "dev.bare.block.001", eventType: "status_change"
  }), e => e.code === "DEVELOPER_SELF_REPAIR_REQUIRED");
  await assert.rejects(store.updateTask("fixture", "B-10", { status: "阻断" }, {
    ...base, operationId: "dev.forged.block.001", eventType: "developer_external_pause",
    metadata: { evidenceEventId: "evt_fake", externalIssueVerified: true }
  }), e => e.code === "DEVELOPER_SELF_REPAIR_REQUIRED");
  const still = (await store.getTask("fixture", "B-10")).task;
  assert.equal(still.status, "开发中");
  assert.equal(still.sessionId, "wc_sess_test");
  const issue = await store.appendTaskEvent("fixture", "B-10", {
    operationId: "dev.issue.001", eventType: "developer_external_issue_reported",
    actorType: "developer_ai", actorId: "worker", sessionId: "wc_sess_test",
    metadata: { errorCode: "EXTERNAL_FIX_NOT_RELEASED", relatedTaskId: "A-10",
      resumeCondition: "A-10正式发布后复核", reportPath: "reports/B-10/report.md" }
  });
  const result = await store.updateTask("fixture", "B-10", { status: "阻断" }, {
    ...base, operationId: "dev.external.pause.001", eventType: "developer_external_pause",
    metadata: { evidenceEventId: issue.event.event_id }
  });
  assert.equal(result.after.status, "阻断");
  assert.equal(result.after.sessionId, "");
  const events = await store.events.listTaskEvents("fixture", "B-10", { all: true });
  assert.equal(events.at(-1).metadata.externalIssueEventId, issue.event.event_id);
});
test("R1 committed cross-process task status sends only matching project's SSE refresh", async t => {
  const { base, fixture, streams } = await start(t, true);
  const first = await connect(t, base, "fixture", streams);
  const second = await connect(t, base, "other", streams);
  await externalStatusChange(fixture.boardRoot, "fixture", "status.sse.cross-process.0001",
    { status: "阻断", assignee: "", sessionId: "", sessionWindowName: "" });
  await first.until("status");
  assert.deepEqual(JSON.parse(first.events.find(e => e.type === "status").value), { refresh: true });
  assert.equal(second.events.filter(e => e.type === "status").length, 0);
  await externalStatusChange(fixture.boardRoot, "other", "status.sse.cross-process.0002",
    { status: "阻断", assignee: "", sessionId: "", sessionWindowName: "" });
  await second.until("status");
  assert.equal(first.events.filter(e => e.type === "status").length, 1);
  const snapshot = await (await fetch(base + "/api/projects/fixture/tasks")).json();
  assert.equal(snapshot.tasks.find(item => item.id === "B-10").status, "阻断");
  await first.close();
  const reconnected = await connect(t, base, "fixture", streams);
  assert.equal(reconnected.events.find(e => e.type === "ready").value, "{}");
  assert.equal((await (await fetch(base + "/api/projects/fixture/tasks")).json())
    .tasks.find(item => item.id === "B-10").status, "阻断");
});

test("R2 rejects forged/uncommitted, same-status and log-only events without SSE noise", async t => {
  const { base, fixture, app, streams } = await start(t);
  const listener = await connect(t, base, "fixture", streams);
  const dir = path.join(fixture.boardRoot, "data", "runtime", "transactions");
  await fs.writeFile(path.join(dir, "fake.transaction.00001.json"), JSON.stringify({
    state: "committed", operationId: "fake.transaction.00001", projectId: "fixture",
    taskId: "B-10", event: { project_id: "fixture", task_id: "B-10", old_status: "开发中", new_status: "阻断" },
    result: { eventId: "evt_fake" }
  }));
  await fs.writeFile(path.join(dir, "uncommitted.00001.json"), JSON.stringify({
    state: "event_written", operationId: "uncommitted.00001", projectId: "fixture",
    taskId: "B-10", event: { project_id: "fixture", task_id: "B-10", old_status: "开发中", new_status: "阻断" },
    result: { eventId: "evt_fake" }
  }));
  await app.taskStore.appendTaskEvent("fixture", "B-10", {
    operationId: "status.sse.logonly.0001", eventType: "comment",
    actorType: "developer_ai", actorId: "worker", sessionId: "worker-session"
  });
  const before = await app.taskStore.getTask("fixture", "B-10");
  await assert.rejects(app.taskStore.updateTask("fixture", "B-10", { status: "阻断" }, {
    operationId: "status.sse.bad-revision.0001", expectedRevision: "wrong-revision",
    actorType: "developer_ai", actorId: "worker", sessionId: "worker-session"
  }));
  await app.taskStore.updateTask("fixture", "B-10", { priority: "P1" }, {
    operationId: "status.sse.no-status-change.0001",
    expectedRevision: before.snapshot.registryRevision,
    eventType: "task_update", actorType: "developer_ai",
    actorId: "worker", sessionId: "worker-session"
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(listener.events.filter(e => e.type === "status").length, 0);
  await listener.close();
  assert.equal((await fetch(base + "/api/projects/no-such-project/task-status-events")).status, 404);
});
