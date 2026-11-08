import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";

const source = fs.readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
const expression = source.match(/^\s*timeout:\s*(.*),$/m)?.[1];
assert.ok(expression, "test runner timeout expression must exist");
const timeoutFor = new Function("file", `return (${expression});`);

test("test runner budgets are bounded per file", () => {
  for (const file of ["delivery-lifecycle.test.mjs", "delivery-takeover.test.mjs",
    "task-auto-unblock.test.mjs", "taskctl.test.mjs"]) {
    assert.equal(timeoutFor(file), 90000);
  }
  for (const file of ["service-control.test.mjs", "task-step-checkpoint.test.mjs"])
    assert.equal(timeoutFor(file), 180000);
  assert.equal(timeoutFor("ordinary.test.mjs"), 30000);
  assert.ok([30000, 90000, 180000].every(budget => Number.isFinite(budget) && budget > 0));
});

test("test runner still fails on errors and nonzero exit codes", () => {
  assert.match(source, /if \(result\.error \|\| result\.status !== 0\)/);
  assert.match(source, /process\.exitCode = failed \? 1 : 0/);
});

test("real child timeout and nonzero exit remain failures under the bounded runner", () => {
  const timeout = spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000)"],
    { timeout: 50, encoding: "utf8", windowsHide: true });
  assert.equal(timeout.error?.code, "ETIMEDOUT");
  assert.equal(timeout.status, null);
  const nonzero = spawnSync(process.execPath, ["-e", "process.exit(7)"],
    { timeout: 10000, encoding: "utf8", windowsHide: true });
  assert.equal(nonzero.status, 7);
  assert.equal(nonzero.error, undefined);
  for (const result of [timeout, nonzero])
    assert.equal(Boolean(result.error || result.status !== 0), true);
});
