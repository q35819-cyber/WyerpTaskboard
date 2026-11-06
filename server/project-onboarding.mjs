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

const QUALITY_TIMEOUT_MS = 60_000;
const QUALITY_OUTPUT_LIMIT = 4_000;

// Caller supplies an evidence path outside the scanned project; the scanned project is never written by onboarding.
export async function verifyProjectQuality(projectRoot, evidencePath) {
  if (typeof evidencePath !== "string" || !path.isAbsolute(evidencePath)) {
    throw new TaskboardError("必须提供项目外部的绝对证据文件路径", {
      code: "QUALITY_EVIDENCE_PATH_REQUIRED", status: 400
    });
  }
  const detected = await detectProjectStack(projectRoot);
  const root = await fs.realpath(projectRoot);
  const target = path.resolve(evidencePath);
  const inside = (base, location) => {
    const relative = path.relative(base, location);
    return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  const assertExternal = (location) => {
    if (inside(path.resolve(projectRoot), location) || inside(root, location)) {
      throw new TaskboardError("质量验证证据不能写入目标项目", {
        code: "QUALITY_EVIDENCE_INSIDE_PROJECT", status: 400
      });
    }
  };
  assertExternal(target);
  // Resolve the nearest existing ancestor before mkdir: a junction may lead back inside the project.
  let ancestor = path.dirname(target);
  for (;;) {
    try {
      assertExternal(await fs.realpath(ancestor));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  let command = null;
  let reason = detected.supported ? "command_missing" : detected.reason;
  if (detected.stack === "node") {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      const script = ["test", "build"].find((name) =>
        typeof manifest.scripts?.[name] === "string" && manifest.scripts[name].trim());
      if (script) {
        command = [process.platform === "win32" ? "npm.cmd" : "npm", "--ignore-scripts",
          ...(script === "test" ? ["test"] : ["run", "build"])];
      }
    } catch (error) {
      reason = error.code === "ENOENT" ? "command_missing" : "invalid_manifest";
    }
  } else if (detected.stack === "python") {
    for (const folder of ["tests", "."]) {
      const entries = await fs.readdir(path.join(root, folder), { withFileTypes: true })
        .catch((error) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
      if (entries.some((entry) => entry.isFile() && /^test.*\.py$/i.test(entry.name))) {
        command = ["python", "-B", "-m", "unittest", "discover", "-s", folder, "-p", "test*.py"];
        break;
      }
    }
  } else if (detected.stack === "dotnet") {
    const solutions = detected.markers.filter((file) => /\.slnx?$/i.test(file));
    const projects = detected.markers.filter((file) => /\.(?:csproj|fsproj|vbproj)$/i.test(file));
    const target = solutions[0] || (projects.length === 1 ? projects[0] : null);
    if (target) command = ["dotnet", "build", target, "--no-restore", "--nologo"];
    else if (projects.length > 1) reason = "ambiguous_target";
  }
  const evidence = {
    result: "BLOCK", stack: detected.stack, command,
    exitCode: null, reason, stdout: "", stderr: "",
    checkedAt: new Date().toISOString()
  };
  if (command) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const shellCommand = command[0] === "npm.cmd";
      const executable = shellCommand ? "cmd.exe" : command[0];
      const args = shellCommand
        ? ["/d", "/s", "/c", command.join(" ")] : command.slice(1);
      const { stdout, stderr } = await promisify(execFile)(executable, args, {
        cwd: root, windowsHide: true,
        timeout: QUALITY_TIMEOUT_MS, maxBuffer: 512 * 1024
      });
      evidence.stdout = String(stdout).slice(-QUALITY_OUTPUT_LIMIT);
      evidence.stderr = String(stderr).slice(-QUALITY_OUTPUT_LIMIT);
      evidence.exitCode = 0;
      const tests = detected.stack === "python"
        ? /Ran (\d+) tests?/.exec(String(stdout) + String(stderr)) : null;
      if (detected.stack !== "python" || Number(tests?.[1]) > 0) {
        evidence.result = "PASS";
        evidence.reason = null;
      } else {
        evidence.reason = "no_tests_executed";
      }
    } catch (error) {
      evidence.exitCode = typeof error.code === "number" ? error.code : null;
      evidence.reason = error.killed ? "timeout" : error.code === "ENOENT"
        ? "command_unavailable" : "command_failed";
      evidence.stdout = String(error.stdout || "").slice(-QUALITY_OUTPUT_LIMIT);
      evidence.stderr = String(error.stderr || error.message || "").slice(-QUALITY_OUTPUT_LIMIT);
    }
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  assertExternal(await fs.realpath(path.dirname(target)));
  await fs.writeFile(target, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
  return evidence;
}
