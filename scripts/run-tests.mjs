import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SystemEventLog } from "../server/system-event-log.mjs";

const root = path.resolve(import.meta.dirname, "..");
const testsDir = path.join(root, "tests");
const runtimeDir = path.join(root, "data", "runtime", "validation");
const statePath = path.join(runtimeDir, "npm-test.json");
const packageVersion = String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "");
const systemEventLog = await new SystemEventLog(root).init();
const files = fs.readdirSync(testsDir)
  .filter((name) => name.endsWith(".test.mjs") && name !== "erp-x20-integration.test.mjs")
  .sort((a, b) => {
    if (a === "service-control.test.mjs") return 1;
    if (b === "service-control.test.mjs") return -1;
    return a.localeCompare(b);
  });

function tail(text, maxLines = 80) {
  const lines = String(text || "").split(/\r?\n/);
  return lines.slice(-maxLines).join("\n").slice(-12000);
}
function writeState(value) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const tmp = statePath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, statePath);
}

let failed = 0;
const failures = [];
const started = Date.now();
const startedAt = new Date(started).toISOString();
await systemEventLog.append({
  component: "validation",
  event: "npm_test_started",
  operation: "npm test",
  details: { file_count: files.length, package_version: packageVersion }
});
for (const file of files) {
  process.stdout.write("\n=== " + file + " ===\n");
  const result = spawnSync(process.execPath, ["--test", path.join("tests", file)], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: file === "service-control.test.mjs" ? 180000 : 30000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    failed++;
    failures.push({
      file,
      exit_code: result.status,
      error: result.error ? String(result.error.message || result.error) : null,
      stdout_tail: tail(result.stdout),
      stderr_tail: tail(result.stderr)
    });
    await systemEventLog.append({
      level: "error",
      component: "validation",
      event: "test_file_failed",
      operation: file,
      result: "failed",
      error_source: "node_test",
      error_message: result.error ? String(result.error.message || result.error) : "test process exited non-zero",
      details: {
        file,
        exit_code: result.status,
        stdout_tail: tail(result.stdout, 20),
        stderr_tail: tail(result.stderr, 20)
      }
    });
  }
}
const duration = Date.now() - started;
const summary = { files: files.length, failedFiles: failed, durationMs: duration, package_version: packageVersion };
process.stdout.write("\n=== SUMMARY ===\n");
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
writeState({
  version: 1,
  state: failed ? "failed" : "passed",
  started_at: startedAt,
  finished_at: new Date().toISOString(),
  ...summary,
  failures
});
await systemEventLog.append({
  level: failed ? "error" : "info",
  component: "validation",
  event: "npm_test_finished",
  operation: "npm test",
  result: failed ? "failed" : "passed",
  details: { ...summary, failed_files: failures.map(item => item.file) }
});
process.exitCode = failed ? 1 : 0;
