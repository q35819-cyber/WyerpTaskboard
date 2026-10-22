import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// WMI-launched fixture services do not inherit the Node test runner's lifetime.
// Limit only real, direct children of the OS TEMP directory, never production.
export const TEST_SERVICE_LEASE_MS = 10 * 60 * 1000;

export function isTemporaryTestServiceInstance(instanceFile, port) {
  const number = Number(port);
  // Fixtures use Windows dynamic ports; a regular ERP/board/service port
  // must never be able to activate the automatic shutdown watchdog.
  if (!Number.isInteger(number) || number < 49152 || number > 65535) return false;
  if (typeof instanceFile !== "string" || !path.win32.isAbsolute(instanceFile)) return false;
  const filename = path.win32.normalize(instanceFile);
  if (path.win32.basename(filename).toLowerCase() !== "instance.json") return false;
  const directory = path.win32.dirname(filename);
  if (!/^wyerp-taskboard-service-control-[A-Za-z0-9]{6}$/.test(path.win32.basename(directory))) return false;
  try {
    // Real filesystem paths prevent forged AppData/Local/Temp suffixes and
    // temp-directory symlinks that actually lead into unrelated applications.
    const realTemp = fs.realpathSync.native(os.tmpdir());
    const realDirectory = fs.realpathSync.native(directory);
    const realFile = fs.realpathSync.native(filename);
    return path.win32.relative(realTemp, path.win32.dirname(realDirectory)) === ""
      && path.win32.relative(realDirectory, path.win32.dirname(realFile)) === ""
      && path.win32.basename(realFile).toLowerCase() === "instance.json";
  } catch {
    // Missing fixture or unresolved identity never authorizes shutdown.
    return false;
  }
}
export function installTemporaryTestServiceLease({ instanceFile, port, shutdown, schedule = setTimeout }) {
  if (!isTemporaryTestServiceInstance(instanceFile, port)) return null;
  if (typeof shutdown !== "function") throw new TypeError("shutdown callback required");
  const timer = schedule(() => { void Promise.resolve().then(shutdown); }, TEST_SERVICE_LEASE_MS);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}
