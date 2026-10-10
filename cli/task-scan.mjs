#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "../server/task-store.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";
import { ScanStore } from "../server/scan-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";
import { logCliError } from "./cli-event-log.mjs";

const ROOT = process.env.WYERP_TASKBOARD_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argsOf(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { result._.push(value); continue; }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { result[key] = next; i++; } else result[key] = true;
  }
  return result;
}
function output(value) { process.stdout.write(JSON.stringify(value, null, 2) + "\n"); }
function required(args, key) { if (!args[key]) throw new Error("missing --" + key); return String(args[key]); }

const args = argsOf(process.argv.slice(2));
const command = args._[0] || "scan";

try {
if (command === "scan") {
  const scanner = await new TaskScanner(ROOT).init();
  output(await scanner.scanOnce({ trigger: "manual" }));
} else {
  const store = await new ScanStore(ROOT).init();
  if (command === "scheduled") {
    const decision = await store.scheduledDecision();
    if (!decision.run) output({ state: "skipped", ...decision });
    else {
      const scanner = await new TaskScanner(ROOT, { scanStore: store }).init();
      output(await scanner.scanOnce({ trigger: "scheduled" }));
    }
  } else if (command === "rearm") {
    const rearmed = await store.requestRearm(args.reason || "manual_rearm", { source: "task-scan-cli" });
    if (rearmed.scheduler_trigger?.started) output({ state: "rearm_dispatched", ...rearmed });
    else {
      const scanner = await new TaskScanner(ROOT, { scanStore: store }).init();
      output(await scanner.scanOnce({ trigger: "rearm:" + String(args.reason || "manual_rearm") }));
    }
  }
  else if (command === "list") output({ items: await store.list({ includeInactive: Boolean(args.all) }) });
  else if (command === "next") output({ candidate: (await store.list()).find((x) => x.eligible) || null });
  else if (command === "status") output(await store.status());
  else if (command === "recheck") {
    const detectionId = required(args, "detection");
    const candidate = await store.get(detectionId);
    if (!candidate) throw new Error("unknown detection_id: " + detectionId);
    const taskStore = await new TaskStore(ROOT).init();
    const requirementStore = await new RequirementStore(ROOT).init();
    const evaluator = new CandidateEvaluator(ROOT, { taskStore, requirementStore });
    output({ detection_id: detectionId, ...(await evaluator.recheck(candidate)) });
  } else if (command === "mark-consumed") {
    output(await store.mark(required(args, "detection"), "consumed", { claimEventId: args["claim-event"] || null }));
  } else if (command === "mark-stale") {
    output(await store.mark(required(args, "detection"), "stale", { reason: args.reason || "manual_recheck_failed" }));
  } else if (command === "help") {
    output({
      commands: [
        "task-scan scan",
        "task-scan scheduled",
        "task-scan rearm [--reason ...]",
        "task-scan status",
        "task-scan list [--all]",
        "task-scan next",
        "task-scan recheck --detection det_...",
        "task-scan mark-consumed --detection det_... --claim-event evt_...",
        "task-scan mark-stale --detection det_... [--reason ...]"
      ],
      rule: "候选不是任务真值；正式claim前必须recheck + taskctl guard + 资源/Job/独立性复核。"
    });
  } else throw new Error("unknown command: " + command);
}
} catch (error) {
  await logCliError(ROOT, "cli-task-scan", command, error, { command });
  process.stderr.write(JSON.stringify({ error: { code: error.code || "TASK_SCAN_ERROR", message: error.message, details: error.details || null } }, null, 2) + "\n");
  process.exitCode = 1;
}
