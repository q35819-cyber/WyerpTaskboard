import fs from "node:fs/promises";
import path from "node:path";

const LEVELS = new Set(["info", "warning", "error", "critical"]);
const SENSITIVE_KEY = /(token|authorization|cookie|csrf|secret|password|admin[_-]?secret|api[_-]?key|session[_-]?secret)/i;

function iso(value = Date.now()) { return new Date(value).toISOString(); }
function day(value = Date.now()) { return iso(value).slice(0, 10); }
function redactText(value) {
  return String(value ?? "")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/([?&\s](?:token|authorization|cookie|csrf|secret|password|api[_-]?key|admin[_-]?secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:token|authorization|cookie|csrf|secret|password|api[_-]?key|admin[_-]?secret)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
}
function text(value, max = 4000) {
  const out = redactText(value);
  return out.length > max ? out.slice(0, max) + "…[truncated]" : out;
}
function sanitize(value, depth = 0) {
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return text(value);
  if (value instanceof Error) {
    return {
      name: text(value.name, 120),
      code: value.code ? text(value.code, 200) : null,
      message: text(value.message, 1200),
      stack: value.stack ? text(value.stack, 5000) : null
    };
  }
  if (depth >= 6) return "[max_depth]";
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 120)) {
      out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
    }
    return out;
  }
  return text(value);
}
function errorFields(error) {
  if (!error) return {};
  return {
    error_code: error.code ? text(error.code, 200) : null,
    error_message: text(error.message || error, 1200),
    error_stack: error.stack ? text(error.stack, 5000) : null
  };
}

export class SystemEventLog {
  constructor(rootDir, { clock = () => Date.now(), stderr = console.error } = {}) {
    this.rootDir = rootDir;
    this.clock = clock;
    this.stderr = stderr;
    this.dir = path.join(rootDir, "data", "runtime", "system-events");
    this.configPath = path.join(rootDir, "config", "system-event-log.json");
    this.packagePath = path.join(rootDir, "package.json");
    this.config = { version: 1, enabled: true, retention_days: 30, max_event_bytes: 32768 };
    this.serviceVersion = null;
    this.ready = false;
  }

  async init() {
    if (this.ready) return this;
    await fs.mkdir(this.dir, { recursive: true });
    try {
      this.config = { ...this.config, ...JSON.parse(await fs.readFile(this.configPath, "utf8")) };
    } catch (error) {
      if (error.code !== "ENOENT") this.stderr?.("system-event-log config read failed:", error?.message || error);
    }
    try {
      this.serviceVersion = String(JSON.parse(await fs.readFile(this.packagePath, "utf8")).version || "") || null;
    } catch (error) {
      this.stderr?.("system-event-log package version read failed:", error?.message || error);
    }
    this.ready = true;
    await this.prune().catch(error => this.stderr?.("system-event-log prune failed:", error?.message || error));
    return this;
  }

  pathFor(timestamp = this.clock()) {
    return path.join(this.dir, day(timestamp) + ".jsonl");
  }

  async prune() {
    const keepDays = Math.max(1, Number(this.config.retention_days || 30));
    const cutoff = this.clock() - keepDays * 86400_000;
    const names = await fs.readdir(this.dir).catch((error) => {
      this.stderr?.("system-event-log prune directory read failed:", error?.message || error);
      return []; // LOG-IGNORE: logger cannot recursively log its own directory-read failure.
    });
    for (const name of names) {
      const match = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      const at = Date.parse(match[1] + "T00:00:00Z");
      if (Number.isFinite(at) && at < cutoff) await fs.rm(path.join(this.dir, name), { force: true }).catch((error) => {
        this.stderr?.("system-event-log prune delete failed:", error?.message || error); // LOG-IGNORE: logger self-maintenance fallback.
      });
    }
  }

  normalize(event = {}) {
    const atMs = event.at ? Date.parse(event.at) : this.clock();
    const normalized = sanitize({
      at: iso(Number.isFinite(atMs) ? atMs : this.clock()),
      level: LEVELS.has(event.level) ? event.level : "info",
      component: text(event.component || "unknown", 120),
      event: text(event.event || "event", 160),
      trace_id: event.trace_id || null,
      action_fingerprint: event.action_fingerprint || null,
      project_id: event.project_id || null,
      task_id: event.task_id || null,
      detection_id: event.detection_id || null,
      operation: event.operation || null,
      stage: event.stage || null,
      result: event.result || null,
      error_source: event.error_source || null,
      error_code: event.error_code || null,
      error_message: event.error_message || null,
      service_version: event.service_version || this.serviceVersion,
      extension_version: event.extension_version || null,
      pid: event.pid ?? process.pid,
      details: event.details ?? null
    });
    const maxBytes = Math.max(4096, Number(this.config.max_event_bytes || 32768));
    let encoded = JSON.stringify(normalized);
    if (Buffer.byteLength(encoded) > maxBytes) {
      const originalBytes = Buffer.byteLength(encoded);
      normalized.details = { truncated: true, original_bytes: originalBytes };
      if (normalized.error_message) normalized.error_message = text(normalized.error_message, 800);
      encoded = JSON.stringify(normalized);
    }
    return { normalized, encoded };
  }

  async append(event = {}) {
    await this.init();
    if (this.config.enabled === false) return { ok: false, disabled: true };
    const { normalized, encoded } = this.normalize(event);
    try {
      await fs.appendFile(this.pathFor(normalized.at), encoded + "\n", "utf8");
      return { ok: true, event: normalized, path: this.pathFor(normalized.at) };
    } catch (error) {
      this.stderr?.("system-event-log write failed:", error?.message || error);
      return { ok: false, error: String(error?.message || error).slice(0, 500) };
    }
  }

  async error(component, event, error, details = {}) {
    return this.append({
      level: "error",
      component,
      event,
      ...errorFields(error),
      details
    });
  }

  async recent({ limit = 200, component = null, level = null } = {}) {
    await this.init();
    const names = (await fs.readdir(this.dir).catch((error) => {
      this.stderr?.("system-event-log recent directory read failed:", error?.message || error);
      return []; // LOG-IGNORE: query fails soft because the logger cannot log recursively.
    }))
      .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse();
    const out = [];
    for (const name of names) {
      const lines = (await fs.readFile(path.join(this.dir, name), "utf8").catch((error) => {
        this.stderr?.("system-event-log recent file read failed:", error?.message || error);
        return ""; // LOG-IGNORE: a single unreadable segment must not break querying other segments.
      }))
        .split(/\r?\n/).filter(Boolean).reverse();
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); }
        catch (error) {
          this.stderr?.("system-event-log corrupt line skipped:", error?.message || error); // LOG-IGNORE: corrupt row is isolated; remaining rows are still queryable.
          continue;
        }
        if (component && item.component !== component) continue;
        if (level && item.level !== level) continue;
        out.push(item);
        if (out.length >= Math.max(1, Math.min(2000, Number(limit) || 200))) return out;
      }
    }
    return out;
  }
}

export function systemErrorFields(error) { return errorFields(error); }
export function sanitizeSystemLogValue(value) { return sanitize(value); }
