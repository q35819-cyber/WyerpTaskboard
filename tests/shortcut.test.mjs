import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const install = path.join(root, "scripts", "install-shortcuts.ps1");
const remove = path.join(root, "scripts", "remove-shortcuts.ps1");

function runPowerShell(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error("exit " + code + ": " + stderr)));
  });
}

test("shortcut installer creates desktop and start-menu URL shortcuts and remover deletes them", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-shortcut-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const desktop = path.join(tmp, "Desktop");
  const startMenu = path.join(tmp, "Programs");

  const created = await runPowerShell(install, ["-DesktopPath", desktop, "-StartMenuProgramsPath", startMenu, "-Url", "http://127.0.0.1:47831"]);
  assert.match(created.stdout, /created/);

  const name = "WyerpTaskboard任务看板.url";
  const desktopFile = path.join(desktop, name);
  const startFile = path.join(startMenu, name);
  const [desktopText, startText] = await Promise.all([fs.readFile(desktopFile, "utf8"), fs.readFile(startFile, "utf8")]);
  assert.match(desktopText, /URL=http:\/\/127\.0\.0\.1:47831/);
  assert.match(startText, /URL=http:\/\/127\.0\.0\.1:47831/);

  const removed = await runPowerShell(remove, ["-DesktopPath", desktop, "-StartMenuProgramsPath", startMenu]);
  assert.match(removed.stdout, /removed/);
  await assert.rejects(() => fs.access(desktopFile));
  await assert.rejects(() => fs.access(startFile));
});

test("shortcut scripts do not control ERP service or kill processes", async () => {
  const [a,b] = await Promise.all([fs.readFile(install,"utf8"),fs.readFile(remove,"utf8")]);
  for (const text of [a,b]) assert.equal(/8765|taskkill|Stop-Process|start\.ps1/i.test(text), false);
});