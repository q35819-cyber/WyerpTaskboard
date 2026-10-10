import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatBrowserWake } from "../server/chat-browser-wake.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-chat-wake-stability-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "runtime", "task-scan"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "test" }), "utf8");
  await fs.writeFile(path.join(root, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1,
    enabled: true,
    token: "x".repeat(64),
    lease_ms: 30000,
    expected_extension_version: "0.6.27"
  }), "utf8");
  return root;
}

test("Chat Wake state writes are serialized and remain valid under concurrent writes", async (t) => {
  const root = await fixture(t);
  const wake = await new ChatBrowserWake(root).init();
  await Promise.all(Array.from({ length: 40 }, (_, index) => wake.writeState({
    version: 1,
    leases: {},
    acked: {},
    dispatcher: { client_id: "client", dispatcher_epoch: 1, sequence: index }
  })));
  const finalText = await fs.readFile(path.join(root, "data", "runtime", "task-scan", "chat-browser-wake.json"), "utf8");
  const finalState = JSON.parse(finalText);
  assert.equal(finalState.dispatcher.sequence, 39);
});

test("Chat Wake Windows state writes retry transient rename failures with unique temp names", async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, "../server/chat-browser-wake.mjs"), "utf8");
  assert.match(source, /stateWriteChain/);
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /EPERM/);
  assert.match(source, /EACCES/);
  assert.match(source, /EBUSY/);
  assert.match(source, /state_write_retry/);
});

test("extension bootstraps monitoring content without a second visible status console", async () => {
  const background = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/background.js"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/manifest.json"), "utf8"));
  assert.match(background, /chrome\.tabs\.query\(\{ url: "https:\/\/chatgpt\.com\/\*" \}\)/);
  assert.match(background, /files:\s*\["config\.js", "content\.js"\]/);
  assert.doesNotMatch(background, /files:\s*\[[^\]]*"global-overlay\.js"/);
  assert.equal(manifest.content_scripts.some(entry => entry.js?.includes("global-overlay.js")), false);
  assert.match(background, /bootstrapExistingChatTabs/);
});


test("extension routes GPT mutations only through the local MCP executor and limits overlay injection to ChatGPT", async () => {
  const background = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/background.js"), "utf8");
  const content = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/content.js"), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/manifest.json"), "utf8"));
  assert.match(background, /\/mcp-action\?token=/);
  assert.match(content, /\/mcp-action\?token=/);
  assert.doesNotMatch(background, /chrome\.tabs\.update\(/);
  assert.doesNotMatch(content, /\.click\(\)/);
  assert.equal(manifest.content_scripts.some(entry => entry.js?.includes("global-overlay.js")), false);
});

test("content reinjection retires the previous runtime generation and ignores page-owned errors", async () => {
  const content = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/content.js"), "utf8");
  assert.match(content, /__WYERP_CHAT_WAKE_CONTENT_INSTANCE__/);
  assert.match(content, /previousRuntimeInstance\?\.retire/);
  assert.match(content, /retireContentRuntime/);
  assert.match(content, /removeListener\(onRuntimeMessage\)/);
  assert.match(content, /window\.error also receives ChatGPT page errors/);
  assert.match(content, /source\.startsWith\(extensionOrigin\)/);
  assert.doesNotMatch(content, /__WYERP_CHAT_WAKE_CONTENT_ACTIVE__ === extensionVersion\) return/);
});


test("content runtime retires itself on extension context invalidation and candidate ids use a defined guard", async () => {
  const content = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/content.js"), "utf8");
  assert.match(content, /const ref = \/\^\[A-Za-z0-9\._:\/-\]\{1,160\}\$\//);
  assert.match(content, /isContextInvalidated/);
  assert.match(content, /retireContentRuntime\("extension_context_invalidated"\)/);
  assert.match(content, /while \(!contentRetired && Date\.now\(\) - started < timeoutMs\)/);
  assert.match(content, /contentRetired \? "content_runtime_retired"/);
});


test("global overlay retires stale content-script polling after extension context invalidation", async () => {
  const overlay = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/global-overlay.js"), "utf8");
  assert.match(overlay, /isContextInvalidated/);
  assert.match(overlay, /clearInterval\(pollTimer\)/);
  assert.match(overlay, /host\.remove\(\)/);
  assert.match(overlay, /if \(isContextInvalidated\(error\)\)/);
  assert.match(overlay, /if \(isContextInvalidated\(logError\)\)/);
  assert.match(overlay, /await runtime\.sendMessage\(\{[\s\S]*WYERP_EXTENSION_LOG_EVENT/);
  assert.doesNotMatch(overlay, /void runtime\.sendMessage\(\{[\s\S]{0,500}WYERP_EXTENSION_LOG_EVENT/);
  assert.doesNotMatch(overlay, /console\.warn\("Wyerp overlay retired after extension context invalidation/);
});

test("SSE failures back off and HTTP errors do not write a second response after headers", async () => {
  const content = await fs.readFile(path.resolve(import.meta.dirname, "../browser-extension/chat-wake/content.js"), "utf8");
  const server = await fs.readFile(path.resolve(import.meta.dirname, "../server/http-server.mjs"), "utf8");
  assert.match(content, /retry_delay_ms:\s*30000/);
  assert.match(content, /now - sseErrorReportedAt >= 60_000/);
  assert.match(server, /res\.headersSent \|\| res\.writableEnded/);
  assert.match(server, /request_failed_after_headers/);
  assert.match(server, /chat-wake-sse/);
  assert.match(server, /clearInterval\(timer\)/);
});

test("disabled or outdated Chat Wake streams retire old content scripts instead of reconnect-looping", async () => {
  const server = await fs.readFile(path.resolve(import.meta.dirname, "../server/http-server.mjs"), "utf8");
  assert.match(server, /disabled_stream_retired/);
  assert.match(server, /outdated_stream_retired/);
  assert.match(server, /state: "chat_wake_disabled"/);
  assert.match(server, /state: "extension_outdated"/);
  assert.match(server, /event: superseded/);
});
