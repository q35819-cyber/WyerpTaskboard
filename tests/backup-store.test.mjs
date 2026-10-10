import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { GovernanceBackupStore } from "../server/backup-store.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { makeFixture } from "./helpers.mjs";

test("governance backup captures projects/events/transactions and verifies", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));

  const store = await new TaskStore(f.boardRoot).init();
  const before = await store.snapshot("fixture");
  await store.updateTask("fixture", "B-10", { priority: "P1" }, {
    expectedRevision: before.registryRevision,
    operationId: "backup.seed.001",
    eventType: "priority_change",
    actorType: "developer_ai",
    actorId: "dev"
  });

  const backups = new GovernanceBackupStore(f.boardRoot);
  const created = await backups.create({ label: "test" });
  const paths = created.manifest.files.map((x) => x.path);
  assert.ok(paths.includes("config/projects.json"));
  assert.ok(paths.some((x) => x.startsWith("data/events/fixture/") && x.endsWith(".jsonl")));
  assert.ok(paths.some((x) => x.startsWith("data/runtime/transactions/")));
  assert.equal((await backups.verify(created.backupDir)).ok, true);

  const restored = path.join(f.boardRoot, "restore-copy");
  const result = await backups.materializeVerifiedCopy(created.backupDir, restored);
  assert.ok(result.files >= 3);
  assert.equal(JSON.parse(await fs.readFile(path.join(restored, "config", "projects.json"), "utf8")).projects[0].id, "fixture");
});

test("tampered backup is detected and restore copy is refused", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));

  const store = await new TaskStore(f.boardRoot).init();
  await store.appendTaskEvent("fixture", "B-10", {
    operationId: "backup.event.001",
    eventType: "developer_note",
    actorType: "developer_ai",
    actorId: "dev",
    note: "hello"
  });

  const backups = new GovernanceBackupStore(f.boardRoot);
  const created = await backups.create({ label: "tamper" });
  const eventFile = created.manifest.files.find((x) => x.path.endsWith(".jsonl"));
  assert.ok(eventFile);
  await fs.appendFile(path.join(created.backupDir, ...eventFile.path.split("/")), "{broken}\n", "utf8");

  const verification = await backups.verify(created.backupDir);
  assert.equal(verification.ok, false);
  assert.ok(verification.issues.some((x) => x.code === "SIZE_MISMATCH" || x.code === "CHECKSUM_MISMATCH"));

  await assert.rejects(
    backups.materializeVerifiedCopy(created.backupDir, path.join(f.boardRoot, "should-not-restore")),
    (error) => error.code === "BACKUP_VERIFY_FAILED"
  );
});