import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const taskctlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cli/taskctl.mjs");

async function runTaskctl(rootDir, base, args) {
  return execFileAsync(process.execPath, [taskctlPath, ...args], {
    cwd: path.resolve("."),
    windowsHide: true,
    env: { ...process.env, WYERP_TASKBOARD_ROOT: rootDir, WYERP_TASKBOARD_URL: base },
    maxBuffer: 2 * 1024 * 1024
  });
}

test("taskctl takeover only succeeds after browser user authorization", async (t) => {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });

  const suspected = JSON.parse((await runTaskctl(fixture.boardRoot, base, [
    "suspect-disconnect", "--project", "fixture", "--task", "B-10",
    "--note", "原会话不可恢复；已核对无活跃Job和写入",
    "--actor-id", "observer-A"
  ])).stdout);
  assert.equal(suspected.suspectedDisconnect, true);

  await assert.rejects(
    runTaskctl(fixture.boardRoot, base, [
      "takeover", "--project", "fixture", "--task", "B-10",
      "--assignee", "new-ai", "--session-name", "新开发窗口", "--session-id", "wc_sess_new",
      "--actor-id", "new-ai", "--note", "未授权接管"
    ]),
    (error) => {
      assert.match(error.stderr, /TAKEOVER_NOT_ALLOWED/);
      return true;
    }
  );

  const auth = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "admin-secret.json"), "utf8"));
  const login = await fetch(base + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: auth.adminSecret })
  });
  const loginBody = await login.json();
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const allow = await fetch(base + "/api/projects/fixture/tasks/B-10/takeover/allow", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: base,
      "X-CSRF-Token": loginBody.csrfToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      operationId: "taskctl.takeover.allow.001",
      note: "用户确认现场核验完成，允许一次异常接管"
    })
  });
  assert.equal(allow.status, 200);

  const result = JSON.parse((await runTaskctl(fixture.boardRoot, base, [
    "takeover", "--project", "fixture", "--task", "B-10",
    "--assignee", "new-ai", "--session-name", "新开发窗口", "--session-id", "wc_sess_new",
    "--actor-id", "new-ai", "--note", "按用户授权接管"
  ])).stdout);
  assert.equal(result.after.status, "开发中");
  assert.equal(result.after.assignee, "new-ai");
  assert.equal(result.after.sessionId, "wc_sess_new");
});

test("taskctl takeover forwards explicit chat approval without a browser click", async (t) => {
  const fixture = await makeFixture();
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", resolve);
  });
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await fs.rm(fixture.boardRoot, { recursive: true, force: true });
  });
  const result = JSON.parse((await runTaskctl(fixture.boardRoot, base, [
    "takeover", "--project", "fixture", "--task", "B-10",
    "--assignee", "new-chat-ai", "--session-name", "新的ChatGPT窗口", "--session-id", "wc_sess_chat",
    "--actor-id", "new-chat-ai", "--note", "当前对话用户授权的异常接管",
    "--user-quote", "异常接管流程已更新，有需要异常接管你自行处理。当前开发AI只有你一个，所有占用的都是属于异常",
    "--user-scope", "project",
    "--evidence", "已实地确认旧会话不可恢复；无活动Job、资源写入及未决副作用"
  ])).stdout);
  assert.equal(result.after.status, "开发中");
  assert.equal(result.after.assignee, "new-chat-ai");
  assert.equal(result.after.sessionId, "wc_sess_chat");
});
