import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { TaskboardError } from "./core/errors.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const SIDE_EFFECT_TOOLS = new Set(["Move", "Click", "Type", "Shortcut", "App"]);

function within(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function textContent(result) {
  return (result?.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
}

function cursorFromSnapshot(result) {
  const match = textContent(result).match(/Cursor Position:\s*\((-?\d+),\s*(-?\d+)\)/i);
  if (!match) throw new TaskboardError("Windows-MCP快照中没有鼠标位置", {
    code: "WINDOWS_MCP_CURSOR_NOT_FOUND", status: 502
  });
  return { x: Number(match[1]), y: Number(match[2]) };
}

function summarizeToolArgs(name, args = {}) {
  const summary = {};
  if (Array.isArray(args.loc)) summary.loc = args.loc.slice(0, 2).map(Number);
  if (args.shortcut) summary.shortcut = String(args.shortcut);
  if (args.name) summary.name = String(args.name).slice(0, 200);
  if (typeof args.text === "string") summary.text_length = args.text.length;
  if (args.clear != null) summary.clear = Boolean(args.clear);
  if (args.press_enter != null) summary.press_enter = Boolean(args.press_enter);
  if (args.button) summary.button = String(args.button);
  if (args.clicks != null) summary.clicks = Number(args.clicks);
  if (name === "Snapshot") {
    summary.use_vision = Boolean(args.use_vision);
    summary.use_dom = Boolean(args.use_dom);
    summary.use_ui_tree = Boolean(args.use_ui_tree);
  }
  return summary;
}

class McpStdioSession {
  constructor({ executable, args, cwd, protocolVersion, timeoutMs, clientVersion = "unknown", env = process.env }) {
    this.executable = executable;
    this.args = args;
    this.cwd = cwd;
    this.protocolVersion = protocolVersion;
    this.timeoutMs = timeoutMs;
    this.clientVersion = clientVersion;
    this.env = env;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
  }

  async start() {
    this.child = spawn(this.executable, this.args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        this.failAll(new Error("Windows-MCP进程提前退出 code=" + code + " signal=" + signal + " stderr=" + this.stderr.slice(-1200)));
      }
    });

    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on("line", (line) => this.onLine(line));

    const initialized = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "wyerp-taskboard", version: this.clientVersion }
    });
    this.notify("notifications/initialized", {});
    return initialized;
  }

  onLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); }
    catch { return; }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result);
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Windows-MCP stdio不可写");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Windows-MCP请求超时: " + method));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    this.closed = true;
    this.lines?.close();
    if (this.child?.stdin?.writable) this.child.stdin.end();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

