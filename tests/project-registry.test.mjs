import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { ProjectRegistry } from "../server/project-registry.mjs";
import { makeFixture } from "./helpers.mjs";

test("project registry loads adapter/profile and reports healthy source", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  const context = await registry.context("fixture");
  assert.equal(context.project.workflowProfile, "wyerp-ai-flow-v1");
  assert.equal(context.project.adapter, "markdown-task-registry-v1");
  assert.equal((await registry.health("fixture")).status, "healthy");
});

test("project path traversal is rejected", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const configPath = path.join(fixture.boardRoot, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.projects[0].taskRegistry = "../outside.md";
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  const health = await registry.health("fixture");
  assert.equal(health.writable, false);
  assert.equal(health.error.code, "PATH_TRAVERSAL_REJECTED");
});

test("junction/symlink escape is rejected when platform allows creation", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(path.dirname(fixture.boardRoot), "wyerp-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "tasks.md"), "outside", "utf8");
  const link = path.join(fixture.projectRoot, "escape");
  try {
    await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`platform cannot create test symlink/junction: ${error.code}`);
    return;
  }
  const configPath = path.join(fixture.boardRoot, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.projects[0].taskRegistry = "escape/tasks.md";
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  const health = await registry.health("fixture");
  assert.equal(health.writable, false);
  assert.ok(["PROJECT_ROOT_ESCAPE","REPARSE_POINT_REJECTED"].includes(health.error.code));
});


test("one unavailable project source does not poison healthy projects", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const configPath = path.join(fixture.boardRoot, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.projects.push({
    ...config.projects[0],
    id: "missing",
    name: "Missing",
    root: path.join(fixture.boardRoot, "does-not-exist")
  });
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");

  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  const missing = await registry.health("missing");
  const healthy = await registry.health("fixture");

  assert.equal(missing.writable, false);
  assert.equal(missing.status, "source_unavailable");
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.writable, true);
});



test("incompatible project is registered as adaptation_required instead of losing the path", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const legacyRoot = path.join(fixture.boardRoot, "legacy-project");
  await fs.mkdir(legacyRoot, { recursive: true });
  await fs.writeFile(path.join(legacyRoot, "待办任务总清单.md"), "# legacy task list without machine registry\n", "utf8");

  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  const result = await registry.addProject({
    root: legacyRoot,
    id: "legacy-project",
    name: "Legacy Project",
    taskRegistry: "待办任务总清单.md"
  });

  assert.equal(result.validation.adaptationRequired, true);
  assert.ok(result.validation.sourceError);
  assert.equal(registry.get("legacy-project").onboardingStatus, "adaptation_required");
  assert.equal(registry.list().some((item) => item.id === "legacy-project"), true);
});


test("adaptProject preserves legacy content and creates a P0 plan-governance task", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const legacyRoot = path.join(fixture.boardRoot, "legacy-adapt-project");
  await fs.mkdir(legacyRoot, { recursive: true });
  const original = "# 原项目任务清单\n\n这里是已有业务记录，自动适配不能覆盖。\n";
  await fs.writeFile(path.join(legacyRoot, "待办任务总清单.md"), original, "utf8");

  const registry = await new ProjectRegistry(fixture.boardRoot).load();
  await registry.addProject({
    root: legacyRoot,
    id: "legacy-adapt-project",
    name: "Legacy Adapt Project",
    taskRegistry: "待办任务总清单.md"
  });
  const result = await registry.adaptProject("legacy-adapt-project");

  const adapted = await fs.readFile(path.join(legacyRoot, "待办任务总清单.md"), "utf8");
  assert.ok(adapted.startsWith(original));
  assert.match(adapted, /PROJECT_TASK_REGISTRY_START v1/);
  assert.match(adapted, /BOARD-PLAN-AUDIT-001/);
  assert.match(adapted, /\| infrastructure \| P0 \| 待开发 \| 开发AI \|/);
  assert.match(await fs.readFile(path.join(legacyRoot, "任务看板适配与计划补全计划.md"), "utf8"), /BOARD-PLAN-AUDIT-001/);
  assert.equal(result.createdGovernanceTaskId, "BOARD-PLAN-AUDIT-001");
  assert.equal(registry.get("legacy-adapt-project").onboardingStatus, undefined);
  assert.equal((await registry.health("legacy-adapt-project")).status, "healthy");
});

test("removeProject unregisters management only and preserves project files", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const beforeRegistry = await fs.readFile(fixture.registryPath, "utf8");
  const registry = await new ProjectRegistry(fixture.boardRoot).load();

  const result = await registry.removeProject("fixture");

  assert.equal(result.removedProject.id, "fixture");
  assert.deepEqual(registry.list(), []);
  assert.equal(await fs.readFile(fixture.registryPath, "utf8"), beforeRegistry, "移除管理不得改写被管理项目任务清单");
  assert.equal((await fs.stat(fixture.projectRoot)).isDirectory(), true, "移除管理不得删除项目目录");
  const config = JSON.parse(await fs.readFile(path.join(fixture.boardRoot, "config", "projects.json"), "utf8"));
  assert.deepEqual(config.projects, []);
});