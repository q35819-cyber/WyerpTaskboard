import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ChatBrowserWake } from "../server/chat-browser-wake.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("taskboard package and Chat Wake extension expose independent version sources", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), "utf8"));

  assert.ok(String(pkg.version || "").trim());
  assert.ok(String(manifest.version || "").trim());
  // Runtime extension pinning is local configuration; bridge behavior is verified in the fixture below.
});

test("bridge accepts only the extension project's current latest version", async (t) => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), "utf8"));
  const latest = String(manifest.version);
  const stale = latest + "-stale";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-version-contract-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmp, "config"), { recursive: true });
  await fs.writeFile(path.join(tmp, "config", "chat-browser-wake.json"), JSON.stringify({
    version: 1,
    enabled: true,
    token: "v".repeat(64),
    lease_ms: 30000,
    expected_extension_version: latest
  }));
  const wake = await new ChatBrowserWake(tmp).init();
  assert.equal(wake.verifyExtensionVersion(latest), true);
  assert.equal(wake.verifyExtensionVersion(stale), false);
  assert.equal(wake.verifyExtensionVersion(""), false);
});

test("content script performs version handshake before dispatcher registration", async () => {
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "content.js"), "utf8");
  const executor = await fs.readFile(path.join(root, "server", "chatgpt-mcp-executor.mjs"), "utf8");
  assert.match(content, /const runtime = globalThis\.chrome\?\.runtime/);
  assert.match(content, /if \(!runtime\?\.getManifest \|\| !runtime\?\.sendMessage\) return/);
  assert.match(content, /runtime\.getManifest\(\)\.version/);
  assert.match(content, /\/version\?token=/);
  assert.doesNotMatch(content, /body\?\.app_version === extensionVersion/);
  assert.doesNotMatch(content, /expected_extension_version === extensionVersion/);
  assert.match(content, /body\?\.compatible === true/);
  assert.match(content, /body\?\.taskboard_version/);
  assert.match(content, /requestMcpAction\("send_candidate"/);
  assert.match(executor, /"extension_version=" \+ String\(extension_version/);
  assert.match(executor, /"extension_latest_version=" \+ String\(extension_latest_version/);
  assert.match(executor, /"taskboard_version=" \+ String\(taskboard_version/);
  assert.doesNotMatch(content, /"bridge_version=" \+ extensionVersion/);
  assert.doesNotMatch(content, /bridge_version必须与package\.json/);
  const handshake = content.indexOf("verifyBridgeVersion()");
  const register = content.lastIndexOf('WYERP_REGISTER_DISPATCHER');
  assert.ok(handshake >= 0 && register > handshake);
});

test("Chat Wake no longer auto-injects a second visible global status console", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), "utf8"));
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.equal(manifest.content_scripts.some(entry => entry.js?.includes("global-overlay.js")), false);
  assert.doesNotMatch(background, /files:\s*\[[^\]]*"global-overlay\.js"/);
  assert.match(background, /files:\s*\["config\.js", "content\.js"\]/);
});

test("service worker entry has no top-level await", async () => {
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  const topLevelAwait = background.split(/\r?\n/).filter(line => /^await\s/.test(line));
  assert.deepEqual(topLevelAwait, []);
  assert.match(background, /const ready = Promise\.all\(\[restore\(\), restoreHealth\(\), restoreDispatcherEpoch\(\), restoreExecutionCheckpoints\(\)\]\)/);
});

test("classic service worker avoids module registration and import", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "browser-extension", "chat-wake", "manifest.json"), "utf8"));
  const background = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "background.js"), "utf8");
  assert.equal(manifest.background.type, undefined);
  assert.doesNotMatch(background, /^import\s/m);
  assert.doesNotMatch(background, /^await\s/m);
});
