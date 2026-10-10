import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError } from "./errors.mjs";

export async function withProjectLock(rootDir, projectId, operationId, fn) {
  const dir = path.join(rootDir, "data", "runtime", "locks");
  await fs.mkdir(dir, { recursive: true });
  const lockPath = path.join(dir, `${projectId}.lock`);
  let handle;
  try {
    handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({ projectId, operationId, pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
    await handle.sync();
  } catch (error) {
    if (error.code === "EEXIST") throw new TaskboardError("项目任务注册表正被其它操作占用", {
      code: "PROJECT_LOCKED", status: 423, details: { projectId },
    });
    throw error;
  }
  try { return await fn(); }
  finally {
    await handle.close().catch(() => { /* LOG-IGNORE: lock handle close is best-effort during finally. */ });
    const text = await fs.readFile(lockPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return ""; // LOG-IGNORE: lock may already have been removed by recovery.
      throw error;
    });
    if (text.includes(operationId)) await fs.rm(lockPath, { force: true }).catch(() => { /* LOG-IGNORE: best-effort lock cleanup after ownership check. */ });
  }
}
