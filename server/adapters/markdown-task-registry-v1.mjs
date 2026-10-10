import fs from "node:fs/promises";
import { TaskboardError, invariant } from "../core/errors.mjs";
import { sha256 } from "../core/hash.mjs";

export const REGISTRY_START = "<!-- PROJECT_TASK_REGISTRY_START v1 -->";
export const REGISTRY_END = "<!-- PROJECT_TASK_REGISTRY_END -->";

const COLUMN_ALIASES = {
  taskId: ["任务ID"],
  parent: ["父任务/功能"],
  track: ["轨道", "track"],
  priority: ["优先级"],
  status: ["当前阶段", "状态"],
  plannedRole: ["计划角色"],
  assignee: ["当前负责人"],
  sessionWindowName: ["会话窗口名称"],
  sessionId: ["技术会话/尝试ID", "会话ID"],
  updatedAt: ["最近更新时间"],
  boundary: ["准备条件与边界"],
  plan: ["主计划", "计划"],
  traceability: ["关键文件/溯源", "关键文件 / 溯源", "关键文件"],
  readDependencies: ["只读依赖", "读取依赖"],
  writeTargets: ["计划写文件", "写文件组", "计划写入文件"],
  targets: ["目标位置（准备时创建，不是现有证据）", "目标位置"],
};

