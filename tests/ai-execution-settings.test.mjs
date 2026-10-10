import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AiExecutionSettingsStore,
  DEFAULT_AI_EXECUTION_SETTINGS,
  normalizeAiExecutionSettings
} from "../server/ai-execution-settings.mjs";

test("AI execution settings initialize with safe defaults", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-ai-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new AiExecutionSettingsStore(root).init();
  const settings = await store.get();
  assert.equal(settings.developer.model, "GPT-5.6 Sol");
  assert.equal(settings.developer.reasoning_effort, "high");
  assert.equal(settings.test.model, "GPT-5.6 Sol");
  assert.equal(settings.scan_interval_minutes, 10);
  assert.equal(settings.max_requests_per_chat, 20);
  assert.equal(settings.context_warning_at, 15);
  assert.equal(settings.timeout_retry_limit, 3);
});

test("AI execution settings persist configurable values without scheduler side effects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-ai-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new AiExecutionSettingsStore(root).init();
  const value = {
    ...DEFAULT_AI_EXECUTION_SETTINGS,
    developer: { model: "GPT-5.6 Sol", reasoning_effort: "medium" },
    test: { model: "GPT-5.6 Pro", reasoning_effort: "extra_high" },
    scan_interval_minutes: 7,
    max_requests_per_chat: 30,
    context_warning_at: 22,
    timeout_retry_limit: 4,
    anomaly_window_minutes: 15,
    anomaly_limit: 8,
    role_switch_limit: 4
  };
  const result = await store.save(value, { applyScheduler: false });
  assert.equal(result.scheduler.applied, false);
  assert.deepEqual(await store.get(), value);
  assert.equal(store.forChatWake(value).max_requests_per_chat, 30);
  assert.equal(store.forChatWake(value).test.reasoning_effort, "extra_high");
});

test("scan status UI renders current execution settings instead of fixed 10/20 values", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const app = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.match(app, /executionSettings\?\.scan_interval_minutes/);
  assert.match(app, /executionSettings\?\.max_requests_per_chat/);
  assert.match(app, /每聊天最多"\+maxRequestsPerChat\+"次/);
  assert.doesNotMatch(app, /每聊天最多20次/);
  assert.match(app, /schedulerOutOfSync/);
});

test("AI execution settings reject warning threshold above chat maximum", () => {
  assert.throws(
    () => normalizeAiExecutionSettings({ max_requests_per_chat: 10, context_warning_at: 11 }),
    (error) => error.code === "INVALID_AI_EXECUTION_SETTINGS"
  );
});

test("AI execution settings reject unsupported reasoning effort", () => {
  assert.throws(
    () => normalizeAiExecutionSettings({ developer: { model: "GPT-5.6 Sol", reasoning_effort: "banana" } }),
    (error) => error.code === "INVALID_AI_EXECUTION_SETTINGS"
  );
});

test("AI execution settings skip scheduler when interval is unchanged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-ai-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new AiExecutionSettingsStore(root).init();
  let calls = 0;
  store.applyScheduler = async () => { calls += 1; return { applied: true }; };
  const current = await store.get();
  const result = await store.save({
    ...current,
    developer: { ...current.developer, reasoning_effort: "medium" }
  });
  assert.equal(calls, 0);
  assert.equal(result.scheduler.reason, "interval_unchanged");
  assert.equal((await store.get()).developer.reasoning_effort, "medium");
});

test("AI execution settings do not persist new interval when scheduler update fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-ai-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new AiExecutionSettingsStore(root).init();
  store.applyScheduler = async () => { throw new Error("scheduler failed"); };
  const current = await store.get();
  await assert.rejects(() => store.save({ ...current, scan_interval_minutes: 11 }), /scheduler failed/);
  assert.equal((await store.get()).scan_interval_minutes, 10);
});
