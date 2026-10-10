import fs from "node:fs/promises";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteText } from "./core/atomic-files.mjs";
import { resolveProjectPath } from "./core/path-safety.mjs";
import { withProjectLock } from "./core/project-lock.mjs";
import { ProjectRegistry } from "./project-registry.mjs";
import { EventStore } from "./event-store.mjs";
import { TransactionStore } from "./transaction-store.mjs";
import { ScanStore } from "./scan-store.mjs";

function assertOperationId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    throw new TaskboardError("operation_id格式非法", { code: "INVALID_OPERATION_ID", status: 400 });
  }
}
function injectedCrash(phase) {
  throw new TaskboardError(`测试注入崩溃: ${phase}`, {
    code: "INJECTED_CRASH", status: 599, details: { phase },
  });
}

const USER_MESSAGE_TYPES = new Set(["user_review"]);
const USER_DECISION_TYPES = new Set(["user_accept", "user_reject"]);
function cleanHumanText(value = "") {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/\*\*/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();
}
function documentEntries(task, project = {}) {
  const raw = String(task.targets || "");
  const seen = new Set();
  const entries = [];
  const matcher = /(?:^|[；;])\s*\x60?([^；;\x60]+\.md)\x60?/g;
  let match;
  while ((match = matcher.exec(raw))) {
    const documentPath = match[1].trim();
    if (!documentPath || seen.has(documentPath)) continue;
    seen.add(documentPath);
    const normalized = documentPath.replace(/\\/g, "/");
    const checkpointDir = String(project.checkpointDir || "任务进度断点").replace(/\\/g, "/").replace(/\/+$/, "");
    const reportDir = String(project.reportDir || "测试报告").replace(/\\/g, "/").replace(/\/+$/, "");
    let kind = "related";
    if (normalized === checkpointDir || normalized.startsWith(checkpointDir + "/")) kind = "checkpoint";
    else if (normalized === reportDir || normalized.startsWith(reportDir + "/")) kind = "report";
    entries.push({
      index: entries.length,
      kind,
      name: documentPath.split(/[\\/]/).at(-1) || documentPath,
      path: documentPath
    });
  }
  return entries;
}
function planEntries(task) {
  const raw = String(task.plan || "").trim();
  if (!raw) return [];
  return raw.split(/[；;]/).map((value) => value.trim().replace(/^\x60+|\x60+$/g, "")).filter(Boolean).map((planPath, index) => ({
    index,
    name: planPath.split(/[\\/]/).at(-1) || planPath,
    path: planPath,
    primary: index === 0
  }));
}
function readableTitle(task) {
  const raw = String(task.boundary || "");
  const bold = raw.match(/\*\*([^*]{2,100})\*\*/);
  if (bold) return cleanHumanText(bold[1]);
  const text = cleanHumanText(raw);
  if (text) {
    const head = text.split(/[：:；;]/, 1)[0].trim();
    return (head || text).slice(0, 72);
  }
  return task.id + " 任务";
}
function currentProgressText(task) {
  const map = {
    "待确认": "等待需求或规则确认，确认后才能继续。",
    "待准备": "准备条件尚未完全具备，正在等待进入开发/测试所需条件。",
    "待开发": "准备条件已确认，尚未开始正式开发。",
    "开发中": "正在开发实现；执行中的会话和负责人会持续回写。",
    "待独测": "开发方已完成当前范围，等待独立测试AI验证。",
    "独测中": "独立测试AI正在验证当前实现。",
    "测试失败待修复": "独立测试发现问题，等待开发方修复。",
    "修复中": "正在修复测试发现的问题，修复后进入复测。",
    "待复测": "修复已完成，等待独立测试AI复测。",
    "复测中": "独立测试AI正在复测修复结果。",
    "待交付": "测试已通过，等待整理交付材料。",
    "交付中": "正在整理交付证据并同步最终状态。",
    "待用户验收": "已完成交付，等待用户最终确认通过或打回。",
    "已完成": "用户已明确验收，本任务已关闭。",
    "阻断": "当前存在阻断条件，必须先解除阻断才能继续。",
    "HOLD": "任务已暂停，恢复前不会继续执行。",
    "已取消": "任务已取消，不再执行。"
  };
  return map[task.status] || ("当前状态：" + task.status);
}
function isUserMessage(event) {
  return Boolean(event && event.actor_type === "user" && USER_MESSAGE_TYPES.has(event.event_type) && String(event.note || "").trim());
}
function activeUserAction(events, task) {
  let required = null;
  for (const event of events) {
    if (event.event_type === "user_action_required") required = event;
    if (event.event_type === "user_action_cleared") required = null;
  }
  if (required?.note) return cleanHumanText(required.note);
  const fallback = {
    "待确认": "需要你确认需求、范围或业务规则；确认后任务才能继续。",
    "待用户验收": "需要你检查交付结果，并在看板中选择“通过/认可”或填写意见后打回。",
    "HOLD": "当前无需操作；如果你希望继续，请在看板中恢复任务并说明恢复条件。",
    "阻断": "请查看任务详情中的阻断原因；若涉及账号、权限、业务决策或外部条件，请按阻断说明提供对应条件。"
  };
  return fallback[task.status] || "当前无需你操作；如后续需要账号、权限、业务决策或页面验收，执行AI必须在这里明确写出具体事项。";
}
function presentationForTask(task, events = [], project = {}) {
  const messages = events.filter(isUserMessage);
  const decisions = events.filter((event) => event.actor_type === "user" && USER_DECISION_TYPES.has(event.event_type));
  const latest = messages.at(-1) || null;
  const latestDecision = decisions.at(-1) || null;
  const repliesByMessage = new Map();
  let latestMessageId = null;
  for (const event of events) {
    if (isUserMessage(event)) latestMessageId = event.event_id;
    if (event.event_type !== "user_message_reply") continue;
    const target = event.metadata?.replyToEventId || latestMessageId;
    if (!target) continue;
    if (!repliesByMessage.has(target)) repliesByMessage.set(target, []);
    repliesByMessage.get(target).push({
      eventId: event.event_id,
      timestamp: event.timestamp,
      actorType: event.actor_type,
      actorId: event.actor_id,
      note: cleanHumanText(event.note)
    });
  }
  const latestReplies = latest ? (repliesByMessage.get(latest.event_id) || []) : [];
  return {
    title: readableTitle(task),
    responsibility: cleanHumanText(task.boundary) || "尚未填写任务职责说明，执行AI需要补充。",
    currentProgress: currentProgressText(task),
    userAssistance: activeUserAction(events, task),
    latestUserMessage: latest ? {
      eventId: latest.event_id,
      type: latest.event_type,
      timestamp: latest.timestamp,
      note: cleanHumanText(latest.note),
      replied: latestReplies.length > 0,
      replyCount: latestReplies.length,
      latestReply: latestReplies.at(-1) || null
    } : null,
    userMessageCount: messages.length,
    latestUserDecision: latestDecision ? {
      eventId: latestDecision.event_id,
      type: latestDecision.event_type,
      timestamp: latestDecision.timestamp,
      note: cleanHumanText(latestDecision.note),
      oldStatus: latestDecision.old_status,
      newStatus: latestDecision.new_status
    } : null,
    plans: planEntries(task),
    mainPlan: planEntries(task)[0] || null,
    traceability: cleanHumanText(task.traceability) || "—",
    documents: documentEntries(task, project),
    relatedArtifacts: cleanHumanText(task.targets) || "—"
  };
}
function messageScope({ actorType = "developer_ai", actorId = "taskctl", sessionId = "" } = {}) {
  return [String(actorType || "developer_ai"), String(actorId || "taskctl"), String(sessionId || "")].join("|");
}

