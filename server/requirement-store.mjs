import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { withProjectLock } from "./core/project-lock.mjs";
import { ScanStore } from "./scan-store.mjs";

const STATUSES = new Set(["待AI拆解", "待用户补充", "已拆解", "已取消"]);

function assertProjectId(projectId) {
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(projectId)) {
    throw new TaskboardError("非法projectId", { code: "INVALID_IDENTIFIER", status: 400, details: { projectId } });
  }
}
function assertOperationId(operationId) {
  if (typeof operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationId)) {
    throw new TaskboardError("operation_id格式非法", { code: "INVALID_OPERATION_ID", status: 400 });
  }
}
function normalizeText(value, field, { max = 12000 } = {}) {
  const text = String(value || "").trim();
  if (!text) throw new TaskboardError(field + "不能为空", { code: "REQUIREMENT_TEXT_REQUIRED", status: 400 });
  if (text.length > max) throw new TaskboardError(field + "过长", { code: "REQUIREMENT_TEXT_TOO_LONG", status: 413, details: { max } });
  return text;
}
function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 100);
}
function requirementId() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return "REQ-" + stamp + "-" + randomUUID().slice(0, 8).toUpperCase();
}
function messageId() {
  return "msg_" + randomUUID().replaceAll("-", "").slice(0, 20);
}

export class RequirementStore {
  constructor(rootDir, { taskStore = null } = {}) {
    this.rootDir = rootDir;
    this.dir = path.join(rootDir, "data", "requirements");
    this.scanStore = new ScanStore(rootDir);
    this.taskStore = taskStore;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    return this;
  }

  async rearmScanner(reason, metadata = {}) {
    try { await this.scanStore.requestRearm(reason, metadata); }
    catch (error) {
      await this.scanStore.appendEvent({ type: "requirement_rearm_failed", reason, metadata, error: String(error?.message || error).slice(0, 500) }).catch(logError => console.error("requirement rearm log failed:", logError?.message || logError));
    }
  }

  filePath(projectId) {
    assertProjectId(projectId);
    return path.join(this.dir, projectId + ".json");
  }

