import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { TEST_SERVICE_LEASE_MS, isTemporaryTestServiceInstance, installTemporaryTestServiceLease } from "../server/test-instance-lease.mjs";

// Keep a real fixture on disk: the watchdog must not trust a path string alone.
const fixtureDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "wyerp-taskboard-service-control-"));
const TEMP_FIXTURE = path.join(fixtureDir, "instance.json");
fsSync.writeFileSync(TEMP_FIXTURE, "{}", "utf8");
after(() => fsSync.rmSync(fixtureDir, { recursive: true, force: true }));
const FORMAL = "D:\\WyerpTaskboard\\data\\runtime\\instance.json";
test("only a random-port strict Windows temp test service gets an expiry lease", () => {
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 64722), true);
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE.replaceAll("\\", "/"), 64722), true);
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 47831), false);
  assert.equal(isTemporaryTestServiceInstance(FORMAL, 47831), false);
  assert.equal(isTemporaryTestServiceInstance(FORMAL, 52654), false);
  assert.equal(isTemporaryTestServiceInstance("D:\\OtherSoftware\\wyerp-taskboard-service-control-maDulO\\instance.json", 52654), false);
  assert.equal(isTemporaryTestServiceInstance("C:\\Users\\Admin\\AppData\\Local\\Temp\\wyerp-taskboard-service-control-maDulO\\different.json", 52654), false);
  assert.equal(isTemporaryTestServiceInstance("C:\\Users\\Admin\\AppData\\Local\\Temp\\wyerp-taskboard-service-control-x\\instance.json", 52654), false);
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 0), false);
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 100000), false);
});

test("forged AppData/Local/Temp suffix and relative paths never grant a lease", () => {
  const suffix = "wyerp-taskboard-service-control-Ab2C4d/instance.json";
  assert.equal(isTemporaryTestServiceInstance("D:/UnrelatedApp/AppData/Local/Temp/" + suffix, 64722), false);
  assert.equal(isTemporaryTestServiceInstance("AppData/Local/Temp/" + suffix, 64722), false);

  // Existing fake nested directory must still fail even when realpath works.
  const unrelated = fsSync.mkdtempSync(path.join(os.tmpdir(), "unrelated-app-"));
  try {
    const fake = path.join(unrelated, "AppData", "Local", "Temp", "wyerp-taskboard-service-control-Ab2C4d");
    fsSync.mkdirSync(fake, { recursive: true });
    const file = path.join(fake, "instance.json");
    fsSync.writeFileSync(file, "{}", "utf8");
    assert.equal(isTemporaryTestServiceInstance(file, 64722), false);
    let scheduled = false;
    assert.equal(installTemporaryTestServiceLease({
      instanceFile: file, port: 64722, shutdown() { throw new Error("must never close unrelated app"); },
      schedule() { scheduled = true; throw new Error("must never schedule"); }
    }), null);
    assert.equal(scheduled, false);
  } finally {
    fsSync.rmSync(unrelated, { recursive: true, force: true });
  }
});

test("ERP and other non-ephemeral ports cannot activate test expiry", () => {
  for (const port of [5432, 8765, 8788, 8799, 18765, 18766, 18767, 47831, 49151]) {
    assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, port), false, "protected port " + port);
  }
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 49152), true);
  assert.equal(isTemporaryTestServiceInstance(TEMP_FIXTURE, 65535), true);
});
test("formal service never schedules test shutdown, even when restarted", () => {
  let scheduled = 0, shutdown = 0;
  const schedule = () => { scheduled++; throw new Error("must not schedule"); };
  assert.equal(installTemporaryTestServiceLease({ instanceFile: FORMAL, port: 47831, shutdown() { shutdown++; }, schedule }), null);
  assert.equal(installTemporaryTestServiceLease({ instanceFile: FORMAL, port: 52654, shutdown() { shutdown++; }, schedule }), null);
  assert.equal(installTemporaryTestServiceLease({ instanceFile: TEMP_FIXTURE, port: 47831, shutdown() { shutdown++; }, schedule }), null);
  assert.equal(scheduled, 0);
  assert.equal(shutdown, 0);
});

test("test fixture expiry calls shutdown, schedules only one unref timer at ten minutes", async () => {
  let callback, delay, unref = 0, shutdown = 0;
  const lease = installTemporaryTestServiceLease({
    instanceFile: TEMP_FIXTURE, port: 64722,
    shutdown() { shutdown++; },
    schedule(fn, ms) { callback = fn; delay = ms; return { unref() { unref++; } }; }
  });
  assert.ok(lease);
  assert.equal(delay, TEST_SERVICE_LEASE_MS);
  assert.equal(delay, 600000);
  assert.equal(unref, 1);
  assert.equal(shutdown, 0);
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shutdown, 1);
});

test("main service installs lease after startup and routes expiry through existing graceful shutdown", async () => {
  const source = await fs.readFile(path.resolve("server/main.mjs"), "utf8");
  const callIndex = source.lastIndexOf("installTemporaryTestServiceLease({");
  assert.ok(callIndex > source.indexOf("app = await listenTaskboard"), "install only after successful listener");
  assert.match(source.slice(callIndex), /instanceFile, port/);
  assert.match(source.slice(callIndex), /await shutdown\(\)/);
  assert.match(source, /if \(current\.pid === process\.pid && current\.instanceToken === instanceToken\)/);
});