function splitMarkdownRow(line) {
  const trimmed = line.trim();
  invariant(trimmed.startsWith("|") && trimmed.endsWith("|"), "任务注册表存在非法Markdown表格行", {
    code: "REGISTRY_PARSE_ERROR", status: 422, details: { line },
  });
  const cells = [];
  let current = "", escaped = false, inCode = false;
  for (let i = 1; i < trimmed.length - 1; i++) {
    const ch = trimmed[i];
    if (escaped) { current += ch; escaped = false; continue; }
    if (ch === "\\") { current += ch; escaped = true; continue; }
    if (ch === "`") { inCode = !inCode; current += ch; continue; }
    if (ch === "|" && !inCode) { cells.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function serializeMarkdownCell(value) {
  return String(value ?? "").replace(/\r?\n/g, " ").replace(/(^|[^\\])\|/g, "$1\\|");
}
function joinMarkdownRow(cells) { return `| ${cells.map(serializeMarkdownCell).join(" | ")} |`; }
function isDivider(cells) { return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c.trim())); }
function normalizedValue(value) { const v = String(value ?? "").trim(); return v === "—" ? "" : v.replace(/\\\|/g, "|"); }
// 状态列只允许机器阶段值；若人工误把说明写成“标准状态（备注）”，读取时仅剥离括号备注。
// 真正未知的状态仍由 workflow.validateStatus 拒绝，避免容错掩盖业务错误。
function normalizedStatusValue(value) {
  const raw = normalizedValue(value);
  const decorated = raw.match(/^(.+?)\s*[（(][^（）()]+[）)]$/);
  return decorated ? decorated[1].trim() : raw;
}
function displayValue(value) { const v = String(value ?? "").trim(); return v || "—"; }
function columnIndex(headers, key) {
  for (const alias of COLUMN_ALIASES[key] || []) {
    const idx = headers.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

export function parseRegistryText(fileText, project = {}) {
  const hasBom = fileText.charCodeAt(0) === 0xfeff;
  const text = hasBom ? fileText.slice(1) : fileText;
  const start = text.indexOf(REGISTRY_START);
  const end = text.indexOf(REGISTRY_END);
  invariant(start >= 0 && end > start, "未找到PROJECT_TASK_REGISTRY v1机器边界", {
    code: "FORMAT_UNSUPPORTED", status: 422,
  });
  const blockStart = start + REGISTRY_START.length;
  const blockText = text.slice(blockStart, end);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = blockText.split(/\r?\n/);
  const rows = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim().startsWith("|") && line.trim().endsWith("|"));
  invariant(rows.length >= 2, "任务注册表表格为空", { code: "REGISTRY_PARSE_ERROR", status: 422 });
  const headers = splitMarkdownRow(rows[0].line);
  invariant(isDivider(splitMarkdownRow(rows[1].line)), "任务注册表缺少Markdown分隔行", {
    code: "REGISTRY_PARSE_ERROR", status: 422,
  });
  const indexes = Object.fromEntries(Object.keys(COLUMN_ALIASES).map((key) => [key, columnIndex(headers, key)]));
  for (const required of ["taskId","parent","priority","status","plannedRole","assignee","boundary","plan","traceability","targets"]) {
    invariant(indexes[required] >= 0, `任务注册表缺少必要列: ${required}`, {
      code: "REGISTRY_SCHEMA_ERROR", status: 422, details: { headers },
    });
  }

  const tasks = [], seen = new Set(), rowMeta = new Map();
  for (const row of rows.slice(2)) {
    const cells = splitMarkdownRow(row.line);
    invariant(cells.length === headers.length, "任务注册表列数不一致", {
      code: "REGISTRY_PARSE_ERROR", status: 422,
      details: { line: row.line, expected: headers.length, actual: cells.length },
    });
    const id = normalizedValue(cells[indexes.taskId]);
    if (!id) continue;
    if (seen.has(id)) throw new TaskboardError(`任务ID重复: ${id}`, { code: "DUPLICATE_TASK_ID", status: 422 });
    seen.add(id);
    const configuredTrack = project.trackOverrides?.[id] || project.defaultTrack || "product";
    const track = indexes.track >= 0 ? normalizedValue(cells[indexes.track]) || configuredTrack : configuredTrack;
    const task = {
      id,
      parent: normalizedValue(cells[indexes.parent]),
      track,
      priority: normalizedValue(cells[indexes.priority]),
      status: normalizedStatusValue(cells[indexes.status]),
      plannedRole: normalizedValue(cells[indexes.plannedRole]),
      assignee: normalizedValue(cells[indexes.assignee]),
      sessionWindowName: indexes.sessionWindowName >= 0 ? normalizedValue(cells[indexes.sessionWindowName]) : "",
      sessionId: indexes.sessionId >= 0 ? normalizedValue(cells[indexes.sessionId]) : "",
      updatedAt: indexes.updatedAt >= 0 ? normalizedValue(cells[indexes.updatedAt]) : "",
      boundary: normalizedValue(cells[indexes.boundary]),
      plan: normalizedValue(cells[indexes.plan]),
      traceability: normalizedValue(cells[indexes.traceability]),
      readDependencies: indexes.readDependencies >= 0 ? normalizedValue(cells[indexes.readDependencies]) : "",
      writeTargets: indexes.writeTargets >= 0 ? normalizedValue(cells[indexes.writeTargets]) : "",
      targets: normalizedValue(cells[indexes.targets]),
    };
    tasks.push(task);
    rowMeta.set(id, { lineIndex: row.index, cells });
  }
  return {
    hasBom, text, eol, start, end, blockStart, blockText, lines, headers, indexes, tasks, rowMeta,
    registryRevision: sha256(blockText), fileSha256: sha256(fileText),
  };
}

export function patchRegistryText(fileText, project, taskId, patch, workflowProfile) {
  const parsed = parseRegistryText(fileText, project);
  const meta = parsed.rowMeta.get(taskId);
  if (!meta) throw new TaskboardError(`未知任务ID: ${taskId}`, { code: "TASK_NOT_FOUND", status: 404 });
  const task = parsed.tasks.find((item) => item.id === taskId);
  if ("priority" in patch) workflowProfile.validatePriority(patch.priority);
  if ("track" in patch) workflowProfile.validateTrack(patch.track);
  if ("status" in patch) workflowProfile.assertTransition(task.status, patch.status);

  const allowed = ["track","priority","status","plannedRole","assignee","sessionWindowName","sessionId","writeTargets","updatedAt"];
  const nextCells = [...meta.cells];
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) throw new TaskboardError(`不允许修改字段: ${key}`, { code: "FIELD_NOT_WRITABLE", status: 400 });
    const idx = parsed.indexes[key];
    if (idx < 0) throw new TaskboardError(`注册表未启用可写列: ${key}`, {
      code: "REGISTRY_SCHEMA_ERROR", status: 422, details: { key },
    });
    nextCells[idx] = displayValue(value);
  }
  const nextLines = [...parsed.lines];
  nextLines[meta.lineIndex] = joinMarkdownRow(nextCells);
  const nextBlock = nextLines.join(parsed.eol);
  const nextTextNoBom = parsed.text.slice(0, parsed.blockStart) + nextBlock + parsed.text.slice(parsed.end);
  const finalText = parsed.hasBom ? "\ufeff" + nextTextNoBom : nextTextNoBom;
  const nextParsed = parseRegistryText(finalText, project);
  return {
    text: finalText,
    before: task,
    after: nextParsed.tasks.find((item) => item.id === taskId),
    beforeRevision: parsed.registryRevision,
    afterRevision: nextParsed.registryRevision,
    beforeFileSha256: parsed.fileSha256,
    afterFileSha256: nextParsed.fileSha256,
  };
}