export class TaskStore {
  constructor(rootDir, { faultAfter = null } = {}) {
    this.rootDir = rootDir;
    this.projects = new ProjectRegistry(rootDir);
    this.events = new EventStore(rootDir);
    this.transactions = new TransactionStore(rootDir);
    this.scanStore = new ScanStore(rootDir);
    this.faultAfter = faultAfter;
  }

  async init() {
    await this.projects.load();
    return this;
  }

  maybeCrash(phase) {
    if (this.faultAfter === phase) injectedCrash(phase);
  }

  async rearmScanner(reason, metadata = {}) {
    try { await this.scanStore.requestRearm(reason, metadata); }
    catch (error) {
      await this.scanStore.appendEvent({ type: "task_rearm_failed", reason, metadata, error: String(error?.message || error).slice(0, 500) }).catch(logError => console.error("task rearm log failed:", logError?.message || logError));
    }
  }

  async snapshot(projectId) {
    const context = await this.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    for (const task of parsed.tasks) {
      context.workflow.validatePriority(task.priority);
      context.workflow.validateTrack(task.track);
      context.workflow.validateStatus(task.status);
    }
    const projectEvents = await this.events.listTaskEvents(projectId, null, { limit: 1000 });
    const eventMap = new Map();
    for (const event of projectEvents) {
      if (!event.task_id) continue;
      if (!eventMap.has(event.task_id)) eventMap.set(event.task_id, []);
      eventMap.get(event.task_id).push(event);
    }
    const tasks = [...parsed.tasks].sort((a, b) =>
      context.workflow.sortKey(a) - context.workflow.sortKey(b) || a.id.localeCompare(b)
    ).map((task) => ({
      ...task,
      presentation: presentationForTask(task, eventMap.get(task.id) || [], context.project)
    }));
    return {
      projectId,
      projectName: context.project.name,
      workflowProfile: context.project.workflowProfile,
      registryFormatVersion: context.project.registryFormatVersion,
      registryRevision: parsed.registryRevision,
      fileSha256: parsed.fileSha256,
      sourceHealth: { status: "healthy", writable: true },
      workflow: {
        id: context.workflow.id,
        priorities: context.workflow.priorities,
        tracks: context.workflow.tracks,
        statuses: context.workflow.statuses,
        roles: context.workflow.roles,
        boardColumns: context.workflow.boardColumns
      },
      tasks,
    };
  }