export class WindowsMcpClient {
  constructor(rootDir, { configPath = null, automationControl = null, systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.configPath = configPath || path.join(rootDir, "config", "windows-mcp.json");
    this.automationControl = automationControl;
    this.systemEventLog = systemEventLog;
  }

  async requireAutomationApproval(kind, summary, details = null) {
    if (!this.automationControl) throw new TaskboardError("自动化总控未连接，拒绝副作用操作", {
      code: "AUTOMATION_CONTROL_UNAVAILABLE", status: 503, details: { kind }
    });
    const result = await this.automationControl.requestAction({
      source: "windows-mcp",
      kind,
      summary,
      details
    });
    if (!result.allowed) throw new TaskboardError(
      result.state === "approval_required" ? "自动化操作等待用户确认" : "自动化总控当前禁止执行",
      {
        code: result.state === "approval_required" ? "AUTOMATION_APPROVAL_REQUIRED" : "AUTOMATION_CONTROL_BLOCKED",
        status: 409,
        details: result
      }
    );
    return result;
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    } catch (error) {
      await this.systemEventLog.error("windows-mcp", "config_load_failed", error, { config_path: this.configPath });
      throw error;
    }
    if (raw?.version !== 1) throw new TaskboardError("Windows-MCP配置版本不支持", {
      code: "WINDOWS_MCP_CONFIG_VERSION", status: 500
    });
    if (raw.transport !== "stdio") throw new TaskboardError("Windows-MCP只允许本机stdio传输", {
      code: "WINDOWS_MCP_TRANSPORT_FORBIDDEN", status: 500
    });

    const sourceRoot = path.resolve(String(raw.source_root || ""));
    const executable = path.resolve(sourceRoot, String(raw.executable || ""));
    const sourceReal = await fs.realpath(sourceRoot);
    const executableReal = await fs.realpath(executable);
    if (!within(sourceReal, executableReal)) throw new TaskboardError("Windows-MCP可执行文件越出源码根", {
      code: "WINDOWS_MCP_PATH_ESCAPE", status: 500
    });

    const pkg = JSON.parse(await fs.readFile(path.join(this.rootDir, "package.json"), "utf8"));
    this.config = {
      ...raw,
      enabled: raw.enabled !== false,
      sourceRoot: sourceReal,
      executable: executableReal,
      args: Array.isArray(raw.args) ? raw.args.map(String) : ["serve", "--transport", "stdio"],
      allowedTools: new Set(Array.isArray(raw.allowed_tools) ? raw.allowed_tools.map(String) : []),
      forbiddenShortcuts: new Set((Array.isArray(raw.forbidden_shortcuts) ? raw.forbidden_shortcuts : []).map(value => String(value).toLowerCase().replace(/\s+/g, ""))),
      clientVersion: String(pkg.version || "unknown"),
      protocolVersion: String(raw.protocol_version || DEFAULT_PROTOCOL_VERSION),
      timeoutMs: Math.max(1000, Math.min(60000, Number(raw.request_timeout_ms || 15000)))
    };
    return this;
  }

  ensureEnabled() {
    if (!this.config?.enabled) throw new TaskboardError("Windows-MCP已停用", {
      code: "WINDOWS_MCP_DISABLED", status: 503
    });
  }

  async withSession(fn) {
    this.ensureEnabled();
    const session = new McpStdioSession({
      executable: this.config.executable,
      args: this.config.args,
      cwd: this.config.sourceRoot,
      protocolVersion: this.config.protocolVersion,
      timeoutMs: this.config.timeoutMs,
      clientVersion: this.config.clientVersion
    });
    try {
      const initialize = await session.start();
      return await fn(session, initialize);
    } catch (error) {
      await this.systemEventLog?.error("windows-mcp", "session_failed", error, {
        executable: this.config.executable,
        transport: this.config.transport,
        protocol_version: this.config.protocolVersion
      });
      throw error;
    } finally {
      await session.close().catch(error => {
        void this.systemEventLog?.error("windows-mcp", "session_close_failed", error, {});
      });
    }
  }

