import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./core/hash.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { TaskboardError } from "./core/errors.mjs";

async function walkFiles(root) {
  const out = [];
  async function walk(current, prefix = "") {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) out.push({ full, rel });
    }
  }
  await walk(root);
  return out;
}

function safeLabel(value = "manual") {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "manual";
}

export class GovernanceBackupStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.backupsDir = path.join(rootDir, "data", "backups");
  }

  async create({ label = "manual" } = {}) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(this.backupsDir, stamp + "-" + safeLabel(label));
    await fs.mkdir(backupDir, { recursive: true });

    const sources = [
      { source: path.join(this.rootDir, "config", "projects.json"), target: path.join(backupDir, "config", "projects.json") },
      { source: path.join(this.rootDir, "data", "events"), target: path.join(backupDir, "data", "events"), directory: true },
      { source: path.join(this.rootDir, "data", "requirements"), target: path.join(backupDir, "data", "requirements"), directory: true },
      { source: path.join(this.rootDir, "data", "runtime", "transactions"), target: path.join(backupDir, "data", "runtime", "transactions"), directory: true },
    ];

    for (const item of sources) {
      if (item.directory) {
        await fs.cp(item.source, item.target, { recursive: true, force: false, errorOnExist: false }).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      } else {
        await fs.mkdir(path.dirname(item.target), { recursive: true });
        await fs.copyFile(item.source, item.target);
      }
    }

    const files = await walkFiles(backupDir);
    const manifestFiles = [];
    for (const file of files) {
      if (file.rel === "manifest.json") continue;
      const content = await fs.readFile(file.full);
      manifestFiles.push({ path: file.rel.replaceAll("\\", "/"), bytes: content.length, sha256: sha256(content) });
    }
    manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceRoot: this.rootDir,
      files: manifestFiles,
    };
    await atomicWriteJson(path.join(backupDir, "manifest.json"), manifest);
    return { backupDir, manifest };
  }

  async verify(backupDir) {
    const manifestPath = path.join(backupDir, "manifest.json");
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch (error) {
      throw new TaskboardError("备份manifest不存在或损坏", { code: "BACKUP_MANIFEST_INVALID", status: 422, details: { cause: error.message } });
    }
    const issues = [];
    for (const entry of manifest.files || []) {
      const full = path.resolve(backupDir, entry.path);
      if (!full.startsWith(path.resolve(backupDir) + path.sep)) {
        issues.push({ path: entry.path, code: "PATH_ESCAPE" });
        continue;
      }
      const content = await fs.readFile(full).catch((error) => {
        if (error?.code === "ENOENT") return null; // LOG-IGNORE: missing backup file is reported as MISSING_FILE below.
        throw error;
      });
      if (!content) { issues.push({ path: entry.path, code: "MISSING_FILE" }); continue; }
      if (content.length !== entry.bytes) issues.push({ path: entry.path, code: "SIZE_MISMATCH" });
      if (sha256(content) !== entry.sha256) issues.push({ path: entry.path, code: "CHECKSUM_MISMATCH" });
    }
    return { ok: issues.length === 0, issues, manifest };
  }

  async materializeVerifiedCopy(backupDir, destinationDir) {
    const verification = await this.verify(backupDir);
    if (!verification.ok) {
      throw new TaskboardError("备份校验失败，拒绝生成恢复副本", { code: "BACKUP_VERIFY_FAILED", status: 422, details: verification.issues });
    }
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(destinationDir, { recursive: true });
    for (const entry of verification.manifest.files || []) {
      const source = path.join(backupDir, ...entry.path.split("/"));
      const target = path.join(destinationDir, ...entry.path.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await atomicWriteJson(path.join(destinationDir, "restore-manifest.json"), {
      version: 1,
      restoredFrom: backupDir,
      restoredAt: new Date().toISOString(),
      sourceManifestSha256: sha256(await fs.readFile(path.join(backupDir, "manifest.json"))),
    });
    return { destinationDir, files: verification.manifest.files.length };
  }
}