  async updateTask(projectId, taskId, patch, {
    expectedRevision,
    operationId,
    eventType = "task_update",
    actorType = "system",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null,
  } = {}) {
    assertOperationId(operationId);
    const userWrite = actorType === "user";
    if (!expectedRevision && !userWrite) throw new TaskboardError("写操作必须提供expectedRevision", {
      code: "EXPECTED_REVISION_REQUIRED", status: 428,
    });

    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      let existing = await this.transactions.read(operationId);
      if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
      if (existing && existing.projectId !== projectId) throw new TaskboardError("operation_id已用于其它项目", {
        code: "IDEMPOTENCY_KEY_CONFLICT", status: 409,
      });
      if (existing && existing.state !== "aborted_no_effect") {
        await this.recoverTransaction(existing);
        existing = await this.transactions.read(operationId);
        if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
        if (existing?.state === "inconsistent") throw new TaskboardError("历史操作处于事务一致性异常，拒绝重试", {
          code: "TRANSACTION_INCONSISTENT", status: 409, details: { operationId },
        });
      }

      const context = await this.projects.context(projectId);
      const fileText = await fs.readFile(context.registryPath, "utf8");
      const parsed = context.adapter.parseRegistryText(fileText, context.project);
      if (!userWrite && parsed.registryRevision !== expectedRevision) {
        throw new TaskboardError("任务注册表revision已变化", {
          code: "REVISION_CONFLICT", status: 409,
          details: { expectedRevision, actualRevision: parsed.registryRevision },
        });
      }

      // 用户操作永远以当前最新注册表为基准重放，不能因为页面持有旧 revision 而被挡住。
      // AI / 自动化仍保持严格乐观锁，防止相互覆盖。
      const effectiveExpectedRevision = userWrite ? parsed.registryRevision : expectedRevision;
      const userRebased = userWrite && Boolean(expectedRevision) && expectedRevision !== parsed.registryRevision;

      const currentTask = parsed.tasks.find((item) => item.id === taskId);
      if (!currentTask) throw new TaskboardError("未知任务ID: " + taskId, { code: "TASK_NOT_FOUND", status: 404 });
      const effectivePatch = context.workflow.normalizeTaskPatch(currentTask, patch);
      if (parsed.indexes.updatedAt >= 0 && !("updatedAt" in effectivePatch)) {
        effectivePatch.updatedAt = new Date().toISOString();
      }
      const change = context.adapter.patchRegistryText(fileText, context.project, taskId, effectivePatch, context.workflow);
      const timestamp = new Date().toISOString();
      const event = {
        operation_id: operationId,
        project_id: projectId,
        task_id: taskId,
        event_type: eventType,
        timestamp,
        actor_type: actorType,
        actor_id: actorId,
        session_window_name: sessionWindowName,
        session_id: sessionId,
        old_status: change.before.status,
        new_status: change.after.status,
        old_priority: change.before.priority,
        new_priority: change.after.priority,
        old_track: change.before.track,
        new_track: change.after.track,
        note,
        metadata: userRebased
          ? { ...(metadata || {}), user_revision_rebased: true, stale_expected_revision: expectedRevision }
          : metadata,
        registry_revision_before: change.beforeRevision,
        registry_revision_after: change.afterRevision,
      };
      const prepared = await this.transactions.prepare({
        operationId, projectId, taskId,
        expectedRevision: effectiveExpectedRevision,
        beforeRevision: change.beforeRevision,
        afterRevision: change.afterRevision,
        beforeFileSha256: change.beforeFileSha256,
        afterFileSha256: change.afterFileSha256,
        patch: effectivePatch,
        event,
      });
      if (prepared.state === "committed") return { ...prepared.result, idempotentReplay: true };
      this.maybeCrash("prepared");

      await atomicWriteText(context.registryPath, change.text, change.beforeFileSha256);
      await this.transactions.phase(operationId, "registry_written");
      this.maybeCrash("registry_written");

      const appended = await this.events.append(projectId, event);
      await this.transactions.phase(operationId, "event_written", {
        eventId: appended.event.event_id,
        eventSegment: appended.segment || null,
      });
      this.maybeCrash("event_written");

      const result = {
        projectId, taskId, operationId,
        before: change.before,
        after: change.after,
        registryRevision: change.afterRevision,
        fileSha256: change.afterFileSha256,
        eventId: appended.event.event_id,
        idempotentReplay: false,
      };
      await this.transactions.phase(operationId, "committed", {
        committedAt: new Date().toISOString(),
        result,
      });
      await this.rearmScanner("task_write", { projectId, taskId, eventType });
      return result;
    });
  }

  async createTask(projectId, taskInput, {
    expectedRevision,
    operationId,
    actorType = "developer_ai",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null,
  } = {}) {
    assertOperationId(operationId);
    if (!expectedRevision) throw new TaskboardError("创建任务必须提供expectedRevision", {
      code: "EXPECTED_REVISION_REQUIRED", status: 428,
    });
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      let existing = await this.transactions.read(operationId);
      if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
      if (existing && existing.projectId !== projectId) throw new TaskboardError("operation_id已用于其它项目", {
        code: "IDEMPOTENCY_KEY_CONFLICT", status: 409,
      });
      if (existing && existing.state !== "aborted_no_effect") {
        await this.recoverTransaction(existing);
        existing = await this.transactions.read(operationId);
        if (existing?.state === "committed") return { ...existing.result, idempotentReplay: true };
        if (existing?.state === "inconsistent") throw new TaskboardError("历史操作处于事务一致性异常，拒绝重试", {
          code: "TRANSACTION_INCONSISTENT", status: 409, details: { operationId },
        });
      }

      const context = await this.projects.context(projectId);
      const fileText = await fs.readFile(context.registryPath, "utf8");
      const parsed = context.adapter.parseRegistryText(fileText, context.project);
      if (parsed.registryRevision !== expectedRevision) throw new TaskboardError("任务注册表revision已变化", {
        code: "REVISION_CONFLICT", status: 409,
        details: { expectedRevision, actualRevision: parsed.registryRevision },
      });
      context.workflow.validatePriority(taskInput.priority);
      context.workflow.validateTrack(taskInput.track || context.project.defaultTrack || "product");
      context.workflow.validateStatus(taskInput.status);
      if (context.workflow.isExecutionStatus(taskInput.status)) throw new TaskboardError("新任务不能直接创建为执行中阶段；请先创建待执行状态，再通过正式claim进入执行态", {
        code: "TASK_CREATE_EXECUTION_STATUS_FORBIDDEN", status: 409, details: { status: taskInput.status },
      });
      const suppliedRole = String(taskInput.plannedRole ?? "").trim().replace(/^—$/, "");
      const expectedRole = context.workflow.plannedRoleForStatus(taskInput.status, {
        currentRole: "", suppliedRole, hasSuppliedRole: true, statusChanging: true
      });
      if (suppliedRole !== expectedRole) throw new TaskboardError(`阶段 ${taskInput.status} 的计划角色必须为 ${expectedRole || "—"}`, {
        code: "STATUS_ROLE_MISMATCH", status: 409,
        details: { targetStatus: taskInput.status, expectedRole: expectedRole || "—", suppliedRole: suppliedRole || "—" },
      });
      if (taskInput.assignee || taskInput.sessionWindowName || taskInput.sessionId) throw new TaskboardError("新任务创建阶段不得直接写入负责人或Session；请使用正式claim", {
        code: "TASK_CREATE_OWNER_FORBIDDEN", status: 409,
      });
      const task = { ...taskInput, plannedRole: expectedRole, assignee: "", sessionWindowName: "", sessionId: "", updatedAt: taskInput.updatedAt || new Date().toISOString() };
      const change = context.adapter.appendRegistryTaskText(fileText, context.project, task);
      const timestamp = new Date().toISOString();
      const event = {
        operation_id: operationId, project_id: projectId, task_id: change.task.id,
        event_type: "task_created", timestamp, actor_type: actorType, actor_id: actorId,
        session_window_name: sessionWindowName, session_id: sessionId,
        old_status: null, new_status: change.task.status,
        old_priority: null, new_priority: change.task.priority,
        old_track: null, new_track: change.task.track,
        note, metadata,
        registry_revision_before: change.beforeRevision, registry_revision_after: change.afterRevision,
      };
      const prepared = await this.transactions.prepare({
        operationId, projectId, taskId: change.task.id, expectedRevision,
        beforeRevision: change.beforeRevision, afterRevision: change.afterRevision,
        beforeFileSha256: change.beforeFileSha256, afterFileSha256: change.afterFileSha256,
        patch: { createTask: change.task }, event,
      });
      if (prepared.state === "committed") return { ...prepared.result, idempotentReplay: true };
      this.maybeCrash("prepared");
      await atomicWriteText(context.registryPath, change.text, change.beforeFileSha256);
      await this.transactions.phase(operationId, "registry_written");
      this.maybeCrash("registry_written");
      const appended = await this.events.append(projectId, event);
      await this.transactions.phase(operationId, "event_written", {
        eventId: appended.event.event_id, eventSegment: appended.segment || null,
      });
      this.maybeCrash("event_written");
      const result = {
        projectId, taskId: change.task.id, operationId, task: change.task,
        registryRevision: change.afterRevision, fileSha256: change.afterFileSha256,
        eventId: appended.event.event_id, idempotentReplay: false,
      };
      await this.transactions.phase(operationId, "committed", { committedAt: new Date().toISOString(), result });
      await this.rearmScanner("task_created", { projectId, taskId: change.task.id });
      return result;
    });
  }
  async getTask(projectId, taskId) {
    const snapshot = await this.snapshot(projectId);
    const task = snapshot.tasks.find((item) => item.id === taskId);
    if (!task) throw new TaskboardError("未知任务ID: " + taskId, { code: "TASK_NOT_FOUND", status: 404 });
    return { task, snapshot };
  }

  async appendTaskEvent(projectId, taskId, {
    operationId,
    eventType,
    actorType = "system",
    actorId = "",
    sessionWindowName = "",
    sessionId = "",
    note = "",
    metadata = null
  } = {}) {
    assertOperationId(operationId);
    const existing = await this.events.findByOperationId(projectId, operationId);
    if (existing) return { event: existing, idempotentReplay: true };
    const { task, snapshot } = await this.getTask(projectId, taskId);
    const appended = await this.events.append(projectId, {
      operation_id: operationId,
      project_id: projectId,
      task_id: taskId,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      actor_type: actorType,
      actor_id: actorId,
      session_window_name: sessionWindowName,
      session_id: sessionId,
      old_status: task.status,
      new_status: task.status,
      old_priority: task.priority,
      new_priority: task.priority,
      old_track: task.track,
      new_track: task.track,
      note,
      metadata,
      registry_revision_before: snapshot.registryRevision,
      registry_revision_after: snapshot.registryRevision
    });
    if (!appended.duplicate) await this.rearmScanner("task_event", { projectId, taskId, eventType });
    return { event: appended.event, idempotentReplay: appended.duplicate };
  }

  async taskHistory(projectId, taskId, { limit = 200 } = {}) {
    await this.getTask(projectId, taskId);
    return this.events.listTaskEvents(projectId, taskId, { limit });
  }


  async autoCloseAuthorizationState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { limit: 1000 });
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.event_type === "auto_close_authorized") return { authorized: true, eventId: event.event_id, timestamp: event.timestamp, note: event.note || "" };
      if (event.event_type === "auto_close_revoked") return { authorized: false, eventId: event.event_id, timestamp: event.timestamp, note: event.note || "" };
    }
    return { authorized: false, eventId: null, timestamp: null, note: "" };
  }
  async testResourceState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { limit: 1000 });
    const resources = new Map();
    for (const event of events) {
      const metadata = event.metadata || {};
      const resourceId = String(metadata.resourceId || "").trim();
      if (!resourceId) continue;
      if (event.event_type === "test_resource_preserved") {
        resources.set(resourceId, {
          resourceId,
          resourceType: String(metadata.resourceType || "").trim(),
          locator: String(metadata.locator || "").trim(),
          purpose: String(metadata.purpose || "").trim(),
          owner: {
            actorType: event.actor_type,
            actorId: event.actor_id,
            sessionId: event.session_id || "",
            sessionWindowName: event.session_window_name || ""
          },
          handoffTarget: String(metadata.handoffTarget || "").trim(),
          cleanupCondition: String(metadata.cleanupCondition || "").trim(),
          cleanupBy: metadata.cleanupBy || null,
          evidencePath: String(metadata.evidencePath || "").trim(),
          safetyStatus: String(metadata.safetyStatus || "safe").trim(),
          preservedAt: event.timestamp,
          status: "待开发观察",
          lastEventId: event.event_id,
          observed: null,
          cleaned: null
        });
      } else if (event.event_type === "test_resource_observed" && resources.has(resourceId)) {
        const item = resources.get(resourceId);
        item.observed = {
          result: String(metadata.result || "viewed"),
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionId: event.session_id || "",
          timestamp: event.timestamp,
          note: cleanHumanText(event.note)
        };
        item.status = metadata.result === "reproduced" ? "开发已复现" : metadata.result === "not_needed" ? "开发确认不再需要" : "开发已查看";
        item.lastEventId = event.event_id;
      } else if (event.event_type === "test_resource_cleaned" && resources.has(resourceId)) {
        const item = resources.get(resourceId);
        item.cleaned = {
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionId: event.session_id || "",
          timestamp: event.timestamp,
          note: cleanHumanText(event.note)
        };
        item.status = "已清理";
        item.lastEventId = event.event_id;
      }
    }
    const now = Date.now();
    const items = [...resources.values()].map((item) => {
      const cleanupAt = item.cleanupBy ? Date.parse(item.cleanupBy) : NaN;
      const stale = !item.cleaned && Number.isFinite(cleanupAt) && cleanupAt <= now;
      const requiresImmediateCleanup = !item.cleaned && !["safe", "isolated"].includes(item.safetyStatus);
      return { ...item, stale, requiresImmediateCleanup };
    });
    return {
      items,
      active: items.filter((item) => !item.cleaned),
      activeCount: items.filter((item) => !item.cleaned).length,
      staleCount: items.filter((item) => !item.cleaned && item.stale).length,
      immediateCleanupCount: items.filter((item) => item.requiresImmediateCleanup).length
    };
  }

  async userMessageState(projectId, taskId, actor = {}) {
    const events = await this.taskHistory(projectId, taskId, { limit: 500 });
    const messages = events.filter(isUserMessage);
    const scope = messageScope(actor);
    const acknowledged = new Set();
    const replies = new Map();
    let latestMessageId = null;
    for (const event of events) {
      if (isUserMessage(event)) latestMessageId = event.event_id;
      if (event.event_type === "user_message_ack" && event.metadata?.scope === scope) {
        for (const eventId of event.metadata?.eventIds || []) acknowledged.add(eventId);
      }
      if (event.event_type === "user_message_reply") {
        const target = event.metadata?.replyToEventId || latestMessageId;
        if (!target) continue;
        if (!replies.has(target)) replies.set(target, []);
        replies.get(target).push({
          eventId: event.event_id,
          timestamp: event.timestamp,
          actorType: event.actor_type,
          actorId: event.actor_id,
          sessionWindowName: event.session_window_name,
          note: cleanHumanText(event.note),
          inferred: !event.metadata?.replyToEventId
        });
      }
    }
    const serialize = (event) => ({
      eventId: event.event_id,
      type: event.event_type,
      timestamp: event.timestamp,
      note: cleanHumanText(event.note),
      replies: replies.get(event.event_id) || []
    });
    const unread = messages.filter((event) => !acknowledged.has(event.event_id));
    return {
      scope,
      messages: messages.slice(-20).map(serialize),
      unreadMessages: unread.map(serialize),
      unreadCount: unread.length,
      requiresAcknowledgement: unread.length > 0
    };
  }

  async preclaimReportState(projectId, taskId, actor = {}, currentTask = null) {
    const task = currentTask || (await this.getTask(projectId, taskId)).task;
    const actorType = String(actor.actorType || "developer_ai");
    const actorId = String(actor.actorId || "");
    const sessionId = String(actor.sessionId || "");
    if (!actorId || !sessionId) {
      return { valid: false, reason: "identity_missing", eventId: null, timestamp: null };
    }
    const events = await this.events.listTaskEvents(projectId, taskId, { limit: 1000 });
    let latest = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (
        event.event_type === "preclaim_report" &&
        event.actor_type === actorType &&
        event.actor_id === actorId &&
        String(event.session_id || "") === sessionId
      ) {
        latest = event;
        break;
      }
    }
    if (!latest) {
      return { valid: false, reason: "missing", eventId: null, timestamp: null };
    }
    const metadata = latest.metadata || {};
    const currentStatus = String(task.status || "");
    const currentUpdatedAt = String(task.updatedAt || "");
    const reportedStatus = String(metadata.taskStatus || "");
    const reportedUpdatedAt = String(metadata.taskUpdatedAt || "");
    const valid = reportedStatus === currentStatus && reportedUpdatedAt === currentUpdatedAt;
    return {
      valid,
      reason: valid ? null : "task_changed",
      eventId: latest.event_id,
      timestamp: latest.timestamp,
      reportedStatus,
      reportedUpdatedAt,
      currentStatus,
      currentUpdatedAt
    };
  }

  async presentation(projectId, taskId) {
    const { task } = await this.getTask(projectId, taskId);
    const events = await this.taskHistory(projectId, taskId, { limit: 500 });
    return presentationForTask(task, events, this.projects.get(projectId));
  }

  async readTaskDocument(projectId, taskId, documentIndex) {
    const { task } = await this.getTask(projectId, taskId);
    const context = await this.projects.context(projectId);
    const documents = documentEntries(task, context.project);
    const index = Number(documentIndex);
    if (!Number.isInteger(index) || index < 0 || index >= documents.length) {
      throw new TaskboardError("任务没有这个关联文档入口", {
        code: "TASK_DOCUMENT_NOT_FOUND", status: 404, details: { taskId, documentIndex }
      });
    }
    const selected = documents[index];
    const filePath = await resolveProjectPath(context.rootRealPath, selected.path, { mustExist: true, rejectReparse: true });
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new TaskboardError("关联文档不是文件", { code: "TASK_DOCUMENT_NOT_FILE", status: 422 });
    if (stat.size > 2 * 1024 * 1024) throw new TaskboardError("关联文档过大，拒绝在看板中直接打开", {
      code: "TASK_DOCUMENT_TOO_LARGE", status: 413, details: { bytes: stat.size }
    });
    return { taskId, ...selected, content: await fs.readFile(filePath, "utf8") };
  }

  async readTaskPlan(projectId, taskId, planIndex) {
    const { task } = await this.getTask(projectId, taskId);
    const plans = planEntries(task);
    const index = Number(planIndex);
    if (!Number.isInteger(index) || index < 0 || index >= plans.length) {
      throw new TaskboardError("任务没有这个计划入口", {
        code: "TASK_PLAN_NOT_FOUND", status: 404, details: { taskId, planIndex }
      });
    }
    const selected = plans[index];
    if (!selected.path.toLowerCase().endsWith(".md")) {
      throw new TaskboardError("任务计划必须是Markdown文档", {
        code: "TASK_PLAN_FORMAT_INVALID", status: 422, details: { taskId, planIndex }
      });
    }
    const context = await this.projects.context(projectId);
    const filePath = await resolveProjectPath(context.rootRealPath, selected.path, { mustExist: true, rejectReparse: true });
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new TaskboardError("任务计划不是文件", { code: "TASK_PLAN_NOT_FILE", status: 422 });
    if (stat.size > 2 * 1024 * 1024) throw new TaskboardError("任务计划文件过大，拒绝在看板中直接打开", {
      code: "TASK_PLAN_TOO_LARGE", status: 413, details: { bytes: stat.size }
    });
    return {
      taskId,
      index,
      name: selected.name,
      path: selected.path,
      primary: selected.primary,
      content: await fs.readFile(filePath, "utf8")
    };
  }

  async stopState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { limit: 500 });
    let pending = null;
    for (const event of events) {
      if (event.event_type === "stop_request") pending = event;
      if (["stop_acknowledged", "resume"].includes(event.event_type)) pending = null;
    }
    return { stopRequested: Boolean(pending), request: pending };
  }
  async takeoverState(projectId, taskId) {
    const events = await this.taskHistory(projectId, taskId, { limit: 500 });
    let suspected = null;
    let allowed = null;
    for (const event of events) {
      if (event.event_type === "suspected_disconnect") {
        suspected = event;
        allowed = null;
      }
      if (event.event_type === "takeover_allowed") {
        allowed = event;
      }
      if (["takeover", "takeover_revoked", "claim"].includes(event.event_type)) {
        suspected = null;
        allowed = null;
      }
    }
    return {
      suspectedDisconnect: Boolean(suspected),
      suspicion: suspected,
      takeoverAllowed: Boolean(allowed),
      authorization: allowed,
    };
  }
  async recoverTransaction(transaction) {
    const { operationId, projectId } = transaction;
    const context = await this.projects.context(projectId);
    const parsed = await context.adapter.readMarkdownTaskRegistry(context.registryPath, context.project);
    const event = await this.events.findByOperationId(projectId, operationId);

    if (parsed.registryRevision === transaction.beforeRevision && !event) {
      await this.transactions.phase(operationId, "aborted_no_effect", {
        recovery: { action: "aborted_no_effect", at: new Date().toISOString() },
      });
      await this.transactions.audit("recovery_aborted_no_effect", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null }, "warning");
      return { operationId, action: "aborted_no_effect" };
    }

    if (parsed.registryRevision === transaction.afterRevision) {
      let finalEvent = event;
      if (!finalEvent) {
        const appended = await this.events.append(projectId, transaction.event);
        finalEvent = appended.event;
      }
      const result = transaction.result || {
        projectId,
        taskId: transaction.taskId,
        operationId,
        registryRevision: transaction.afterRevision,
        fileSha256: transaction.afterFileSha256,
        eventId: finalEvent.event_id,
        recovered: true,
      };
      await this.transactions.phase(operationId, "committed", {
        committedAt: new Date().toISOString(),
        recovery: { action: event ? "commit_existing_event" : "append_missing_event", at: new Date().toISOString() },
        result,
      });
      await this.transactions.audit("recovery_committed", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null, action: event ? "commit_existing_event" : "append_missing_event" });
      return { operationId, action: event ? "commit_existing_event" : "append_missing_event", result };
    }

    await this.transactions.phase(operationId, "inconsistent", {
      recovery: {
        action: "manual_intervention_required",
        at: new Date().toISOString(),
        currentRevision: parsed.registryRevision,
        eventPresent: Boolean(event),
      },
    });
    await this.transactions.audit("recovery_inconsistent", { operation_id: operationId, project_id: projectId, task_id: transaction.taskId || null, current_revision: parsed.registryRevision, event_present: Boolean(event) }, "error");
    return { operationId, action: "inconsistent" };
  }

  async recoverPendingTransactions() {
    const pending = await this.transactions.listPending();
    const results = [];
    for (const transaction of pending) {
      try {
        results.push(await withProjectLock(this.rootDir, transaction.projectId, transaction.operationId, () =>
          this.recoverTransaction(transaction)
        ));
      } catch (error) {
        await this.transactions.audit("recovery_failed", { operation_id: transaction.operationId, project_id: transaction.projectId, task_id: transaction.taskId || null, error: String(error?.message || error).slice(0, 1000) }, "error");
        throw error;
      }
    }
    return results;
  }
}

