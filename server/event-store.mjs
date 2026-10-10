import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError } from "./core/errors.mjs";
import { sha256, stableEventId } from "./core/hash.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

function validProjectId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new TaskboardError("非法projectId", { code: "INVALID_IDENTIFIER", status: 400 });
}
function dayOf(timestamp) { return new Date(timestamp).toISOString().slice(0, 10); }

export class EventStore {
  constructor(rootDir, { maxSegmentBytes = 1024 * 1024, systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.baseDir = path.join(rootDir, "data", "events");
    this.maxSegmentBytes = maxSegmentBytes;
    this.systemEventLog = systemEventLog;
  }
  async logger() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    return this.systemEventLog;
  }

  async projectDir(projectId) {
    validProjectId(projectId);
    const dir = path.join(this.baseDir, projectId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async sealSegment(segment) {
    const content = await fs.readFile(segment);
    const manifestPath = segment.replace(/\.jsonl$/, ".manifest.json");
    await atomicWriteJson(manifestPath, {
      version: 1,
      segment: path.basename(segment),
      sha256: sha256(content),
      bytes: content.length,
      sealed: true,
      sealedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await fs.chmod(segment, 0o444).catch(async error => {
      await (await this.logger()).error("event-store", "segment_seal_chmod_failed", error, { segment });
    });
  }
  async segmentPath(projectId, timestamp) {
    const dir = await this.projectDir(projectId);
    const day = dayOf(timestamp);
    const entries = (await fs.readdir(dir).catch(async error => {
      await (await this.logger()).error("event-store", "segment_directory_read_failed", error, { project_id: projectId, dir });
      throw error;
    }))
      .filter((name) => name.startsWith(day + "-") && name.endsWith(".jsonl"))
      .sort();
    let index = entries.length ? Number(entries.at(-1).slice(day.length + 1, -6)) : 1;
    if (!Number.isInteger(index) || index < 1) index = 1;
    let target = path.join(dir, `${day}-${String(index).padStart(3, "0")}.jsonl`);
    const stat = await fs.stat(target).catch((error) => {
      if (error?.code === "ENOENT") return null; // LOG-IGNORE: a new daily segment is expected not to exist yet.
      throw error;
    });
    if (stat && stat.size >= this.maxSegmentBytes) {
      await this.sealSegment(target);
      index += 1;
      target = path.join(dir, `${day}-${String(index).padStart(3, "0")}.jsonl`);
    }
    return target;
  }

  async findByOperationId(projectId, operationId) {
    const dir = await this.projectDir(projectId);
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
    for (const name of files) {
      const lines = (await fs.readFile(path.join(dir, name), "utf8")).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); }
        catch (error) {
          await (await this.logger()).error("event-store", "event_json_invalid", error, { project_id: projectId, segment: name, operation_id: operationId });
          continue;
        }
        if (event.operation_id === operationId) return event;
      }
    }
    return null;
  }

  async append(projectId, event) {
    const existing = await this.findByOperationId(projectId, event.operation_id);
    if (existing) return { event: existing, duplicate: true };
    const normalized = {
      ...event,
      event_id: event.event_id || stableEventId(event.operation_id),
      timestamp: new Date(event.timestamp || Date.now()).toISOString(),
    };
    const segment = await this.segmentPath(projectId, normalized.timestamp);
    const handle = await fs.open(segment, "a");
    try {
      await handle.writeFile(JSON.stringify(normalized) + "\n", "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    const content = await fs.readFile(segment);
    const manifestPath = segment.replace(/\.jsonl$/, ".manifest.json");
    await atomicWriteJson(manifestPath, {
      version: 1,
      segment: path.basename(segment),
      sha256: sha256(content),
      bytes: content.length,
      sealed: false,
      updatedAt: new Date().toISOString(),
    });
    return { event: normalized, duplicate: false, segment };
  }

  async listTaskEvents(projectId, taskId, { limit = 200 } = {}) {
    const dir = await this.projectDir(projectId);
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
    const events = [];
    for (const name of files) {
      const lines = (await fs.readFile(path.join(dir, name), "utf8")).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); }
        catch (error) {
          await (await this.logger()).error("event-store", "event_json_invalid", error, { project_id: projectId, segment: name, task_id: taskId || null });
          continue;
        }
        if (!taskId || event.task_id === taskId) events.push(event);
      }
    }
    events.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return events.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)));
  }
  async verifyProject(projectId) {
    const dir = await this.projectDir(projectId);
    const files = (await fs.readdir(dir)).filter((n) => n.endsWith(".jsonl")).sort();
    const issues = [];
    let events = 0;
    const operationIds = new Set();
    for (const name of files) {
      const full = path.join(dir, name);
      const content = await fs.readFile(full);
      const manifestPath = full.replace(/\.jsonl$/, ".manifest.json");
      let manifest = {};
      try { manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
      catch (error) {
        await (await this.logger()).error("event-store", "manifest_read_failed", error, { project_id: projectId, segment: name, manifest: path.basename(manifestPath) });
      }
      if (manifest.sha256 && manifest.sha256 !== sha256(content)) issues.push({ segment: name, code: "CHECKSUM_MISMATCH" });
      const lines = content.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        try {
          const event = JSON.parse(lines[i]); events += 1;
          if (!event.operation_id) issues.push({ segment: name, line: i + 1, code: "MISSING_OPERATION_ID" });
          else if (operationIds.has(event.operation_id)) issues.push({ segment: name, line: i + 1, code: "DUPLICATE_OPERATION_ID" });
          else operationIds.add(event.operation_id);
        } catch (error) {
          issues.push({ segment: name, line: i + 1, code: "INVALID_JSON" });
          await (await this.logger()).error("event-store", "verify_event_json_invalid", error, { project_id: projectId, segment: name, line: i + 1 });
        }
      }
    }
    return { projectId, events, segments: files.length, ok: issues.length === 0, issues };
  }
}

