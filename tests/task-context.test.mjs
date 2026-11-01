import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { TaskStore } from "../server/task-store.mjs";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
async function setup(t) {
  const fixture = await makeFixture();
  const { boardRoot: root, projectRoot } = fixture;
  for (const file of ["AGENTS.md", "WORKFLOW.md", "总控AI.md", "开发AI.md", "独立测试AI.md"]) {
    await fs.writeFile(path.join(root, file), "# " + file + "\n通用治理规则", "utf8");
  }
  await fs.writeFile(path.join(projectRoot, "cp", "A-10.md"), "# A-10 断点\n最近已完成步骤", "utf8");
  const store = await new TaskStore(root).init();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { ...fixture, store };
}

test("task ID alone returns real plan, rules, checkpoint, project identity and stage", async t => {
  const x = await setup(t);
  const context = await x.store.executionContext("A-10");
  assert.equal(context.projectId, "fixture");
  assert.equal(context.status, "待开发");
  assert.equal(context.nextRole, "开发AI");
  assert.equal(context.blocked, false);
  assert.match(context.documents.find(d => d.kind === "plan")?.content || "", /夹具计划内容/);
  assert.match(context.documents.find(d => d.kind === "checkpoint")?.content || "", /最近已完成步骤/);
  assert.equal(context.documents.filter(d => d.kind === "rule").length, 5);
  assert.ok(context.documents.every(d => /^[a-f0-9]{64}$/.test(d.sha256)));
  assert.equal(context.task.sessionId, "");
});

test("missing checkpoint or plan is flagged, not silently considered loaded", async t => {
  const x = await setup(t);
  await fs.unlink(path.join(x.projectRoot, "cp", "A-10.md"));
  await fs.unlink(path.join(x.projectRoot, "账号登录与权限开发计划.md"));
  const context = await x.store.executionContext("A-10");
  assert.equal(context.blocked, true);
  assert.ok(context.blockers.some(b => b.kind === "plan"));
  assert.ok(context.blockers.some(b => b.code === "CHECKPOINT_MISSING"));
});

test("unknown, unsafe and ambiguous task IDs fail closed across registered projects", async t => {
  const x = await setup(t);
  await assert.rejects(x.store.executionContext("MISSING-ID"), err => err.code === "TASK_NOT_FOUND");
  await assert.rejects(x.store.executionContext("../A-10"), err => err.code === "INVALID_TASK_ID");
  const configPath = path.join(x.boardRoot, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const projectB = path.join(x.boardRoot, "second-project");
  await fs.cp(x.projectRoot, projectB, { recursive: true });
  config.projects.push({ ...config.projects[0], id: "fixture-b", root: projectB });
  await fs.writeFile(configPath, JSON.stringify(config));
  await x.store.projects.load();
  await assert.rejects(x.store.executionContext("A-10"), err => err.code === "TASK_ID_AMBIGUOUS" && err.details?.projectIds?.length === 2);
  assert.equal((await x.store.executionContext("A-10", { projectId: "fixture-b" })).projectId, "fixture-b");
});

test("HTTP route and taskctl context CLI return actual current data without creating an execution", async t => {
  const x = await setup(t);
  const app = await createTaskboardServer({ rootDir: x.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const resp = await fetch(url + "/api/task-context/A-10");
  assert.equal(resp.status, 200);
  assert.equal((await resp.json()).blocked, false);
  const env = { ...process.env, WYERP_TASKBOARD_URL: url, WYERP_TASKBOARD_ROOT: x.boardRoot };
  const cli = await execFileAsync(process.execPath, [path.resolve("cli/taskctl.mjs"), "context", "--task", "A-10"], { env });
  assert.equal(JSON.parse(cli.stdout).projectId, "fixture");
  assert.equal((await x.store.getTask("fixture", "A-10")).task.status, "待开发");
});
