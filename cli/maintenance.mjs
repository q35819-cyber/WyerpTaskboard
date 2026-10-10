#!/usr/bin/env node
import path from "node:path";
import { GovernanceBackupStore } from "../server/backup-store.mjs";
import { logCliError } from "./cli-event-log.mjs";

const rootDir = process.env.WYERP_TASKBOARD_ROOT || "D:\\WyerpTaskboard";
const [command = "help", ...args] = process.argv.slice(2);
const store = new GovernanceBackupStore(rootDir);

function out(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function required(value, name) {
  if (!value) throw new Error(name + " is required");
  return value;
}

try {
  if (command === "help") {
    out({
      usage: [
        "maintenance backup [label]",
        "maintenance verify <backupDir>",
        "maintenance restore-copy <backupDir> <destinationDir>"
      ],
      note: "restore-copy only materializes a verified copy; it never overwrites live config/events/transactions."
    });
  } else if (command === "backup") {
    out(await store.create({ label: args[0] || "manual" }));
  } else if (command === "verify") {
    out(await store.verify(path.resolve(required(args[0], "backupDir"))));
  } else if (command === "restore-copy") {
    out(await store.materializeVerifiedCopy(
      path.resolve(required(args[0], "backupDir")),
      path.resolve(required(args[1], "destinationDir"))
    ));
  } else {
    throw new Error("Unknown command: " + command);
  }
} catch (error) {
  await logCliError(rootDir, "cli-maintenance", command, error, { command });
  process.stderr.write(JSON.stringify({ error: { code: error.code || "MAINTENANCE_ERROR", message: error.message, details: error.details || null } }, null, 2) + "\n");
  process.exitCode = 1;
}