export function appendRegistryTaskText(fileText, project, taskInput) {
  const parsed = parseRegistryText(fileText, project);
  const id = normalizedValue(taskInput?.id);
  if (!id) throw new TaskboardError("新增任务缺少任务ID", { code: "TASK_ID_REQUIRED", status: 400 });
  if (parsed.rowMeta.has(id)) throw new TaskboardError(`任务ID重复: ${id}`, { code: "DUPLICATE_TASK_ID", status: 409 });
  const values = {
    taskId: id,
    parent: taskInput.parent,
    track: taskInput.track || project.defaultTrack || "product",
    priority: taskInput.priority,
    status: taskInput.status,
    plannedRole: taskInput.plannedRole,
    assignee: taskInput.assignee,
    sessionWindowName: taskInput.sessionWindowName,
    sessionId: taskInput.sessionId,
    updatedAt: taskInput.updatedAt,
    boundary: taskInput.boundary,
    plan: taskInput.plan,
    traceability: taskInput.traceability,
    readDependencies: taskInput.readDependencies,
    writeTargets: taskInput.writeTargets,
    targets: taskInput.targets,
  };
  const nextCells = parsed.headers.map(() => "—");
  for (const [key, value] of Object.entries(values)) {
    const idx = parsed.indexes[key];
    if (idx >= 0) nextCells[idx] = displayValue(value);
  }
  invariant(nextCells.length === parsed.headers.length, "新增任务序列化列数不一致", {
    code: "REGISTRY_SCHEMA_ERROR", status: 422,
    details: { expected: parsed.headers.length, actual: nextCells.length, taskId: id },
  });
  const nextLines = [...parsed.lines];
  let insertAt = nextLines.length;
  while (insertAt > 0 && !nextLines[insertAt - 1].trim()) insertAt -= 1;
  nextLines.splice(insertAt, 0, joinMarkdownRow(nextCells));
  const nextBlock = nextLines.join(parsed.eol);
  const nextTextNoBom = parsed.text.slice(0, parsed.blockStart) + nextBlock + parsed.text.slice(parsed.end);
  const finalText = parsed.hasBom ? "\ufeff" + nextTextNoBom : nextTextNoBom;
  const nextParsed = parseRegistryText(finalText, project);
  const added = nextParsed.tasks.find((task) => task.id === id);
  invariant(Boolean(added), "新增任务写入后未能重新解析", {
    code: "REGISTRY_PARSE_ERROR", status: 422, details: { taskId: id },
  });
  return {
    text: finalText, task: added,
    beforeRevision: parsed.registryRevision, afterRevision: nextParsed.registryRevision,
    beforeFileSha256: parsed.fileSha256, afterFileSha256: nextParsed.fileSha256,
  };
}
export async function readMarkdownTaskRegistry(filePath, project) {
  return parseRegistryText(await fs.readFile(filePath, "utf8"), project);
}
