import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError } from "./errors.mjs";
import { sha256 } from "./hash.mjs";

export async function atomicWriteText(filePath, text, expectedSha256) {
  const current = await fs.readFile(filePath, "utf8");
  const currentSha = sha256(current);
  if (expectedSha256 && currentSha !== expectedSha256) {
    throw new TaskboardError("文件版本已变化，拒绝覆盖", {
      code: "REVISION_CONFLICT", status: 409,
      details: { expectedSha256, actualSha256: currentSha },
    });
  }
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.taskboard-${process.pid}-${Date.now()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, filePath);
  } finally {
    if (handle) await handle.close().catch(() => { /* LOG-IGNORE: best-effort cleanup after primary atomic-write outcome. */ });
    await fs.rm(temp, { force: true }).catch(() => { /* LOG-IGNORE: best-effort temp cleanup; primary write result remains authoritative. */ });
  }
  return { beforeSha256: currentSha, afterSha256: sha256(text) };
}

export async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify(value, null, 2) + "\n";
  let handle;
  try {
    handle = await fs.open(temp, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, filePath);
  } finally {
    if (handle) await handle.close().catch(() => { /* LOG-IGNORE: best-effort cleanup after primary atomic-write outcome. */ });
    await fs.rm(temp, { force: true }).catch(() => { /* LOG-IGNORE: best-effort temp cleanup; primary write result remains authoritative. */ });
  }
}
