import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProjectStack, linkRegisteredProjectWorkflow, verifyProjectQuality } from "../server/project-onboarding.mjs";

async function sample(t, names) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wtb-stack-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of names) await fs.writeFile(path.join(root, name), "sample", "utf8");
  return root;
}

test("R1: Node, Python, .NET projects are identified by existing root files", async (t) => {
  for (const [files, stack] of [
    [["package.json"], "node"],
    [["pyproject.toml"], "python"],
    [["requirements.txt"], "python"],
    [["app.py"], "python"],
    [["App.csproj"], "dotnet"],
    [["Workspace.sln"], "dotnet"],
  ]) {
    const root = await sample(t, files);
    const before = await fs.readdir(root);
    const result = await detectProjectStack(root);
    assert.equal(result.supported, true);
    assert.equal(result.stack, stack);
    assert.deepEqual(result.markers, files);
    assert.deepEqual(await fs.readdir(root), before, "the target project must not change");
  }
});

test("R2: unknown and mixed technology roots do not trigger a guess or changes", async (t) => {
  const unknown = await sample(t, ["README.md"]);
  assert.deepEqual(await detectProjectStack(unknown), {
    supported: false, stack: null, reason: "unsupported", markers: []
  });
  const mixed = await sample(t, ["package.json", "pyproject.toml"]);
  assert.deepEqual(await detectProjectStack(mixed), {
    supported: false, stack: null, reason: "ambiguous", markers: ["package.json", "pyproject.toml"]
  });
  assert.deepEqual((await fs.readdir(mixed)).sort(), ["package.json", "pyproject.toml"]);
});

test("R2: invalid and missing roots fail explicitly without creating anything", async (t) => {
  for (const bad of ["", ".", null, 123]) {
    await assert.rejects(detectProjectStack(bad), e => e.code === "PROJECT_ROOT_REQUIRED");
  }
  const root = await sample(t, []);
  const missing = path.join(root, "not-created");
  await assert.rejects(detectProjectStack(missing), e => e.code === "PROJECT_ROOT_UNAVAILABLE");
  await assert.rejects(fs.stat(missing), e => e.code === "ENOENT");
});

test("R3: folders and unrelated JavaScript assets do not imply a backend stack", async (t) => {
  const root = await sample(t, ["index.js", "README.md"]);
  await fs.mkdir(path.join(root, "package.json"));
  assert.equal((await detectProjectStack(root)).supported, false);
  await fs.writeFile(path.join(root, "PROJECT.CSPROJ"), "sample");
  const result = await detectProjectStack(root);
  assert.equal(result.stack, "dotnet");
  assert.deepEqual(result.markers, ["PROJECT.CSPROJ"]);
});

test("R1: registered project receives existing versioned three-role entry files", async (t) => {
  const root = await sample(t, ["package.json"]);
  const registry = { get: (id) => {
    assert.equal(id, "registered-project");
    return { root };
  } };
  const result = await linkRegisteredProjectWorkflow(registry, "registered-project");
  assert.equal(result.templateVersion, "software-project-v1");
  assert.equal(result.created.length, 7);
  assert.deepEqual(result.preserved, []);
  const sourceRoot = path.resolve("templates/webcodex-v1");
  for (const relative of result.created) {
    assert.equal(await fs.readFile(path.join(root, relative), "utf8"),
      await fs.readFile(path.join(sourceRoot, relative), "utf8"));
  }
  assert.match(await fs.readFile(path.join(root, "流程文档/00_统一入口.md"), "utf8"), /统一入口/);
});

test("R2: existing business rules are never overwritten; repeating preserves all files", async (t) => {
  const root = await sample(t, ["package.json", "AGENTS.md"]);
  await fs.writeFile(path.join(root, "AGENTS.md"), "original business rules", "utf8");
  await fs.mkdir(path.join(root, "流程文档"));
  await fs.writeFile(path.join(root, "流程文档/00_统一入口.md"), "project-specific workflow", "utf8");
  const registry = { get: () => ({ root }) };
  const first = await linkRegisteredProjectWorkflow(registry, "registered");
  assert.ok(first.preserved.includes("AGENTS.md"));
  assert.ok(first.preserved.includes("流程文档/00_统一入口.md"));
  assert.equal(first.created.length, 5);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "original business rules");
  assert.equal(await fs.readFile(path.join(root, "流程文档/00_统一入口.md"), "utf8"), "project-specific workflow");
  const second = await linkRegisteredProjectWorkflow(registry, "registered");
  assert.equal(second.created.length, 0);
  assert.equal(second.preserved.length, 7);
  assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "original business rules");
  assert.equal(await fs.readFile(path.join(root, "流程文档/00_统一入口.md"), "utf8"), "project-specific workflow");
});

test("R2: an unknown registration cannot create or change a project", async (t) => {
  const root = await sample(t, ["package.json"]);
  const registry = { get: () => { throw new Error("PROJECT_NOT_REGISTERED"); } };
  const before = await fs.readdir(root);
  await assert.rejects(linkRegisteredProjectWorkflow(registry, "missing"), /PROJECT_NOT_REGISTERED/);
  assert.deepEqual(await fs.readdir(root), before);
});

