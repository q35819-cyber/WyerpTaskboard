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

test("real HTTP task context redacts synthetic Bearer, API keys, cookies and private keys without dropping plan", async t => {
  const x = await setup(t);
  const planPath = path.join(x.projectRoot, "账号登录与权限开发计划.md");
  const sample = [
    "# Test plan", "正常任务上下文仍然可读",
    "Authorization: Bearer SYNTHETIC_ONLY_QA_SECRET_98731",
    "api_key=synthetic_api_key_293847",
    "client_secret: synthetic_client_secret_293847",
    "Cookie: session=synthetic_cookie_298347; user=qa",
    "-----BEGIN PRIVATE KEY-----", "SYNTHETIC_PRIVATE_KEY_CONTENT", "-----END PRIVATE KEY-----"
  ].join("\n");
  await fs.appendFile(planPath, "\n" + sample);
  await fs.appendFile(path.join(x.projectRoot, "cp", "A-10.md"), "\naccess_token=synthetic_access_token_918273\n");
  const context = await x.store.executionContext("A-10");
  const all = JSON.stringify(context);
  for (const secret of ["SYNTHETIC_ONLY_QA_SECRET_98731", "synthetic_api_key_293847", "synthetic_client_secret_293847", "synthetic_cookie_298347", "SYNTHETIC_PRIVATE_KEY_CONTENT", "synthetic_access_token_918273"]) {
    assert.equal(all.includes(secret), false, `store leaked ${secret}`);
  }
  assert.match(context.documents.find(d => d.kind === "plan")?.content || "", /正常任务上下文仍然可读/);
  const app = await createTaskboardServer({ rootDir: x.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/task-context/A-10`);
  assert.equal(response.status, 200);
  const payload = await response.text();
  for (const secret of ["SYNTHETIC_ONLY_QA_SECRET_98731", "synthetic_api_key_293847", "synthetic_client_secret_293847", "synthetic_cookie_298347", "SYNTHETIC_PRIVATE_KEY_CONTENT", "synthetic_access_token_918273"]) {
    assert.equal(payload.includes(secret), false, `HTTP leaked ${secret}`);
  }
  assert.match(payload, /正常任务上下文仍然可读/);
  assert.match(payload, /\[REDACTED\]/);
});

test("HTTP also hides JSON credential fields and X-API-Key headers", async t => {
  const x = await setup(t);
  const plan = path.join(x.projectRoot, "账号登录与权限开发计划.md");
  await fs.appendFile(plan, '\n"apiKey": "SYNTHETIC_JSON_KEY_123456"\n"accessToken": "SYNTHETIC_JSON_TOKEN_123456"\nX-API-Key: SYNTHETIC_HEADER_KEY_123456\n');
  const app = await createTaskboardServer({ rootDir: x.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/task-context/A-10`);
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const secret of ["SYNTHETIC_JSON_KEY_123456", "SYNTHETIC_JSON_TOKEN_123456", "SYNTHETIC_HEADER_KEY_123456"]) {
    assert.equal(body.includes(secret), false, `HTTP leaked ${secret}`);
  }
  assert.match(body, /夹具计划内容/);
});

