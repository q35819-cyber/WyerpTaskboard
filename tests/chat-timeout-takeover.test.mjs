import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("timeout recovery uses configured retry limit and then role-session replacement", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const executor = await fs.readFile(path.join(root, "server", "chatgpt-mcp-executor.mjs"), "utf8");

  assert.match(content, /settings\.timeout_retry_limit/);
  assert.match(content, /retry_recovery_exhausted/);
  assert.match(executor, /timeout_takeover_authorized=1/);
  assert.match(background, /replace_role_session/);
  assert.match(background, /delete roleSessions\[msg\.role\]/);
  assert.match(background, /recovery_after_timeout = true/);
});

test("anomaly circuit breaker thresholds are bounded", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.match(background, /runtimeSettings\.anomaly_window_minutes/);
  assert.match(background, /runtimeSettings\.anomaly_limit/);
  assert.match(background, /runtimeSettings\.role_switch_limit/);
  assert.match(background, /wakeHealth\.events\.length >= Math\.max/);
  assert.match(background, /role_switches\?\.\[role\].*runtimeSettings\.role_switch_limit/s);
});

test("successful role execution clears consecutive session-switch counter", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.match(background, /wakeHealth\.role_switches\[msg\.role\] = 0/);
  assert.match(background, /wakeHealth\.circuit_open = false/);
});