  async listTools() {
    return this.withSession(async (session, initialize) => {
      const result = await session.request("tools/list", {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      return {
        server: initialize?.serverInfo || null,
        protocolVersion: initialize?.protocolVersion || this.config.protocolVersion,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description || "",
          allowed: this.config.allowedTools.has(tool.name)
        }))
      };
    });
  }

  async callTool(name, args = {}, { approvalScope = null, approvalSummary = null } = {}) {
    const details = { tool: name, args: summarizeToolArgs(name, args), approval_scope: approvalScope || null };
    await this.systemEventLog?.append({ component: "windows-mcp", event: "tool_call_started", operation: name, details });
    try {
      this.ensureEnabled();
      if (!this.config.allowedTools.has(name)) throw new TaskboardError("Windows-MCP工具未在任务看板白名单", {
        code: "WINDOWS_MCP_TOOL_FORBIDDEN", status: 403, details: { tool: name }
      });
      if (name === "Shortcut") {
        const shortcut = String(args?.shortcut || "").toLowerCase().replace(/\s+/g, "");
        if (this.config.forbiddenShortcuts.has(shortcut)) throw new TaskboardError("禁止用新标签页/新窗口代替ChatGPT会话切换", {
          code: "WINDOWS_MCP_SHORTCUT_FORBIDDEN", status: 403, details: { shortcut }
        });
      }
      if (approvalScope === "chatgpt" && SIDE_EFFECT_TOOLS.has(name)) {
        await this.requireAutomationApproval(
          name,
          String(approvalSummary || `ChatGPT 操作：${name}`),
          { ...args, approval_scope: "chatgpt" }
        );
      }
      const result = await this.withSession(async (session) => {
        const value = await session.request("tools/call", { name, arguments: args });
        if (value?.isError) throw new TaskboardError("Windows-MCP工具执行失败", {
          code: "WINDOWS_MCP_TOOL_FAILED", status: 502, details: { tool: name, result: value }
        });
        return value;
      });
      await this.systemEventLog?.append({ component: "windows-mcp", event: "tool_call_succeeded", operation: name, result: "succeeded", details });
      return result;
    } catch (error) {
      await this.systemEventLog?.error("windows-mcp", "tool_call_failed", error, details);
      throw error;
    }
  }

  async status() {
    const info = await this.listTools();
    return {
      enabled: this.config.enabled,
      transport: "stdio",
      sourceRoot: this.config.sourceRoot,
      executable: this.config.executable,
      server: info.server,
      protocolVersion: info.protocolVersion,
      toolCount: info.tools.length,
      allowedAvailable: info.tools.filter((tool) => tool.allowed).map((tool) => tool.name)
    };
  }

  async smokeCursorControl() {
    return this.withSession(async (session, initialize) => {
      const listed = await session.request("tools/list", {});
      const names = new Set((listed?.tools || []).map((tool) => tool.name));
      for (const required of ["Snapshot", "Move"]) {
        if (!names.has(required) || !this.config.allowedTools.has(required)) {
          throw new TaskboardError("Windows-MCP缺少烟测工具: " + required, {
            code: "WINDOWS_MCP_SMOKE_TOOL_MISSING", status: 502
          });
        }
      }

      const snapshotArgs = { use_vision: false, use_dom: false, use_annotation: true, use_ui_tree: true };
      const beforeResult = await session.request("tools/call", { name: "Snapshot", arguments: snapshotArgs });
      if (beforeResult?.isError) throw new Error("Snapshot before failed");
      const before = cursorFromSnapshot(beforeResult);
      const target = {
        x: before.x >= 100 ? before.x - 40 : before.x + 40,
        y: before.y >= 100 ? before.y - 40 : before.y + 40
      };

      let after = null;
      let restored = null;
      try {
        const moved = await session.request("tools/call", { name: "Move", arguments: { loc: [target.x, target.y] } });
        if (moved?.isError) throw new Error("Move failed");
        await new Promise((resolve) => setTimeout(resolve, 250));
        const afterResult = await session.request("tools/call", { name: "Snapshot", arguments: snapshotArgs });
        after = cursorFromSnapshot(afterResult);
      } finally {
        await session.request("tools/call", { name: "Move", arguments: { loc: [before.x, before.y] } }).catch(error => {
          void this.systemEventLog?.error("windows-mcp", "smoke_cursor_restore_failed", error, { target: before });
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        const restoredResult = await session.request("tools/call", { name: "Snapshot", arguments: snapshotArgs }).catch(error => {
          void this.systemEventLog?.error("windows-mcp", "smoke_restore_snapshot_failed", error, {});
          return null;
        });
        if (restoredResult) restored = cursorFromSnapshot(restoredResult);
      }

      return {
        ok: Boolean(after && after.x === target.x && after.y === target.y && restored && restored.x === before.x && restored.y === before.y),
        server: initialize?.serverInfo || null,
        before,
        target,
        after,
        restored
      };
    });
  }
}

export { cursorFromSnapshot, textContent };
