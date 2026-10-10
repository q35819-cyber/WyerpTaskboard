import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const productionFiles = [
  "server/main.mjs",
  "server/http-server.mjs",
  "server/task-scan-loop.mjs",
  "server/scan-store.mjs",
  "server/windows-mcp-client.mjs",
  "server/chat-browser-wake.mjs",
  "server/chatgpt-health-monitor.mjs",
  "server/chatgpt-mcp-executor.mjs",
  "server/automation-control.mjs",
  "browser-extension/chat-wake/background.js",
  "browser-extension/chat-wake/content.js",
  "scripts/global-status-overlay.ps1"
];

test("critical runtime modules are wired to persistent logging", async () => {
  const content = Object.fromEntries(await Promise.all(productionFiles.map(async file => [
    file,
    await fs.readFile(path.join(root, file), "utf8")
  ])));
  for (const file of [
    "server/main.mjs",
    "server/http-server.mjs",
    "server/task-scan-loop.mjs",
    "server/scan-store.mjs",
    "server/windows-mcp-client.mjs",
    "server/chat-browser-wake.mjs",
    "server/chatgpt-health-monitor.mjs",
    "server/chatgpt-mcp-executor.mjs"
  ]) {
    assert.match(content[file], /SystemEventLog|systemEventLog/, file + " must use unified system logging");
  }
  assert.match(content["browser-extension/chat-wake/background.js"], /reportExtensionEvent/);
  assert.match(content["browser-extension/chat-wake/content.js"], /reportExtensionEvent/);
  assert.match(content["scripts/global-status-overlay.ps1"], /Write-SystemEvent/);
  assert.match(content["scripts/global-status-overlay.ps1"], /overlay-runtime-fallback\.jsonl/);
});

test("critical extension paths do not silently swallow runtime failures", async () => {
  for (const file of [
    "browser-extension/chat-wake/background.js",
    "browser-extension/chat-wake/content.js"
  ]) {
    const text = await fs.readFile(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /\.catch\(\(\)\s*=>\s*\{\s*\}\)/, file);
    assert.doesNotMatch(text, /catch\s*\{\s*\}/, file);
  }
});

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await sourceFiles(full));
      continue;
    }
    if (/\.(?:mjs|js|ps1|vbs)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

test("production source tree contains no unannotated empty catch blocks", async () => {
  const roots = ["server", "cli", "scripts", "browser-extension"];
  const files = (await Promise.all(roots.map(name => sourceFiles(path.join(root, name))))).flat();
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    if (/catch\s*\{\s*\}/.test(text) ||
        /\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/.test(text) ||
        /\.catch\(\s*\(\)\s*=>\s*(?:null|\[\]|\(\s*\{\s*\}\s*\))\s*\)/.test(text)) {
      offenders.push(path.relative(root, file).replaceAll("\\", "/"));
    }
  }
  assert.deepEqual(offenders, []);
});

test("unified system log has a query endpoint and runtime summary", async () => {
  const http = await fs.readFile(path.join(root, "server/http-server.mjs"), "utf8");
  const runtime = await fs.readFile(path.join(root, "server/runtime-status.mjs"), "utf8");
  assert.match(http, /\/api\/runtime\/events/);
  assert.match(runtime, /system_log:/);
  assert.match(runtime, /recent_errors/);
});
