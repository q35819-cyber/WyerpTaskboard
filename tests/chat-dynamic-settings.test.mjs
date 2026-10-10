import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("content script loads AI execution settings for every routed candidate", async () => {
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  const executor = await fs.readFile(path.join(root, "server", "chatgpt-mcp-executor.mjs"), "utf8");
  assert.match(content, /async function loadExecutionSettings/);
  assert.match(content, /\/settings\?token=/);
  assert.match(content, /settings\.max_requests_per_chat/);
  assert.match(content, /settings\.timeout_retry_limit/);
  assert.match(executor, /required_model=/);
  assert.match(executor, /required_reasoning_effort=/);
  assert.match(executor, /execution_settings\.max_requests_per_chat/);
  assert.match(executor, /execution_settings\.context_warning_at/);
});

test("background routes chat reuse and anomaly thresholds from candidate settings", async () => {
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.match(background, /routeForRole\(role, sessions = \{\}, settings = \{\}\)/);
  assert.match(background, /settings\.max_requests_per_chat/);
  assert.match(background, /settings\.context_warning_at/);
  assert.match(background, /runtimeSettings\.anomaly_window_minutes/);
  assert.match(background, /runtimeSettings\.anomaly_limit/);
  assert.match(background, /runtimeSettings\.role_switch_limit/);
  assert.match(background, /execution_settings: runtimeSettings/);
});
