import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError, invariant } from "./core/errors.mjs";
import { atomicWriteJson, atomicWriteText } from "./core/atomic-files.mjs";
import { sha256 } from "./core/hash.mjs";
import { resolveProjectPath, resolveProjectRoot } from "./core/path-safety.mjs";
import { getAdapter } from "./adapters/index.mjs";
import { getWorkflowProfile } from "./workflows/index.mjs";

function validateId(id, kind) {
  invariant(typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id), `非法${kind}: ${id}`, {
    code: "INVALID_IDENTIFIER", status: 400, details: { id, kind },
  });
}

function comparableRoot(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function autoProjectId(rootRealPath) {
  const base = path.basename(rootRealPath).trim().toLowerCase();
  const cleaned = base.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned || !/^[a-z0-9]/.test(cleaned)) return "";
  return cleaned.slice(0, 64);
}

export class ProjectRegistry {
  constructor(rootDir, configPath = path.join(rootDir, "config", "projects.json")) {
    this.rootDir = rootDir;
    this.configPath = configPath;
    this.projects = new Map();
    this.configMutation = Promise.resolve();
  }

  async load() {
    let raw;
    try { raw = JSON.parse(await fs.readFile(this.configPath, "utf8")); }
    catch (error) {
      throw new TaskboardError("projects.json读取失败", {
        code: "PROJECT_CONFIG_INVALID", status: 500, details: { cause: error.message },
      });
    }
    invariant(raw?.version === 1 && Array.isArray(raw.projects), "projects.json格式版本不支持", {
      code: "PROJECT_CONFIG_INVALID", status: 500,
    });
    const next = new Map();
    for (const project of raw.projects) {
      validateId(project.id, "projectId");
      if (next.has(project.id)) throw new TaskboardError(`重复projectId: ${project.id}`, {
        code: "PROJECT_CONFIG_INVALID", status: 500,
      });
      invariant(project.registryFormatVersion === 1, "不支持的registryFormatVersion", {
        code: "FORMAT_UNSUPPORTED", status: 422, details: { projectId: project.id, registryFormatVersion: project.registryFormatVersion },
      });
      next.set(project.id, structuredClone(project));
    }
    this.projects = next;
    return this;
  }

  list() { return [...this.projects.values()].map((p) => structuredClone(p)); }

  get(projectId) {
    validateId(projectId, "projectId");
    const project = this.projects.get(projectId);
    if (!project) throw new TaskboardError(`未知项目: ${projectId}`, { code: "PROJECT_NOT_FOUND", status: 404 });
    return structuredClone(project);
  }

  workflow(projectId) {
    const project = this.get(projectId);
    return getWorkflowProfile(project.workflowProfile);
  }

  async context(projectId) {
    const project = this.get(projectId);
    const rootRealPath = await resolveProjectRoot(project.root);
    const registryPath = await resolveProjectPath(rootRealPath, project.taskRegistry, { mustExist: true, rejectReparse: true });
    return {
      project,
      rootRealPath,
      registryPath,
      adapter: getAdapter(project.adapter),
      workflow: getWorkflowProfile(project.workflowProfile),
    };
  }

  async validateProject(project) {
    const rootRealPath = await resolveProjectRoot(project.root);
    const registryPath = await resolveProjectPath(rootRealPath, project.taskRegistry, { mustExist: true, rejectReparse: true });
    const adapter = getAdapter(project.adapter);
    const workflow = getWorkflowProfile(project.workflowProfile);
    const parsed = await adapter.readMarkdownTaskRegistry(registryPath, project);
    for (const task of parsed.tasks) {
      workflow.validatePriority(task.priority);
      workflow.validateTrack(task.track);
      workflow.validateStatus(task.status);
    }
    return { rootRealPath, registryPath, taskCount: parsed.tasks.length };
  }

