import test from "node:test";
import assert from "node:assert/strict";
import { TaskScanLoop } from "../server/task-scan-loop.mjs";

test("service scan loop performs an initial scan and only scans when scheduler says due", async () => {
  const decisions = [
    { run: false, reason: "not_due", scheduler_mode: "busy_watch" },
    { run: true, reason: "interval_due", scheduler_mode: "idle_hunt" },
  ];
  const calls = [];
  const scanStore = { scheduledDecision: async () => decisions.shift() };
  const scanner = {
    scanOnce: async ({ trigger }) => {
      calls.push(trigger);
      return { state: "completed", trigger };
    },
  };
  let timerFn = null;
  const loop = new TaskScanLoop("x", {
    scanStore,
    scanner,
    setTimer: (fn) => { timerFn = fn; return { unref() {} }; },
    clearTimer: () => {},
  });
  await loop.start();
  assert.deepEqual(calls, ["service_start"]);
  assert.ok(timerFn);
  assert.equal((await loop.tick()).state, "skipped");
  await loop.tick();
  assert.deepEqual(calls, ["service_start", "service_ticker"]);
  loop.stop();
});

test("rearm bypasses interval and is labeled service_rearm", async () => {
  const calls = [];
  const loop = new TaskScanLoop("x", {
    scanStore: {
      scheduledDecision: async () => ({ run: true, reason: "rearm", scheduler_mode: "idle_hunt" }),
    },
    scanner: {
      scanOnce: async ({ trigger }) => { calls.push(trigger); return { state: "completed" }; },
    },
  });
  await loop.tick();
  assert.deepEqual(calls, ["service_rearm"]);
});
