import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

test("projects config ACL removes inheritance and Authenticated Users modify access", { skip: process.platform !== "win32" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-acl-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "projects.json");
  await fs.writeFile(file, '{"version":1,"projects":[]}', "utf8");

  const script = "D:\\WyerpTaskboard\\scripts\\harden-config-acl.ps1";
  const hardened = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", script, "-PathValue", file
  ], { windowsHide: true });
  assert.equal(JSON.parse(hardened.stdout.trim()).ok, true);

  const { stdout } = await execFileAsync("icacls.exe", [file], { windowsHide: true });
  assert.doesNotMatch(stdout, /Authenticated Users.*\((?:M|W|F)\)/i);
  assert.doesNotMatch(stdout, /\(I\)/);
  assert.match(stdout, /SYSTEM.*\(F\)/i);
  assert.match(stdout, /Administrators.*\(F\)/i);
});
