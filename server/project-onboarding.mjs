import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskboardError } from "./core/errors.mjs";
import { resolveProjectPath } from "./core/path-safety.mjs";

const KNOWN_MARKERS = {
  node: new Set(["package.json", "pnpm-workspace.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb"]),
  python: new Set(["pyproject.toml", "requirements.txt", "pipfile", "poetry.lock", "uv.lock", "setup.py"]),
};

// Detection is deliberately read-only. Registration, installation and builds belong to other tasks.
export async function detectProjectStack(projectRoot) {
  if (typeof projectRoot !== "string" || !projectRoot.trim() || !path.isAbsolute(projectRoot)) {
    throw new TaskboardError("项目根目录必须是有效绝对路径", {
      code: "PROJECT_ROOT_REQUIRED", status: 400
    });
  }
  let entries;
  try {
    entries = await fs.readdir(projectRoot, { withFileTypes: true });
  } catch (error) {
    throw new TaskboardError("无法读取项目根目录", {
      code: "PROJECT_ROOT_UNAVAILABLE", status: 422, details: { cause: error.code }
    });
  }
  const found = { node: [], python: [], dotnet: [] };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filename = entry.name.toLowerCase();
    for (const [stack, names] of Object.entries(KNOWN_MARKERS)) {
      if (names.has(filename)) found[stack].push(entry.name);
    }
    if (/\.py$/i.test(filename)) found.python.push(entry.name);
    if (/\.(?:csproj|fsproj|vbproj|sln|slnx)$/i.test(filename)) found.dotnet.push(entry.name);
  }
  const matches = Object.entries(found).filter(([, markers]) => markers.length > 0);
  if (matches.length !== 1) {
    return {
      supported: false,
      stack: null,
      reason: matches.length ? "ambiguous" : "unsupported",
      markers: matches.flatMap(([, markers]) => markers).sort()
    };
  }
  return { supported: true, stack: matches[0][0], markers: matches[0][1].sort() };
}

// Link the existing versioned three-role template without replacing project-specific rules.
export async function linkRegisteredProjectWorkflow(projectRegistry, projectId) {
  const project = projectRegistry.get(projectId);
  const root = await fs.realpath(project.root);
  const manifestDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates/software-project-v1");
  const manifest = JSON.parse(await fs.readFile(path.join(manifestDir, "manifest.json"), "utf8"));
  const templateRoot = path.resolve(manifestDir, manifest.source);
  const sources = [];
  for (const relative of manifest.files) {
    const source = await resolveProjectPath(templateRoot, relative, { mustExist: true, rejectReparse: true });
    if (!(await fs.stat(source)).isFile()) throw new TaskboardError("流程模板文件不是普通文件", {
      code: "WORKFLOW_TEMPLATE_INVALID", status: 422, details: { relative }
    });
    sources.push([relative, source]);
  }
  const created = [], preserved = [];
  for (const [relative, source] of sources) {
    let parent = root;
    for (const part of path.dirname(relative).split(/[\\/]+/).filter((value) => value && value !== ".")) {
      const directory = path.join(parent, part);
      try { await fs.mkdir(directory); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      parent = await resolveProjectPath(root, path.relative(root, directory), { mustExist: true, rejectReparse: true });
    }
    const target = await resolveProjectPath(root, relative, { mustExist: false, rejectReparse: true });
    try {
      await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      created.push(relative);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      preserved.push(relative);
    }
  }
  return { projectId, templateVersion: "software-project-v" + manifest.version, created, preserved };
}
