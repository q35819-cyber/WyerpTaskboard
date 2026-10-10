import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError, invariant } from "./errors.mjs";

const IS_WINDOWS = process.platform === "win32";

function comparable(p) {
  const resolved = path.resolve(p);
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

export function assertSafeRelativePath(relativePath) {
  invariant(typeof relativePath === "string" && relativePath.trim(), "项目相对路径不能为空", {
    code: "INVALID_PROJECT_PATH", status: 400,
  });
  invariant(!path.isAbsolute(relativePath), "项目文件路径必须是相对路径", {
    code: "ABSOLUTE_PATH_REJECTED", status: 400, details: { relativePath },
  });
  const normalized = path.normalize(relativePath);
  const parts = normalized.split(/[\\/]+/);
  invariant(!parts.includes(".."), "项目文件路径不能包含 ..", {
    code: "PATH_TRAVERSAL_REJECTED", status: 400, details: { relativePath },
  });
  return normalized;
}

export function isWithinRoot(rootRealPath, targetRealPath) {
  const root = comparable(rootRealPath);
  const target = comparable(targetRealPath);
  return target === root || target.startsWith(root + path.sep);
}

async function rejectSymlinkSegments(rootRealPath, targetRealPath) {
  const relative = path.relative(rootRealPath, targetRealPath);
  if (!relative || relative === ".") return;
  let current = rootRealPath;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new TaskboardError("项目路径包含符号链接/junction/reparse入口，拒绝访问", {
        code: "REPARSE_POINT_REJECTED", status: 403, details: { path: current },
      });
    }
  }
}

export async function resolveProjectRoot(root) {
  try {
    const real = await fs.realpath(root);
    const stat = await fs.stat(real);
    invariant(stat.isDirectory(), "项目root不是目录", {
      code: "PROJECT_ROOT_INVALID", status: 503, details: { root },
    });
    return real;
  } catch (error) {
    if (error instanceof TaskboardError) throw error;
    throw new TaskboardError("项目root不可访问", {
      code: "SOURCE_UNAVAILABLE", status: 503,
      details: { root, cause: error.code || error.message },
    });
  }
}

export async function resolveProjectPath(rootRealPath, relativePath, { mustExist = true, rejectReparse = true } = {}) {
  const safeRelative = assertSafeRelativePath(relativePath);
  const candidate = path.resolve(rootRealPath, safeRelative);
  invariant(isWithinRoot(rootRealPath, candidate), "项目路径越界", {
    code: "PROJECT_ROOT_ESCAPE", status: 403, details: { relativePath },
  });

  if (!mustExist) {
    const parent = await fs.realpath(path.dirname(candidate));
    invariant(isWithinRoot(rootRealPath, parent), "目标父目录真实路径越界", {
      code: "PROJECT_ROOT_ESCAPE", status: 403, details: { relativePath },
    });
    if (rejectReparse) await rejectSymlinkSegments(rootRealPath, parent);
    return path.join(parent, path.basename(candidate));
  }

  let real;
  try {
    real = await fs.realpath(candidate);
  } catch (error) {
    throw new TaskboardError("项目源文件不可访问", {
      code: "SOURCE_UNAVAILABLE", status: 503,
      details: { relativePath, cause: error.code || error.message },
    });
  }
  invariant(isWithinRoot(rootRealPath, real), "真实路径逃逸项目root", {
    code: "PROJECT_ROOT_ESCAPE", status: 403, details: { relativePath, real },
  });
  if (rejectReparse) await rejectSymlinkSegments(rootRealPath, real);
  return real;
}