test("independent QA R2: ten synthetic credentials stay out of direct context and real unauthenticated localhost HTTP", async t => {
  const x = await setup(t);
  const cases = [
    ["openai_prefixed_key", "OPENAI_API_KEY=SYNTH_R2_OPENAI_643829", "SYNTH_R2_OPENAI_643829"],
    ["aws_secret_access_key", "AWS_SECRET_ACCESS_KEY=SYNTH_R2_AWS_673218", "SYNTH_R2_AWS_673218"],
    ["github_token", "GITHUB_TOKEN=SYNTH_R2_GITHUB_903112", "SYNTH_R2_GITHUB_903112"],
    ["double_quote_bearer", 'Authorization: Bearer "SYNTH_R2_BEARER_DOUBLE_56231"', "SYNTH_R2_BEARER_DOUBLE_56231"],
    ["single_quote_bearer", "Authorization: Bearer 'SYNTH_R2_BEARER_SINGLE_99456'", "SYNTH_R2_BEARER_SINGLE_99456"],
    ["session_token_json", '"session_token": "SYNTH_R2_SESSION_239011"', "SYNTH_R2_SESSION_239011"],
    ["x_auth_token", "X-Auth-Token: SYNTH_R2_XAUTH_593118", "SYNTH_R2_XAUTH_593118"],
    ["basic_header", "Authorization: Basic SYNTH_R2_BASIC_349008", "SYNTH_R2_BASIC_349008"],
    ["database_url", "DATABASE_URL=postgresql://user:SYNTH_R2_DB_209348@localhost/db", "SYNTH_R2_DB_209348"],
    ["url_api_key", "https://example.invalid/?api_key=SYNTH_R2_URL_390002", "SYNTH_R2_URL_390002"]
  ];
  const planFile = path.join(x.projectRoot, "账号登录与权限开发计划.md");
  await fs.appendFile(planFile, "\n# Legitimate content remains\n正常计划依然完整\n" + cases.map(item => item[1]).join("\n") + "\n");
  await fs.appendFile(path.join(x.projectRoot, "cp", "A-10.md"), "\nGITHUB_TOKEN=SYNTH_R2_CP_748300\n正常断点依然完整\n");
  await fs.appendFile(path.join(x.boardRoot, "WORKFLOW.md"), "\nOPENAI_API_KEY=SYNTH_R2_RULE_732551\n正常规则依然完整\n");
  const secrets = [...cases.map(item => item[2]), "SYNTH_R2_CP_748300", "SYNTH_R2_RULE_732551"];
  const direct = await x.store.executionContext("A-10");
  assert.equal(direct.blocked, false);
  assert.match(direct.documents.find(item => item.kind === "plan").content, /正常计划依然完整/);
  assert.match(direct.documents.find(item => item.kind === "checkpoint").content, /正常断点依然完整/);
  assert.match(direct.documents.find(item => item.kind === "rule" && item.path === "WORKFLOW.md").content, /正常规则依然完整/);
  const directJson = JSON.stringify(direct);
  const app = await createTaskboardServer({ rootDir: x.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/api/task-context/A-10`);
  assert.equal(res.status, 200);
  const httpJson = await res.text();
  for (const [index, secret] of secrets.entries()) {
    assert.equal(directJson.includes(secret), false, `direct context leak: ${index < cases.length ? cases[index][0] : "rule/checkpoint"}`);
    assert.equal(httpJson.includes(secret), false, `HTTP context leak: ${index < cases.length ? cases[index][0] : "rule/checkpoint"}`);
  }
  assert.match(httpJson, /正常计划依然完整/);
  assert.match(httpJson, /正常断点依然完整/);
  assert.match(httpJson, /正常规则依然完整/);
  assert.match(httpJson, /\[REDACTED\]/);
  // Original user-authored plans must not be rewritten by a read-only API.
  assert.match(await fs.readFile(planFile, "utf8"), /SYNTH_R2_OPENAI_643829/);
});

test("R3 QA proof and JWT secrets stay out of direct task context and real HTTP", async t => {
  const x = await setup(t);
  const cases = [
    ["X-Wyerp-Controller-Proof: QA_SYNTH_CTRLHDR_719331", "QA_SYNTH_CTRLHDR_719331"],
    ["WYERP_CONTROLLER_PROOF=QA_SYNTH_CTRLENV_719332", "QA_SYNTH_CTRLENV_719332"],
    ["JWT_SECRET=QA_SYNTH_JWTSECRET_719333", "QA_SYNTH_JWTSECRET_719333"],
    ["POSTGRES_PASSWORD=QA_SYNTH_POSTGRES_719334", "QA_SYNTH_POSTGRES_719334"],
    ["Proxy-Authorization: Basic QA_SYNTH_PROXY_719335", "QA_SYNTH_PROXY_719335"],
    ["OPENAI_API_KEY=QA_SYNTH_OPENAI_719336", "QA_SYNTH_OPENAI_719336"],
    ['"password": "QA_SYNTH_JSON_719337"', "QA_SYNTH_JSON_719337"]
  ];
  const plan = path.join(x.projectRoot, "账号登录与权限开发计划.md");
  await fs.appendFile(plan, "\n正常任务内容仍可读取\n" + cases.map(c => c[0]).join("\n") + "\n");
  await fs.appendFile(path.join(x.projectRoot, "cp", "A-10.md"), "\nJWT_SECRET=QA_SYNTH_CP_719338\n正常断点仍可读取\n");
  await fs.appendFile(path.join(x.boardRoot, "WORKFLOW.md"), "\nX-Wyerp-Controller-Proof: QA_SYNTH_RULE_719339\n正常规则仍可读取\n");
  const secrets = [...cases.map(c => c[1]), "QA_SYNTH_CP_719338", "QA_SYNTH_RULE_719339"];
  const direct = await x.store.executionContext("A-10");
  assert.equal(direct.blocked, false);
  const content = JSON.stringify(direct);
  const app = await createTaskboardServer({ rootDir: x.boardRoot, port: 0 });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/task-context/A-10`);
  assert.equal(response.status, 200);
  const http = await response.text();
  for (const secret of secrets) {
    assert.equal(content.includes(secret), false, "TaskStore leaked " + secret);
    assert.equal(http.includes(secret), false, "HTTP leaked " + secret);
  }
  for (const text of ["正常任务内容仍可读取", "正常断点仍可读取", "正常规则仍可读取"]) {
    assert.match(content, new RegExp(text));
    assert.match(http, new RegExp(text));
  }
  assert.match(await fs.readFile(plan, "utf8"), /QA_SYNTH_CTRLHDR_719331/);
});

test("sensitive task metadata, history and related documents are scrubbed without rewriting stored data", async t => {
  const x = await setup(t);
  const registry = await fs.readFile(x.registryPath, "utf8");
  await fs.writeFile(x.registryPath, registry.replace("权限收口", "权限收口 GITHUB_TOKEN=SYNTH_R2_METADATA_309884"));
  await x.store.appendTaskEvent("fixture", "A-10", {
    operationId: "qa.r2.context.event.001", eventType: "developer_note",
    actorType: "developer_ai", actorId: "qa-r2",
    note: "AWS_SECRET_ACCESS_KEY=SYNTH_R2_HISTORY_480930",
    metadata: { credentials: "session_token=SYNTH_R2_EVENT_JSON_390110" }
  });
  const data = await x.store.executionContext("A-10");
  const serialized = JSON.stringify(data);
  for (const value of ["SYNTH_R2_METADATA_309884", "SYNTH_R2_HISTORY_480930", "SYNTH_R2_EVENT_JSON_390110"]) {
    assert.equal(serialized.includes(value), false, `private task or history value leaked: ${value}`);
  }
  assert.match(serialized, /权限收口/);
  assert.ok(data.history.some(item => item.event_type === "developer_note"));
  assert.match(await fs.readFile(x.registryPath, "utf8"), /SYNTH_R2_METADATA_309884/);
});
