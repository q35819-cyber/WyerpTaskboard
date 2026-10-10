import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("CLI supports delayed start-or-restart for self service control", async () => {
  const cli = await fs.readFile(path.join(root, "cli", "service.mjs"), "utf8");
  assert.match(cli, /WYERP_SERVICE_ACTION_DELAY_MS/);
  assert.match(cli, /action === "start-or-restart"/);
  assert.match(cli, /await controller\.stop\(\)/);
  assert.match(cli, /await controller\.start\(\)/);
});

test("HTTP self-control launches a detached hidden controller and returns safe status", async () => {
  const http = await fs.readFile(path.join(root, "server", "http-server.mjs"), "utf8");
  assert.match(http, /launchDetachedServiceAction/);
  assert.match(http, /detached: true/);
  assert.match(http, /windowsHide: true/);
  assert.match(http, /\/service\/start-or-restart/);
  assert.match(http, /\/service\/stop/);
  assert.match(http, /function safeServiceStatus/);
  const safeBlock = http.slice(http.indexOf("function safeServiceStatus"), http.indexOf("function launchDetachedServiceAction"));
  assert.doesNotMatch(safeBlock, /instanceToken/);
});
