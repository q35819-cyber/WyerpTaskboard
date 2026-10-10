import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

test("chat monitor delegates human-style recovery actions to the MCP executor", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  const executor = await fs.readFile(path.join(root, "server", "chatgpt-mcp-executor.mjs"), "utf8");
  assert.match(content, /requestMcpAction\("stop_and_continue"/);
  assert.match(content, /requestMcpAction\("retry_or_continue"/);
  assert.match(content, /settings\.timeout_retry_limit/);
  assert.match(content, /processing_delayed_recovery_exhausted/);
  assert.match(content, /retry_recovery_exhausted/);
  assert.match(content, /waitForExecutionStarted/);
  assert.match(content, /WYERP_ROLE_SESSION_BOUND/);
  assert.match(executor, /await this\.sendText\(client, "继续"/);
  assert.match(executor, /retry\|重试\|再试一次\|重新生成\|continue\|继续/i);
  assert.doesNotMatch(content, /\.click\(/);
  assert.doesNotMatch(content, /setComposer\(/);
});
