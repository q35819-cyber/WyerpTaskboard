import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError } from "./core/errors.mjs";

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