  async readState(projectId) {
    const file = this.filePath(projectId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.items) || typeof parsed.operations !== "object") {
        throw new Error("schema invalid");
      }
      return parsed;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, items: [], operations: {} };
      if (error instanceof TaskboardError) throw error;
      throw new TaskboardError("需求队列文件损坏", {
        code: "REQUIREMENT_STORE_INVALID", status: 422, details: { projectId, cause: error.message }
      });
    }
  }

  async list(projectId, { status = null } = {}) {
    const state = await this.readState(projectId);
    let items = state.items;
    if (status) {
      const requested = Array.isArray(status) ? status : [status];
      items = items.filter((item) => requested.includes(item.status));
    }
    return items.map((item) => structuredClone(item));
  }

  async pending(projectId) {
    const items = await this.list(projectId, { status: ["待AI拆解", "待用户补充"] });
    const actionable = items.filter((item) => item.status === "待AI拆解");
    return {
      pendingCount: actionable.length,
      waitingUserCount: items.length - actionable.length,
      items
    };
  }

  async create(projectId, { operationId, text, actorId = "local-admin" } = {}) {
    assertOperationId(operationId);
    const normalized = normalizeText(text, "需求内容");
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      const state = await this.readState(projectId);
      const replay = state.operations[operationId];
      if (replay) return { requirement: structuredClone(state.items.find((item) => item.id === replay.requirementId)), idempotentReplay: true };
      const now = new Date().toISOString();
      const requirement = {
        id: requirementId(),
        projectId,
        status: "待AI拆解",
        text: normalized,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId || "local-admin",
        messages: [],
        planPaths: [],
        taskIds: [],
        resolutionNote: ""
      };
      state.items.push(requirement);
      state.operations[operationId] = { type: "create", requirementId: requirement.id, at: now };
      await atomicWriteJson(this.filePath(projectId), state);
      await this.rearmScanner("requirement_write", { projectId, requirementId: requirement.id, operation: "create" });
      return { requirement: structuredClone(requirement), idempotentReplay: false };
    });
  }

  async reply(projectId, requirementIdValue, {
    operationId, actorType = "developer_ai", actorId = "taskctl", note,
    replyToMessageId = null, sessionId = "", sessionWindowName = ""
  } = {}) {
    assertOperationId(operationId);
    const normalized = normalizeText(note, "回复内容", { max: 8000 });
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      const state = await this.readState(projectId);
      const replay = state.operations[operationId];
      if (replay) {
        const req = state.items.find((item) => item.id === replay.requirementId);
        return { requirement: structuredClone(req), message: structuredClone(req?.messages.find((item) => item.id === replay.messageId)), idempotentReplay: true };
      }
      const requirement = state.items.find((item) => item.id === requirementIdValue);
      if (!requirement) throw new TaskboardError("需求不存在", { code: "REQUIREMENT_NOT_FOUND", status: 404, details: { requirementId: requirementIdValue } });
      if (replyToMessageId && !requirement.messages.some((item) => item.id === replyToMessageId)) {
        throw new TaskboardError("要回复的需求消息不存在", { code: "REQUIREMENT_REPLY_TARGET_INVALID", status: 404, details: { replyToMessageId } });
      }
      const now = new Date().toISOString();
      const message = {
        id: messageId(), actorType, actorId, timestamp: now, note: normalized,
        replyToMessageId: replyToMessageId || null,
        sessionId: sessionId || "", sessionWindowName: sessionWindowName || ""
      };
      requirement.messages.push(message);
      requirement.updatedAt = now;
      state.operations[operationId] = { type: "reply", requirementId: requirement.id, messageId: message.id, at: now };
      await atomicWriteJson(this.filePath(projectId), state);
      await this.rearmScanner("requirement_write", { projectId, requirementId: requirement.id, operation: "reply" });
      return { requirement: structuredClone(requirement), message: structuredClone(message), idempotentReplay: false };
    });
  }

  async setStatus(projectId, requirementIdValue, {
    operationId, status, actorType = "developer_ai", actorId = "taskctl",
    note = "", planPaths = [], taskIds = [], keyFiles = [], sessionId = "", sessionWindowName = ""
  } = {}) {
    assertOperationId(operationId);
    if (!STATUSES.has(status)) throw new TaskboardError("非法需求状态: " + status, { code: "INVALID_REQUIREMENT_STATUS", status: 400 });
    const normalizedPlanPaths = normalizeArray(planPaths);
    const normalizedTaskIds = normalizeArray(taskIds);
    const normalizedKeyFiles = normalizeArray(keyFiles);
    if (status === "已拆解" && (!normalizedPlanPaths.length || !normalizedTaskIds.length || !normalizedKeyFiles.length)) {
      throw new TaskboardError("标记已拆解必须填写关联计划、任务ID和关键文件/溯源文件", {
        code: "REQUIREMENT_DECOMPOSITION_REFERENCES_REQUIRED", status: 400
      });
    }
    if (status === "已拆解") {
      if (!this.taskStore) {
        throw new TaskboardError("需求拆解任务引用校验器未初始化，拒绝写入已拆解状态", {
          code: "REQUIREMENT_TASK_REFERENCE_VALIDATOR_UNAVAILABLE", status: 500
        });
      }
      const snapshot = await this.taskStore.snapshot(projectId);
      const existingTaskIds = new Set(snapshot.tasks.map((task) => String(task.id)));
      const missingTaskIds = normalizedTaskIds.filter((taskId) => !existingTaskIds.has(taskId));
      if (missingTaskIds.length) {
        throw new TaskboardError("需求关联任务不存在于当前项目，禁止标记已拆解", {
          code: "REQUIREMENT_TASK_REFERENCE_INVALID",
          status: 409,
          details: { projectId, missingTaskIds }
        });
      }
    }
    return withProjectLock(this.rootDir, projectId, operationId, async () => {
      const state = await this.readState(projectId);
      const replay = state.operations[operationId];
      if (replay) return { requirement: structuredClone(state.items.find((item) => item.id === replay.requirementId)), idempotentReplay: true };
      const requirement = state.items.find((item) => item.id === requirementIdValue);
      if (!requirement) throw new TaskboardError("需求不存在", { code: "REQUIREMENT_NOT_FOUND", status: 404, details: { requirementId: requirementIdValue } });
      const now = new Date().toISOString();
      requirement.status = status;
      requirement.updatedAt = now;
      requirement.planPaths = normalizedPlanPaths;
      requirement.taskIds = normalizedTaskIds;
      requirement.keyFiles = normalizedKeyFiles;
      requirement.resolutionNote = String(note || "").trim();
      if (note) {
        requirement.messages.push({
          id: messageId(), actorType, actorId, timestamp: now, note: String(note).trim(),
          replyToMessageId: null, sessionId: sessionId || "", sessionWindowName: sessionWindowName || ""
        });
      }
      state.operations[operationId] = { type: "status", requirementId: requirement.id, at: now };
      await atomicWriteJson(this.filePath(projectId), state);
      await this.rearmScanner("requirement_write", { projectId, requirementId: requirement.id, operation: "status" });
      return { requirement: structuredClone(requirement), idempotentReplay: false };
    });
  }
}