  async addProject(input = {}) {
    const execute = async () => {
      await this.load();
      const rootInput = String(input.root || "").trim();
      invariant(rootInput && path.isAbsolute(rootInput), "项目根目录必须填写本机绝对路径", {
        code: "INVALID_PROJECT_ROOT", status: 400, details: { root: rootInput },
      });
      const rootRealPath = await resolveProjectRoot(rootInput);
      const id = String(input.id || autoProjectId(rootRealPath)).trim();
      invariant(id, "无法从目录名自动生成项目ID，请填写项目ID", {
        code: "PROJECT_ID_REQUIRED", status: 400,
      });
      validateId(id, "projectId");
      invariant(!this.projects.has(id), `项目ID已存在: ${id}`, {
        code: "PROJECT_ALREADY_EXISTS", status: 409, details: { projectId: id },
      });
      const duplicateRoot = this.list().find((item) => comparableRoot(item.root) === comparableRoot(rootRealPath));
      invariant(!duplicateRoot, `该项目路径已登记为 ${duplicateRoot?.id || ""}`, {
        code: "PROJECT_ROOT_ALREADY_REGISTERED", status: 409,
        details: { projectId: duplicateRoot?.id, root: rootRealPath },
      });

      const project = {
        id,
        name: String(input.name || path.basename(rootRealPath) || id).trim().slice(0, 120),
        root: rootRealPath,
        adapter: "markdown-task-registry-v1",
        registryFormatVersion: 1,
        workflowProfile: "wyerp-ai-flow-v1",
        taskRegistry: String(input.taskRegistry || "待办任务总清单.md").trim(),
        resourceLedger: "任务执行与资源占用台账.md",
        checkpointDir: "任务进度断点",
        reportDir: "测试报告",
        defaultTrack: "product",
        trackOverrides: {},
      };
      invariant(project.name, "项目名称不能为空", { code: "PROJECT_NAME_REQUIRED", status: 400 });
      let validation = null;
      let adaptation = null;
      try {
        validation = await this.validateProject(project);
      } catch (error) {
        const adaptable = new Set(["FORMAT_UNSUPPORTED", "REGISTRY_PARSE_ERROR", "REGISTRY_SCHEMA_ERROR", "SOURCE_UNAVAILABLE"]);
        if (!adaptable.has(error.code)) throw error;
        adaptation = { required: true, sourceError: { code: error.code || "UNKNOWN", message: error.message } };
      }
      const storedProject = adaptation ? { ...project, onboardingStatus: "adaptation_required", adaptationError: adaptation.sourceError } : project;
      const nextConfig = { version: 1, projects: [...this.list(), storedProject] };
      await atomicWriteJson(this.configPath, nextConfig);
      await this.load();
      return {
        project: this.get(id),
        health: await this.health(id),
        validation: { taskCount: validation?.taskCount || 0, adaptationRequired: Boolean(adaptation), sourceError: adaptation?.sourceError || null },
      };
    };
    const result = this.configMutation.then(execute, execute);
    this.configMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async removeProject(projectId) {
    const execute = async () => {
      await this.load();
      const removedProject = this.get(projectId);
      const remainingProjects = this.list().filter((item) => item.id !== projectId);
      await atomicWriteJson(this.configPath, { version: 1, projects: remainingProjects });
      await this.load();
      return {
        removedProject,
        remainingProjects: remainingProjects.map((item) => ({ id: item.id, name: item.name }))
      };
    };
    const result = this.configMutation.then(execute, execute);
    this.configMutation = result.then(() => undefined, () => undefined);
    return result;
  }


  async adaptProject(projectId) {
    const execute = async () => {
      await this.load();
      const project = this.get(projectId);
      invariant(project.onboardingStatus === "adaptation_required", "项目当前不需要格式适配", {
        code: "PROJECT_ADAPTATION_NOT_REQUIRED", status: 409, details: { projectId }
      });
      const rootRealPath = await resolveProjectRoot(project.root);
      const registryPath = await resolveProjectPath(rootRealPath, project.taskRegistry, { mustExist: false, rejectReparse: true });
      const planName = "任务看板适配与计划补全计划.md";
      const planPath = await resolveProjectPath(rootRealPath, planName, { mustExist: false, rejectReparse: true });
      const ledgerPath = await resolveProjectPath(rootRealPath, project.resourceLedger, { mustExist: false, rejectReparse: true });
      const checkpointPath = await resolveProjectPath(rootRealPath, project.checkpointDir, { mustExist: false, rejectReparse: true });
      const reportPath = await resolveProjectPath(rootRealPath, project.reportDir, { mustExist: false, rejectReparse: true });

      await fs.mkdir(path.dirname(registryPath), { recursive: true });
      await fs.mkdir(checkpointPath, { recursive: true });
      await fs.mkdir(reportPath, { recursive: true });

      let existing = "";
      try { existing = await fs.readFile(registryPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
      invariant(!existing.includes("<!-- PROJECT_TASK_REGISTRY_START v1 -->"), "任务清单已含机器注册区，请先重新验证而不是重复追加", {
        code: "PROJECT_ADAPTATION_REGISTRY_EXISTS", status: 409, details: { projectId }
      });
      const eol = existing.includes("\r\n") ? "\r\n" : "\n";
      const prefix = existing && !existing.endsWith("\n") ? existing + eol + eol : existing + (existing ? eol : "");
      const registryBlock = [
        "<!-- PROJECT_TASK_REGISTRY_START v1 -->",
        "| 任务ID | 父任务/功能 | 轨道 | 优先级 | 当前阶段 | 计划角色 | 当前负责人 | 会话窗口名称 | 技术会话/尝试ID | 最近更新时间 | 准备条件与边界 | 主计划 | 关键文件/溯源 | 只读依赖 | 计划写文件 | 目标位置 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        "<!-- PROJECT_TASK_REGISTRY_END -->",
        ""
      ].join(eol);
      const adapter = getAdapter(project.adapter);
      const nextRegistry = adapter.appendRegistryTaskText(prefix + registryBlock, project, {
        id: "BOARD-PLAN-AUDIT-001",
        parent: "项目治理 / 历史功能计划补全",
        track: "infrastructure",
        priority: "P0",
        status: "待开发",
        plannedRole: "开发AI",
        boundary: "审计现有已完成功能与计划覆盖；缺计划的功能补入已有模块计划或建立专项计划；不修改业务代码",
        plan: planName,
        traceability: project.taskRegistry,
        readDependencies: "项目现有计划、说明与业务文档",
        writeTargets: planName + "；" + project.taskRegistry,
        targets: project.checkpointDir + "/BOARD-PLAN-AUDIT-001.md；" + project.reportDir + "/BOARD-PLAN-AUDIT-001/"
      }).text;
      if (existing) await atomicWriteText(registryPath, nextRegistry, sha256(existing));
      else await fs.writeFile(registryPath, nextRegistry, { encoding: "utf8", flag: "wx" });

      try { await fs.access(planPath); } catch {
        await fs.writeFile(planPath, [
          "# 任务看板适配与计划补全计划",
          "",
          "## 目标",
          "",
          "- 保留项目原有业务文档和实现，不因接入任务看板重写历史内容。",
          "- 审计已实现功能是否有主计划/专项计划；缺失项按P0治理任务补齐。",
          "- 补计划任务只补文档、溯源与任务注册，不擅自改变业务实现状态。",
          "",
          "## BOARD-PLAN-AUDIT-001",
          "",
          "- 读取现有计划、说明、任务清单和业务文档，建立“已实现功能 → 主计划/专项计划 → 关键文件”映射。",
          "- 已有模块优先补入已有计划；无匹配模块时建立新的专项计划。",
          "- 每个补齐项记录实际包含功能、关键文件、验证证据和未完成部分。",
          ""
        ].join(eol), { encoding: "utf8", flag: "wx" });
      }
      try { await fs.access(ledgerPath); } catch {
        await fs.writeFile(ledgerPath, "# 任务执行与资源占用台账" + eol + eol + "接入任务看板后由各任务按认领流程更新。" + eol, { encoding: "utf8", flag: "wx" });
      }

      const validation = await this.validateProject(project);
      const nextProjects = this.list().map((item) => {
        if (item.id !== projectId) return item;
        const copy = { ...item };
        delete copy.onboardingStatus;
        delete copy.adaptationError;
        return copy;
      });
      await atomicWriteJson(this.configPath, { version: 1, projects: nextProjects });
      await this.load();
      return { project: this.get(projectId), health: await this.health(projectId), validation: { taskCount: validation.taskCount }, createdGovernanceTaskId: "BOARD-PLAN-AUDIT-001" };
    };
    const result = this.configMutation.then(execute, execute);
    this.configMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async health(projectId) {
    const project = this.get(projectId);
    try {
      const context = await this.context(projectId);
      await context.adapter.readMarkdownTaskRegistry(context.registryPath, project);
      return { projectId, status: "healthy", writable: true };
    } catch (error) {
      const map = {
        SOURCE_UNAVAILABLE: "source_unavailable",
        FORMAT_UNSUPPORTED: "format_unsupported",
        REGISTRY_PARSE_ERROR: "read_only_blocked",
        REGISTRY_SCHEMA_ERROR: "read_only_blocked",
        REPARSE_POINT_REJECTED: "read_only_blocked",
        PROJECT_ROOT_ESCAPE: "read_only_blocked",
      };
      return {
        projectId,
        status: map[error.code] || "read_only_blocked",
        writable: false,
        error: { code: error.code || "UNKNOWN", message: error.message },
      };
    }
  }
}
