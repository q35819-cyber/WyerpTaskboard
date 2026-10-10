import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SystemEventLog } from "../server/system-event-log.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-system-log-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  await fs.writeFile(path.join(root, "config", "system-event-log.json"), JSON.stringify({
    version: 1, enabled: true, retention_days: 30, max_event_bytes: 8192
  }));
  return root;
}

test("system event log writes daily JSONL and redacts secrets", async (t) => {
  const root = await fixture(t);
  const clock = () => Date.parse("2026-09-30T12:34:56Z");
  const log = await new SystemEventLog(root, { clock, stderr: () => {} }).init();
  const result = await log.append({
    level: "error",
    component: "windows-mcp",
    event: "tool_failed",
    trace_id: "trace-1",
    error_message: 'request failed token=abc123 Authorization: Bearer deadbeef {"password":"secret"}',
    details: { token: "top-secret", cookie: "x", safe: "visible" }
  });
  assert.equal(result.ok, true);
  const file = path.join(root, "data", "runtime", "system-events", "2026-09-30.jsonl");
  const row = JSON.parse((await fs.readFile(file, "utf8")).trim());
  assert.equal(row.at, "2026-09-30T12:34:56.000Z");
  assert.equal(row.service_version, "9.9.9");
  assert.equal(row.details.token, "[REDACTED]");
  assert.equal(row.details.cookie, "[REDACTED]");
  assert.equal(row.details.safe, "visible");
  assert.doesNotMatch(row.error_message, /abc123|deadbeef|"secret"/);
  assert.match(row.error_message, /\[REDACTED\]/);
});

test("system event log serializes errors and can query recent events", async (t) => {
  const root = await fixture(t);
  const log = await new SystemEventLog(root, { stderr: () => {} }).init();
  const error = Object.assign(new Error("boom"), { code: "E_BOOM" });
  await log.error("service", "uncaught_exception", error, { phase: "runtime" });
  const rows = await log.recent({ component: "service", limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, "error");
  assert.equal(rows[0].error_code, "E_BOOM");
  assert.equal(rows[0].error_message, "boom");
});

test("system event log write failure is fail-soft", async (t) => {
  const root = await fixture(t);
  const messages = [];
  const log = await new SystemEventLog(root, { stderr: (...args) => messages.push(args.join(" ")) }).init();
  log.pathFor = () => path.join(root, "missing-parent", "blocked.jsonl");
  const result = await log.append({ component: "test", event: "write_failure" });
  assert.equal(result.ok, false);
  assert.ok(messages.some(line => line.includes("write failed")));
});
