#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { TaskStepCheckpoint, ROLE_STAGE_STEPS } from "../server/task-step-checkpoint.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function argsOf(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw Error("参数格式错误：" + argv[i]);
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    result[key] = argv[++i];
  }
  return result;
}
const [command, ...args] = process.argv.slice(2);
if (command === "help" || !command) {
  console.log("用法：node cli/stepctl.mjs show --project <project> --task <task-id>");
  console.log("      node cli/stepctl.mjs record --project <project> --task <task-id> --step <C01_SCAN|D01_CLAIM|...> --actor-type <controller_ai|developer_ai|test_ai> --actor-id <id> --session-id <session> --expected-sha256 <show返回的SHA> --evidence <报告或真实事件证据> [--event-id <正式事件ID>] [--result PASS|FAIL|BLOCK|PROGRESS] [--substep <小步骤编号，PROGRESS必需>]");
  console.log(JSON.stringify(ROLE_STAGE_STEPS, null, 2));
  process.exit(0);
}
try {
  const a = argsOf(args);
  if (!a.project || !a.task) throw Error("必须提供--project和--task");
  const checkpoints = await new TaskStepCheckpoint(rootDir).init();
  if (command === "show") {
    console.log(JSON.stringify(await checkpoints.show(a.project, a.task), null, 2));
  } else if (command === "record") {
    const response = await checkpoints.record(a.project, a.task, {
      operationId: a.operationId || "step." + crypto.randomUUID(),
      expectedSha256: a.expectedSha256,
      stepId: a.step, actorType: a.actorType, actorId: a.actorId,
      sessionId: a.sessionId, evidence: a.evidence, eventId: a.eventId,
      result: a.result || "PASS", substepId: a.substep, note: a.note
    });
    console.log(JSON.stringify({ file: response.file, sha256: response.sha256,
      duplicate: response.duplicate, lastAction: response.state.lastAction,
      nextStep: response.state.cursors[a.actorType] }, null, 2));
  } else throw Error("未知命令：" + command);
} catch (error) {
  console.error(JSON.stringify({ error: error.code || "STEP_COMMAND_FAILED", message: error.message }));
  process.exitCode = 1;
}
