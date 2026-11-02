import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const templateRoot = path.resolve("templates/webcodex-v1");
const coreFiles = ["AGENTS.md", "WORKFLOW.md"];
const roleFiles = [
  "流程文档/00_统一入口.md",
  "流程文档/总控/00_角色入口.md",
  "流程文档/开发/00_角色入口.md",
  "流程文档/独测/00_角色入口.md"
];
const ponytailPath = path.join(".agents", "skills", "ponytail", "SKILL.md");
test("universal template has a complete portable Ponytail-based three-role entry", async () => {
  const projectSample = JSON.parse(await fs.readFile(path.resolve("config/projects.example.json"), "utf8"));
  assert.equal(projectSample.projects[0].root, ".", "portable example root must be relative");
  const skill = await fs.readFile(path.join(templateRoot, ponytailPath), "utf8");
  assert.match(skill, /^name: ponytail$/m);
  assert.match(skill, /^license: MIT$/m);
  assert.equal(skill, await fs.readFile(path.resolve(ponytailPath), "utf8"));
  for (const file of coreFiles) {
    const body = await fs.readFile(path.join(templateRoot, file), "utf8");
    assert.ok(body.includes("ponytail/SKILL.md"), `${file} must mandate Ponytail`);
    assert.doesNotMatch(body, /docs\/governance\/|docs\/产品需求\//, `${file} must not depend on Wyerp private files`);
  }
  const controller = await fs.readFile(path.join(templateRoot, "CONTROLLER_PROMPT.md"), "utf8");
  assert.doesNotMatch(controller, /20261101_WyerpTaskboard全流程角色任务审计_NO_GO|00_WyerpTaskboard核心产品需求|docs\/流程标准\//);
  for (const file of roleFiles) {
    const source = await fs.readFile(path.resolve(file), "utf8");
    const snapshot = await fs.readFile(path.join(templateRoot, file), "utf8");
    assert.equal(snapshot, source, `${file} must match the sole authoritative workflow`);
    assert.match(source, /ponytail\/SKILL\.md|Ponytail|三轮/);
  }
  for (const oldRole of ["总控AI.md", "开发AI.md", "独立测试AI.md"]) {
    await assert.rejects(fs.access(path.resolve(oldRole)), (error) => error.code === "ENOENT");
    await assert.rejects(fs.access(path.join(templateRoot, oldRole)), (error) => error.code === "ENOENT");
  }
  for (const entry of [
    "AGENTS.md", "WORKFLOW.md", "README.md",
    "templates/webcodex-v1/AGENTS.md", "templates/webcodex-v1/WORKFLOW.md",
    "templates/webcodex-v1/CONTROLLER_PROMPT.md",
    "templates/webcodex-v1/DEV_PROMPT.md", "templates/webcodex-v1/TEST_PROMPT.md"
  ]) {
    const content = await fs.readFile(path.resolve(entry), "utf8");
    assert.ok(content.includes("流程文档/"), `${entry} must link the new single workflow`);
    assert.doesNotMatch(content, /(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\[^\\]/, `${entry} must not contain a machine-specific absolute path`);
  }
});

const schema = JSON.parse(await fs.readFile(path.join(templateRoot, "software-project-config.schema.json"), "utf8"));
const examples = [
  { id: "nodejs", folder: "examples/node-project", expectedLanguage: "nodejs" },
  { id: "python", folder: "examples/python-project", expectedLanguage: "python" }
];
const loadedExamples = [];
for (const example of examples) {
  const root = path.join(templateRoot, example.folder);
  const profile = JSON.parse(await fs.readFile(path.join(root, "wyerp-taskboard.project.json"), "utf8"));
  loadedExamples.push({ example, root, profile });
}

function validateProfile(profile, expectedLanguage) {
  assert.equal(profile.schemaVersion, schema.properties.schemaVersion.const);
  for (const key of schema.required) assert.ok(Object.hasOwn(profile, key), `missing ${key}`);
  assert.match(profile.project.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.equal(profile.technology.language, expectedLanguage);
  assert.ok(schema.properties.technology.properties.language.enum.includes(profile.technology.language));
  assert.equal(profile.git.defaultBranch.length > 0, true);
  assert.ok(["merge", "pull_request"].includes(profile.git.mergeStrategy));
  assert.equal(profile.workflow.templateId, "wyerp-software-project-v1");
  assert.match(profile.workflow.templateVersion, /^\d+\.\d+\.\d+$/);
  assert.ok(["system", "user_ui_business"].includes(profile.workflow.acceptanceScope));
  assert.equal(profile.projectRules.preserveExistingDocs, true);
  assert.ok(Array.isArray(profile.projectRules.protectedPaths));
  assert.ok(Array.isArray(profile.projectRules.readOnlyPaths));
  assert.ok(Array.isArray(profile.projectRules.writePaths));
  assert.ok(Array.isArray(profile.environment.requiredEnvironmentVariables));
  assert.ok(!Object.hasOwn(profile, "roles"), "projects must not define their own role system");
  assert.ok(!Object.hasOwn(profile, "statuses"), "projects must not define their own workflow state machine");
  const command = profile.qualityGates.test;
  assert.equal(typeof command.executable, "string");
  assert.ok(Array.isArray(command.args), "commands must use argv, not a shell string");
  assert.equal(typeof command.cwd, "string");
  assert.ok(command.timeoutSeconds > 0);
}

test("Node.js and Python projects share one versioned project configuration contract", async () => {
  for (const { example, profile } of loadedExamples) {
    validateProfile(profile, example.expectedLanguage);
  }

  const profiles = loadedExamples;
  assert.equal(profiles[0].profile.workflow.templateId, profiles[1].profile.workflow.templateId);
  assert.equal(profiles[0].profile.workflow.templateVersion, profiles[1].profile.workflow.templateVersion);
  assert.equal(profiles[0].profile.workflow.acceptanceScope, profiles[1].profile.workflow.acceptanceScope);
  assert.notEqual(profiles[0].profile.technology.language, profiles[1].profile.technology.language);
  assert.notDeepEqual(profiles[0].profile.qualityGates.test, profiles[1].profile.qualityGates.test);

  assert.ok(schema.properties.workflow.properties.templateVersion);
  assert.equal(schema.properties.workflow.properties.templateId.const, "wyerp-software-project-v1");
  assert.equal(schema.properties.projectRules.properties.preserveExistingDocs.const, true);
});

test("both technology-stack examples execute their declared test gates", () => {
  for (const { example, root, profile } of loadedExamples) {
    const command = profile.qualityGates.test;
    const result = spawnSync(command.executable, command.args, {
      cwd: path.resolve(root, command.cwd),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: command.timeoutSeconds * 1000,
      windowsHide: true
    });
    assert.equal(result.error, undefined, `${example.id} test command could not start: ${result.error?.message || "unknown error"}`);
    assert.equal(result.status, 0, `${example.id} test gate failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
});

test("copied template works from a different project directory", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-portable-"));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const clone = path.join(temporaryRoot, "webcodex-v1");
  await fs.cp(templateRoot, clone, { recursive: true });
  for (const { example, profile } of loadedExamples) {
    const command = profile.qualityGates.test;
    const result = spawnSync(command.executable, command.args, {
      cwd: path.resolve(clone, example.folder, command.cwd),
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      timeout: command.timeoutSeconds * 1000,
      windowsHide: true
    });
    assert.equal(result.error, undefined, `${example.id} relocated test could not start`);
    assert.equal(result.status, 0, `${example.id} relocated test failed: ${result.stderr || result.stdout}`);
  }
});