test("R1: Node test and build commands really run and write PASS evidence outside the target", async (t) => {
  for (const [scripts, label] of [
    [{ test: 'node -e "process.exit(0)"' }, "test"],
    [{ build: 'node -e "process.exit(0)"' }, "build"],
  ]) {
    const root = await sample(t, []);
    const report = path.join(os.tmpdir(), "wtb-quality-" + path.basename(root) + "-" + label + ".json");
    t.after(() => fs.rm(report, { force: true }));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts }), "utf8");
    const before = (await fs.readdir(root)).sort();
    const result = await verifyProjectQuality(root, report);
    assert.equal(result.result, "PASS", JSON.stringify(result));
    assert.equal(result.exitCode, 0);
    assert.equal(result.reason, null);
    assert.equal(result.stack, "node");
    assert.deepEqual(JSON.parse(await fs.readFile(report, "utf8")), result);
    assert.deepEqual((await fs.readdir(root)).sort(), before, "onboarding cannot modify the target");
    await assert.rejects(fs.stat(path.join(root, "node_modules")), { code: "ENOENT" });
  }
});

test("R1: Python real unittest discovery requires a nonzero executed test count", async (t) => {
  const root = await sample(t, ["pyproject.toml"]);
  await fs.mkdir(path.join(root, "tests"));
  await fs.writeFile(path.join(root, "tests", "test_sample.py"),
    "import unittest\nclass Sample(unittest.TestCase):\n    def test_valid(self):\n        self.assertEqual(2, 2)\n", "utf8");
  const report = path.join(root + "-evidence.json");
  t.after(() => fs.rm(report, { force: true }));
  const result = await verifyProjectQuality(root, report);
  assert.equal(result.result, "PASS", JSON.stringify(result));
  assert.match(result.stderr, /Ran 1 test/);
  assert.equal(result.stack, "python");
  assert.deepEqual(JSON.parse(await fs.readFile(report, "utf8")), result);
  await assert.rejects(fs.stat(path.join(root, "tests", "__pycache__")), { code: "ENOENT" });
});

test("R2: missing command, nonzero exit and unavailable .NET tooling persist BLOCK evidence", async (t) => {
  const root = await sample(t, []);
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtb-quality-evidence-"));
  t.after(() => fs.rm(reportDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
  const missing = await verifyProjectQuality(root, path.join(reportDir, "missing.json"));
  assert.equal(missing.result, "BLOCK");
  assert.equal(missing.reason, "command_missing");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
    scripts: { test: 'node -e "process.exit(7)"' }
  }), "utf8");
  const failed = await verifyProjectQuality(root, path.join(reportDir, "failed.json"));
  assert.equal(failed.result, "BLOCK");
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.reason, "command_failed");
  for (const name of ["missing", "failed"])
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(reportDir, name + ".json"), "utf8")),
      name === "missing" ? missing : failed);
  const dotnet = await sample(t, ["App.csproj"]);
  const dotnetResult = await verifyProjectQuality(dotnet, path.join(reportDir, "dotnet.json"));
  assert.equal(dotnetResult.stack, "dotnet");
  assert.deepEqual(dotnetResult.command.slice(0,2), ["dotnet", "build"]);
  assert.ok(["PASS", "BLOCK"].includes(dotnetResult.result));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(reportDir, "dotnet.json"), "utf8")), dotnetResult);
});

test("R2: Windows junction or symlink cannot redirect evidence into target project", async (t) => {
  const root = await sample(t, []);
  await fs.writeFile(path.join(root, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }), "utf8");
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "wtb-junction-evidence-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const alias = path.join(outside, "project-alias");
  await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  const before = (await fs.readdir(root)).sort();
  for (const relative of ["qa-evidence.json", path.join("new-folder", "qa-evidence.json")]) {
    await assert.rejects(
      verifyProjectQuality(root, path.join(alias, relative)),
      e => e.code === "QUALITY_EVIDENCE_INSIDE_PROJECT");
    assert.deepEqual((await fs.readdir(root)).sort(), before,
      "a linked evidence directory must not create files or directories in the project");
  }
});

test("R2: evidence path must be outside the target and existing records are never overwritten", async (t) => {
  const root = await sample(t, ["README.md"]);
  await assert.rejects(verifyProjectQuality(root, path.join(root, "quality.json")),
    e => e.code === "QUALITY_EVIDENCE_INSIDE_PROJECT");
  await assert.rejects(verifyProjectQuality(root, "quality.json"),
    e => e.code === "QUALITY_EVIDENCE_PATH_REQUIRED");
  const report = path.join(root + "-quality.json");
  t.after(() => fs.rm(report, { force: true }));
  const first = await verifyProjectQuality(root, report);
  assert.equal(first.result, "BLOCK");
  assert.equal(first.reason, "unsupported");
  const bytes = await fs.readFile(report);
  await assert.rejects(verifyProjectQuality(root, report), e => e.code === "EEXIST");
  assert.deepEqual(await fs.readFile(report), bytes);
});
