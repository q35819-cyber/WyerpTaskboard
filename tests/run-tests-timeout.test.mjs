import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../scripts/run-tests.mjs", import.meta.url), "utf8");
const expression = source.match(/^\s*timeout:\s*(.*),$/m)?.[1];
assert.ok(expression, "test runner timeout expression must exist");
const timeoutFor = new Function("file", `return (${expression});`);

test("test runner budgets are bounded per file", () => {
  assert.equal(timeoutFor("task-auto-unblock.test.mjs"), 90000);
  for (const file of ["delivery-lifecycle.test.mjs", "delivery-takeover.test.mjs", "task-step-checkpoint.test.mjs"]) {
    assert.equal(timeoutFor(file), 90000);
  }
  assert.equal(timeoutFor("service-control.test.mjs"), 180000);
  assert.equal(timeoutFor("ordinary.test.mjs"), 30000);
});

test("test runner still fails on errors and nonzero exit codes", () => {
  assert.match(source, /if \(result\.error \|\| result\.status !== 0\)/);
  assert.match(source, /process\.exitCode = failed \? 1 : 0/);
});
