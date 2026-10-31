import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const templateRoot = path.resolve("templates/webcodex-v1");
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
      timeout: command.timeoutSeconds * 1000,
      windowsHide: true
    });
    assert.equal(result.error, undefined, `${example.id} test command could not start: ${result.error?.message || "unknown error"}`);
    assert.equal(result.status, 0, `${example.id} test gate failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
});
