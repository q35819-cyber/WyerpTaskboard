#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logCliError } from "./cli-event-log.mjs";

const rootDir = process.env.WYERP_TASKBOARD_ROOT || "D:\\WyerpTaskboard";
const baseUrl = process.env.WYERP_TASKBOARD_URL || "http://127.0.0.1:47831";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (!value.startsWith("--")) { out._.push(value); continue; }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
function required(args, key) {
  const value = args[key];
  if (value === undefined || value === true || value === "") throw new Error("--" + key + " is required");
  return String(value);
}
function explicitProject(args) {
  const value = args.project;
  if (value === undefined || value === true || value === "") {
    const error = new Error("该命令必须显式指定 --project，禁止跨项目静默默认");
    error.code = "PROJECT_REQUIRED";
    throw error;
  }
  return String(value);
}
function operationId(args, prefix) { return args["operation-id"] || prefix + "." + randomUUID(); }
async function secret() {
  if (process.env.WYERP_TASKBOARD_SECRET) return process.env.WYERP_TASKBOARD_SECRET;
  const config = JSON.parse(await fs.readFile(path.join(rootDir, "config", "admin-secret.json"), "utf8"));
  if (!config.adminSecret) throw new Error("admin-secret.json is invalid");
  return config.adminSecret;
}
async function request(url, { method = "GET", body = null } = {}) {
  const headers = { Authorization: "Bearer " + await secret() };
  if (body !== null) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(baseUrl + url, {
      method, headers, body: body === null ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    const wrapped = new Error("Taskboard service unavailable at " + baseUrl + ": " + error.message);
    wrapped.code = "SERVICE_UNAVAILABLE";
    throw wrapped;
  }
  let data = null;
  try { data = await response.json(); }
  catch (error) {
    await logCliError(rootDir, "taskctl", "response_json_parse", error, {
      method,
      url,
      http_status: response.status
    });
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message || ("HTTP " + response.status));
    error.code = data?.error?.code || "HTTP_ERROR";
    error.status = response.status;
    error.details = data?.error?.details;
    throw error;
  }
  return data;
}
function projectTask(args) { return { project: explicitProject(args), task: required(args, "task") }; }
async function current(project, task) {
  return request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task));
}
async function recordDeliveryFailure(project, task, who, {
  failureStage = "verification",
  failureCode = "DELIVERY_ATTEMPT_FAILED",
  note,
  nextAction = "原开发AI保持当前Session继续处理；按阻断原因修复后重新同步远端main、重跑合并后回归，再执行taskctl complete"
} = {}) {
  const latest = await current(project, task);
  if (latest.status !== "交付中" || latest.sessionId !== who.sessionId) return null;
  return request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/delivery-attempt-failed", {
    method: "POST",
    body: {
      operationId: "delivery_failure." + randomUUID(),
      expectedRevision: latest.registryRevision,
      ...who,
      failureStage,
      failureCode,
      note: String(note || "交付核验失败").slice(0, 1000),
      nextAction
    }
  });
}
function metadata(args, extra = {}) {
  let parsed = {};
  if (args.metadata) {
    try { parsed = JSON.parse(args.metadata); } catch { throw new Error("--metadata must be valid JSON"); }
  }
  return { ...parsed, ...extra };
}
function actor(args, defaultType = "developer_ai") {
  return {
    actorType: args["actor-type"] || defaultType,
    actorId: args["actor-id"] || "taskctl",
    sessionWindowName: args["session-name"] || "",
    sessionId: args["session-id"] || "",
    note: args.note || ""
  };
}
function output(data) { process.stdout.write(JSON.stringify(data, null, 2) + "\n"); }
function inferredActorTypeForStatus(status) {
  return ["待独测", "独测中", "待复测", "复测中"].includes(status) ? "test_ai" : "developer_ai";
}
async function guardState(project, task, args) {
  const who = actor(args, args["actor-type"] || "developer_ai");
  const qs = new URLSearchParams({ actorType: who.actorType, actorId: who.actorId, sessionId: who.sessionId });
  return request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/guard?" + qs.toString());
}
function preflightError(code, message, details) {
  const error = new Error(message); error.code = code; error.status = 409; error.details = details; return error;
}
async function preflight(project, task, args) {
  const result = await guardState(project, task, args);
  if (result.stopRequested) throw preflightError("STOP_REQUESTED", "用户已请求停止，必须先处理停止请求", { request: result.request });
  if (result.userMessages?.requiresAcknowledgement) {
    throw preflightError("USER_MESSAGE_ACK_REQUIRED", "存在未读用户留言，必须先阅读、按需回复并确认已读", { unreadMessages: result.userMessages.unreadMessages });
  }
  if (result.requirements?.pendingCount > 0) {
    throw preflightError("REQUIREMENT_INTAKE_PENDING", "存在待AI拆解的新需求，必须先处理需求入口", { requirements: result.requirements.items?.filter((item) => item.status === "待AI拆解") || [] });
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

try {
  if (command === "help") {
    output({
      usage: [
        "taskctl projects",
        "taskctl list [--project wyerp-taskboard]",
        "taskctl create --project PROJECT --task TASK-ID --parent TEXT --track product[/subtrack]|bugfix|infrastructure --priority P0 --status 待开发 --planned-role 开发AI --boundary TEXT --plan PATH --traceability TEXT --read-dependencies TEXT --write-targets TEXT --targets TEXT",
        "taskctl get --project PROJECT --task WTB-TEST-001",
        "taskctl guard --project PROJECT --task WTB-TEST-001 [--actor-id ID --session-id ID]",
        "taskctl preclaim-report --project PROJECT --task WTB-TEST-001 --actor-id ID --session-id ID --note TEXT [--actor-type developer_ai|test_ai]",
        "taskctl ack-user --project PROJECT --task WTB-TEST-001 [--actor-type developer_ai|test_ai] [--actor-id ID --session-id ID]",
        "taskctl need-user --project PROJECT --task WTB-TEST-001 --note TEXT",
        "taskctl clear-user-need --project PROJECT --task WTB-TEST-001 --note TEXT",
        "taskctl event --project PROJECT --task WTB-TEST-001 --event-type TYPE --note TEXT",
        "taskctl resource-preserve --project PROJECT --task WTB-TEST-001 --resource ID --resource-type process|port|fixture|browser|database --locator TEXT --purpose TEXT --handoff developer_ai --cleanup-condition TEXT --evidence PATH --actor-type test_ai --actor-id ID --session-id ID [--cleanup-by ISO --safety-status safe|isolated|risk]",
        "taskctl resource-observe --project PROJECT --task WTB-TEST-001 --resource ID --result viewed|reproduced|not_needed --note TEXT [--actor-id ID --session-id ID]",
        "taskctl resource-clean --project PROJECT --task WTB-TEST-001 --resource ID --note TEXT [--actor-type developer_ai|test_ai --actor-id ID --session-id ID]",
        "taskctl claim --project PROJECT --task WTB-TEST-001 --assignee NAME --session-name NAME --session-id ID --actor-id ID [--actor-type developer_ai|test_ai]",
        "taskctl release --project PROJECT --task WTB-TEST-001 --session-id ID [--note TEXT]",
        "taskctl reply-user --project PROJECT --task WTB-TEST-001 --message EVENT_ID --note TEXT [--session-id ID]",
        "taskctl priority --project PROJECT --task WTB-TEST-001 --value P1",
        "taskctl transition --project PROJECT --task WTB-TEST-001 --status 待独测 --event-type handoff",
        "taskctl complete --project PROJECT --task WTB-TEST-001 --actor-id ID --session-id ID --note TEXT [--report POST_MERGE_PASS_REPORT when status is 交付中]",
        "taskctl delivery-failed --project PROJECT --task WTB-TEST-001 --actor-id ID --session-id ID --failure-stage merge|push|remote_sync|regression|report|verification --failure-code CODE --note REASON --next-action ACTION",
        "taskctl changed --project PROJECT --task WTB-TEST-001 --kind code|doc --paths a,b --note TEXT [--invalidates-test true]",
        "taskctl test-start --project PROJECT --task WTB-TEST-001 --note TEXT [--report path] [--actor-type test_ai --actor-id ID --session-id ID]",
        "taskctl test-result --project PROJECT --task WTB-TEST-001 --result pass|fail|blocked --report path --note TEXT [--delivery-mode required|user_acceptance|auto_close] [--delivery-actions candidate_merge,...] [--commit-sha SHA --branch feature/name when candidate_merge] [--actor-type test_ai --actor-id ID --session-id ID]",
        "taskctl stop --project PROJECT --task WTB-TEST-001 --note TEXT",
        "taskctl suspect-disconnect --project PROJECT --task WTB-TEST-001 --note EVIDENCE",
        "taskctl takeover --project PROJECT --task WTB-TEST-001 --assignee NAME --session-name NAME --session-id ID --note TEXT [--user-quote '用户当前明确要求接管的原话' --user-scope task|project --actor-id ID] [--evidence '可选：原Session/Job/资源核验记录']",
        "taskctl ack-stop --project PROJECT --task WTB-TEST-001 --note TEXT",
        "taskctl resume --project PROJECT --task WTB-TEST-001 --note TEXT",
        "taskctl review --project PROJECT --task WTB-TEST-001 --action comment|accept|reject --reason defect|evidence|decision|hold --note TEXT",
        "taskctl history --project PROJECT --task WTB-TEST-001",
        "taskctl requirements --project PROJECT",
        "taskctl requirement-reply --project PROJECT --requirement REQ-ID --note TEXT [--reply-to MSG-ID]",
        "taskctl requirement-status --project PROJECT --requirement REQ-ID --status 待用户补充|已拆解|已取消 [--plans a.md,b.md --tasks A-01,B-02 --key-files server/a.js,web/b.js] --note TEXT"
      ],
      cooperativeEnforcement: true,
      note: "help/projects 不需要项目；list 仅为只读兼容保留自身项目默认值，建议始终显式指定 --project。其余项目型命令必须提供 --project。claim 前先聊天汇报，再登记同一 actor/session 的 preclaim-report 并复核 guard/实时占用；claim 的 --actor-id 为必填。test-start/test-result 默认开发自测；独测必须显式传 --actor-type test_ai 和稳定 --actor-id。待交付只能由原开发 actor/session 认领；交付核验失败会自动写入delivery_attempt_failed，merge/push等命令失败时必须执行delivery-failed。示例占位值需替换，含空格或竖线的参数值应加引号。"
    });
  } else if (command === "projects") {
    output(await request("/api/projects"));
  } else if (command === "list") {
    output(await request("/api/projects/" + encodeURIComponent(args.project || "wyerp-taskboard") + "/tasks"));
  } else if (command === "create") {
    const project = explicitProject(args);
    const snapshot = await request("/api/projects/" + encodeURIComponent(project) + "/tasks");
    const task = {
      id: required(args, "task"),
      parent: required(args, "parent"),
      track: required(args, "track"),
      priority: required(args, "priority"),
      status: required(args, "status"),
      plannedRole: required(args, "planned-role"),
      boundary: required(args, "boundary"),
      plan: required(args, "plan"),
      traceability: required(args, "traceability"),
      readDependencies: args["read-dependencies"] || "",
      writeTargets: required(args, "write-targets"),
      targets: required(args, "targets")
    };
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks", {
      method: "POST",
      body: {
        operationId: operationId(args, "task_create"),
        expectedRevision: snapshot.registryRevision,
        task,
        ...actor(args, args["actor-type"] || "developer_ai"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "get") {
    const { project, task } = projectTask(args); output(await current(project, task));
  } else if (command === "history") {
    const { project, task } = projectTask(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/history?limit=" + encodeURIComponent(args.limit || "200")));
  } else if (command === "guard") {
    const { project, task } = projectTask(args);
    const result = await guardState(project, task, args);
    output(result);
    if (result.stopRequested) process.exitCode = 3;
    else if (result.userMessages?.requiresAcknowledgement) process.exitCode = 4;
    else if (result.requirements?.pendingCount > 0) process.exitCode = 5;
  } else if (command === "preclaim-report") {
    const { project, task } = projectTask(args);
    const actorType = args["actor-type"] || "developer_ai";
    const actorId = required(args, "actor-id");
    const sessionId = required(args, "session-id");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/preclaim-report", {
      method: "POST",
      body: {
        operationId: operationId(args, "preclaim_report"),
        ...actor(args, actorType),
        actorType,
        actorId,
        sessionId,
        note: required(args, "note"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "ack-user") {
    const { project, task } = projectTask(args);
    const taskState = args["actor-type"] ? null : await current(project, task);
    const who = actor(args, args["actor-type"] || inferredActorTypeForStatus(taskState?.status));
    const qs = new URLSearchParams({ actorType: who.actorType, actorId: who.actorId, sessionId: who.sessionId });
    const guard = await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/guard?" + qs.toString());
    const eventIds = (guard.userMessages?.unreadMessages || []).map((item) => item.eventId);
    if (!eventIds.length) {
      output({ acknowledged: [], alreadyRead: true, message: "当前没有未读用户留言" });
    } else {
      output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/ack-user-messages", {
        method: "POST",
        body: { operationId: operationId(args, "user_message_ack"), eventIds, ...who, note: args.note || "已阅读用户留言" }
      }));
    }
  } else if (command === "requirements") {
    const project = explicitProject(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/requirements"));
  } else if (command === "requirement-reply") {
    const project = explicitProject(args);
    const requirementId = required(args, "requirement");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/requirements/" + encodeURIComponent(requirementId) + "/reply", {
      method: "POST",
      body: { operationId: operationId(args, "requirement_reply"), ...actor(args, args["actor-type"] || "developer_ai"), note: required(args, "note"), replyToMessageId: args["reply-to"] || null }
    }));
  } else if (command === "requirement-status") {
    const project = explicitProject(args);
    const requirementId = required(args, "requirement");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/requirements/" + encodeURIComponent(requirementId) + "/status", {
      method: "POST",
      body: {
        operationId: operationId(args, "requirement_status"),
        ...actor(args, args["actor-type"] || "developer_ai"),
        status: required(args, "status"),
        planPaths: String(args.plans || "").split(",").map((x) => x.trim()).filter(Boolean),
        taskIds: String(args.tasks || "").split(",").map((x) => x.trim()).filter(Boolean),
        keyFiles: String(args["key-files"] || "").split(",").map((x) => x.trim()).filter(Boolean),
        note: args.note || ""
      }
    }));
  } else if (command === "need-user") {
    const { project, task } = projectTask(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: { operationId: operationId(args, "user_action_required"), eventType: "user_action_required", ...actor(args, "developer_ai"), note: required(args, "note"), metadata: metadata(args) }
    }));
  } else if (command === "clear-user-need") {
    const { project, task } = projectTask(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: { operationId: operationId(args, "user_action_cleared"), eventType: "user_action_cleared", ...actor(args, "developer_ai"), note: args.note || "当前用户配合事项已完成", metadata: metadata(args) }
    }));
  } else if (command === "event") {
    const { project, task } = projectTask(args);
    const eventType = required(args, "event-type");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, eventType),
        eventType,
        ...actor(args),
        metadata: metadata(args)
      }
    }));

  } else if (command === "resource-preserve") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    if ((args["actor-type"] || "") !== "test_ai") throw new Error("--actor-type test_ai is required for resource-preserve");
    required(args, "actor-id");
    const resourceId = required(args, "resource");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, "test_resource_preserved"),
        eventType: "test_resource_preserved",
        ...actor(args, "test_ai"),
        note: args.note || "测试临时资源已保留，等待开发观察",
        metadata: metadata(args, {
          resourceId,
          resourceType: required(args, "resource-type"),
          locator: required(args, "locator"),
          purpose: required(args, "purpose"),
          handoffTarget: required(args, "handoff"),
          cleanupCondition: required(args, "cleanup-condition"),
          cleanupBy: args["cleanup-by"] || null,
          evidencePath: required(args, "evidence"),
          safetyStatus: args["safety-status"] || "safe"
        })
      }
    }));
  } else if (command === "resource-observe") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const result = required(args, "result");
    if (!["viewed", "reproduced", "not_needed"].includes(result)) throw new Error("--result must be viewed, reproduced or not_needed");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, "test_resource_observed"),
        eventType: "test_resource_observed",
        ...actor(args, args["actor-type"] || "developer_ai"),
        note: args.note || "开发已确认测试临时资源",
        metadata: metadata(args, { resourceId: required(args, "resource"), result })
      }
    }));
  } else if (command === "resource-clean") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, "test_resource_cleaned"),
        eventType: "test_resource_cleaned",
        ...actor(args, args["actor-type"] || "developer_ai"),
        note: required(args, "note"),
        metadata: metadata(args, { resourceId: required(args, "resource") })
      }
    }));
  } else if (command === "reply-user") {
    const { project, task } = projectTask(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/reply-user-message", {
      method: "POST",
      body: {
        operationId: operationId(args, "user_message_reply"),
        messageEventId: required(args, "message"),
        ...actor(args, args["actor-type"] || "developer_ai"),
        note: required(args, "note"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "release") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/release", {
      method: "POST",
      body: {
        operationId: operationId(args, "release"),
        expectedRevision: before.registryRevision,
        ...actor(args, args["actor-type"] || "developer_ai"),
        note: args.note || "释放当前任务占用",
        metadata: metadata(args)
      }
    }));
  } else if (command === "claim") {
    const { project, task } = projectTask(args);
    required(args, "actor-id");
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/claim", {
      method: "POST",
      body: {
        operationId: operationId(args, "claim"),
        expectedRevision: before.registryRevision,
        assignee: required(args, "assignee"),
        sessionWindowName: required(args, "session-name"),
        sessionId: required(args, "session-id"),
        targetStatus: args["target-status"] || undefined,
        ...actor(args, args["actor-type"] || "developer_ai"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "priority") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task), {
      method: "PATCH",
      body: {
        operationId: operationId(args, "priority"),
        expectedRevision: before.registryRevision,
        eventType: "priority_change",
        patch: { priority: required(args, "value") },
        ...actor(args),
        metadata: metadata(args)
      }
    }));
  } else if (command === "transition") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const before = await current(project, task);
    const targetStatus = required(args, "status");
    const atomicDeveloperHandoff =
      (before.status === "开发中" && targetStatus === "待独测") ||
      (before.status === "修复中" && targetStatus === "待复测");
    if (atomicDeveloperHandoff) {
      output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/complete-execution", {
        method: "POST",
        body: {
          operationId: operationId(args, "complete_execution"),
          expectedRevision: before.registryRevision,
          ...actor(args, "developer_ai"),
          metadata: metadata(args)
        }
      }));
    } else {
      output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task), {
        method: "PATCH",
        body: {
          operationId: operationId(args, "transition"),
          expectedRevision: before.registryRevision,
          eventType: args["event-type"] || "status_change",
          patch: { status: targetStatus },
          ...actor(args),
          metadata: metadata(args)
        }
      }));
    }
  } else if (command === "changed") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const kind = required(args, "kind");
    if (!["code", "doc"].includes(kind)) throw new Error("--kind must be code or doc");
    const paths = required(args, "paths").split(",").map((x) => x.trim()).filter(Boolean);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, kind + "_change"),
        eventType: kind + "_change",
        ...actor(args),
        metadata: metadata(args, { changedPaths: paths, invalidatesTestEvidence: args["invalidates-test"] === "true" })
      }
    }));
  } else if (command === "complete") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const before = await current(project, task);
    required(args, "session-id");
    if (before.status === "交付中") {
      const who = actor(args, "developer_ai");
      if (who.actorType !== "developer_ai") throw new Error("交付完成必须由developer_ai执行");
      required(args, "actor-id");
      const reportPath = required(args, "report");
      try {
        output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task), {
          method: "PATCH",
          body: {
            operationId: operationId(args, "delivery_complete"),
            expectedRevision: before.registryRevision,
            eventType: "delivery_complete",
            patch: { status: "已完成" },
            ...who,
            metadata: metadata(args, { postMergeReportPath: reportPath, postMergeRegressionResult: "PASS" })
          }
        }));
      } catch (error) {
        try {
          await recordDeliveryFailure(project, task, who, {
            failureStage: "verification",
            failureCode: error.code || "DELIVERY_VERIFICATION_FAILED",
            note: error.message
          });
        } catch (recordError) {
          error.failureLogError = recordError.message;
        }
        throw error;
      }
    } else {
      output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/complete-execution", {
        method: "POST",
        body: {
          operationId: operationId(args, "complete_execution"),
          expectedRevision: before.registryRevision,
          ...actor(args, "developer_ai"),
          metadata: metadata(args)
        }
      }));
    }
  } else if (command === "delivery-failed") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    const before = await current(project, task);
    if (before.status !== "交付中") throw preflightError("DELIVERY_STAGE_REQUIRED", "只有交付中的任务可以登记交付失败", { status: before.status });
    const who = actor(args, "developer_ai");
    if (who.actorType !== "developer_ai") throw new Error("delivery-failed必须由developer_ai执行");
    required(args, "actor-id");
    required(args, "session-id");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/delivery-attempt-failed", {
      method: "POST",
      body: {
        operationId: operationId(args, "delivery_failure"),
        expectedRevision: before.registryRevision,
        ...who,
        failureStage: required(args, "failure-stage"),
        failureCode: args["failure-code"] || "DELIVERY_ATTEMPT_FAILED",
        note: required(args, "note"),
        nextAction: required(args, "next-action"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "test-start") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    if (args["actor-type"] === "test_ai" && !args["actor-id"]) throw new Error("--actor-id is required for independent test");
    if (args["actor-type"] === "test_ai") required(args, "session-id");
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
      method: "POST",
      body: {
        operationId: operationId(args, "test_start"),
        eventType: "test_start",
        ...actor(args, args["actor-type"] || "developer_ai"),
        metadata: metadata(args, { reportPath: args.report || null })
      }
    }));
  } else if (command === "test-result") {
    const { project, task } = projectTask(args);
    await preflight(project, task, args);
    if (args["actor-type"] === "test_ai" && !args["actor-id"]) throw new Error("--actor-id is required for independent test");
    if (args["actor-type"] === "test_ai") required(args, "session-id");
    const result = required(args, "result");
    if (!["pass", "fail", "blocked"].includes(result)) throw new Error("--result must be pass, fail or blocked");
    const reportPath = required(args, "report");
    const actorType = args["actor-type"] || "developer_ai";
    if (actorType === "test_ai") {
      const before = await current(project, task);
      const deliveryActions = args["delivery-actions"] ? args["delivery-actions"].split(",").map((x) => x.trim()).filter(Boolean) : [];
      const testEvidence = {};
      if (result === "pass" && (args["delivery-mode"] || "") === "required" && deliveryActions.includes("candidate_merge")) {
        const commitSha = required(args, "commit-sha");
        const headBranch = required(args, "branch");
        if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error("--commit-sha must be a full 40-character Git commit SHA");
        if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(headBranch) || headBranch.includes("..") || headBranch.includes("//")) {
          throw new Error("--branch must be a valid Git branch name");
        }
        testEvidence.commitSha = commitSha.toLowerCase();
        testEvidence.headBranch = headBranch;
      }
      const saved = await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/test-result", {
        method: "POST",
        body: {
          operationId: operationId(args, "test_result"),
          expectedRevision: before.registryRevision,
          ...actor(args, "test_ai"),
          testResult: result,
          reportPath,
          deliveryDisposition: args["delivery-mode"] || undefined,
          deliveryActions,
          metadata: metadata(args, testEvidence)
        }
      });
      output(saved);
    } else {
      output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/events", {
        method: "POST",
        body: {
          operationId: operationId(args, "test_result"),
          eventType: "test_result",
          ...actor(args, "developer_ai"),
          metadata: metadata(args, { testResult: result, reportPath })
        }
      }));
    }
  } else if (command === "suspect-disconnect") {
    const { project, task } = projectTask(args);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/takeover/suspect", {
      method: "POST",
      body: {
        operationId: operationId(args, "suspected_disconnect"),
        ...actor(args),
        note: required(args, "note"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "takeover") {
    const { project, task } = projectTask(args);
    const basePath = "/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/takeover";
    const id = operationId(args, "takeover");
    const who = actor(args);
    const quote = args["user-quote"] ? String(args["user-quote"]).trim() : "";
    if (quote) {
      required(args, "actor-id");
      required(args, "session-id");
      required(args, "session-name");
      const evidence = args.evidence ? String(args.evidence).trim() : "";
      const scope = String(args["user-scope"] || "task");
      if (!["task", "project"].includes(scope)) throw new Error("--user-scope must be task or project");
      // User's explicit current instruction authorizes takeover directly.
      // Optional live-inspection evidence is recorded when available, but is not a prerequisite.
      if (evidence) {
        await request(basePath + "/suspect", {
          method: "POST", body: {
            operationId: id + ".suspect", ...who, note: evidence,
            metadata: metadata(args, { evidenceOrigin: "executor_live_inspection" })
          }
        });
      }
      await request(basePath + "/allow", {
        method: "POST", body: {
          operationId: id + ".allow", ...who,
          note: "用户在当前对话明确授权：" + quote,
          chatAuthorization: {
            source: "direct_user_message", projectId: project, taskId: task,
            scope, quote, messageRef: args["message-ref"] || ""
          }
        }
      });
    }
    const before = await current(project, task);
    output(await request(basePath, {
      method: "POST", body: {
        operationId: quote ? id + ".execute" : id,
        expectedRevision: before.registryRevision,
        assignee: required(args, "assignee"),
        sessionWindowName: required(args, "session-name"),
        sessionId: required(args, "session-id"),
        ...who,
        note: required(args, "note"),
        metadata: metadata(args)
      }
    }));
  } else if (command === "ack-stop") {
    const { project, task } = projectTask(args);
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/ack-stop", {
      method: "POST",
      body: {
        operationId: operationId(args, "stop_acknowledged"),
        expectedRevision: before.registryRevision,
        ...actor(args),
        metadata: metadata(args)
      }
    }));  } else if (command === "stop" || command === "resume") {
    const { project, task } = projectTask(args);
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/" + command, {
      method: "POST",
      body: {
        operationId: operationId(args, command),
        expectedRevision: before.registryRevision,
        ...actor(args),
        metadata: metadata(args)
      }
    }));
  } else if (command === "review") {
    const { project, task } = projectTask(args);
    const before = await current(project, task);
    output(await request("/api/projects/" + encodeURIComponent(project) + "/tasks/" + encodeURIComponent(task) + "/review", {
      method: "POST",
      body: {
        operationId: operationId(args, "review"),
        expectedRevision: before.registryRevision,
        action: required(args, "action"),
        reason: args.reason || undefined,
        ...actor(args, "user"),
        metadata: metadata(args)
      }
    }));
  } else {
    throw new Error("Unknown command: " + command + ". Run taskctl help.");
  }
} catch (error) {
  await logCliError(rootDir, "cli-taskctl", command, error, { command });
  process.stderr.write(JSON.stringify({
    error: { code: error.code || "TASKCTL_ERROR", message: error.message, status: error.status || null, details: error.details || null }
  }, null, 2) + "\n");
  process.exitCode = 1;
}
