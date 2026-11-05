import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectProjectStack, linkRegisteredProjectWorkflow } from "../server/project-onboarding.mjs";

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
