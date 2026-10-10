import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
  });
}
async function waitPort(port, expected, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await canConnect(port)) === expected) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("port state timeout: " + port);
}
async function killOwned(child) {
  if (!child) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    child.kill("SIGTERM");
  }
}

test("taskboard remains healthy while ERP port 8765 is occupied by unrelated process", async (t) => {
  let owned = null;
  if (!(await canConnect(8765))) {
    owned = spawn(process.execPath, ["-e", "require('net').createServer().listen(8765,'127.0.0.1');setInterval(()=>{},1000)"], {
      windowsHide: true, stdio: "ignore"
    });
    t.after(() => killOwned(owned));
    await waitPort(8765, true);
  }

  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  const app = await createTaskboardServer({ rootDir: fixture.boardRoot, host: "127.0.0.1", port: 0 });
  await new Promise((resolve, reject) => app.server.once("error", reject).listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => app.server.close(resolve)));

  const port = app.server.address().port;
  const health = await fetch("http://127.0.0.1:" + port + "/healthz", { headers: { Host: "127.0.0.1:" + port } });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).service, "WyerpTaskboard");
  assert.equal(await canConnect(8765), true);
});