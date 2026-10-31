import { TaskboardError } from "./core/errors.mjs";
import { WindowsMcpClient } from "./windows-mcp-client.mjs";
import { AutomationControlStore } from "./automation-control.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

const SNAPSHOT_ARGS = Object.freeze({
  use_vision: false,
  use_dom: false,
  use_annotation: true,
  use_ui_tree: true
});

const SIDE_EFFECT_TOOLS = new Set(["App", "Click", "Type", "Shortcut"]);

const ACTION_META = Object.freeze({
  new_chat: { kind: "chatgpt_new_chat", summary: "点击 ChatGPT 新建聊天" },
  navigate_session: { kind: "chatgpt_navigate_session", summary: "切换到已有 ChatGPT 角色会话" },
  send_candidate: { kind: "chatgpt_send_candidate", summary: "向 ChatGPT 发送候选任务" },
  stop_and_continue: { kind: "chatgpt_stop_and_continue", summary: "停止当前生成并发送“继续”" },
  retry_or_continue: { kind: "chatgpt_error_recovery", summary: "处理 ChatGPT 执行异常（重试或继续）" },
  refresh_last_resort: { kind: "chatgpt_refresh_last_resort", summary: "刷新当前 ChatGPT 页面（最后手段）" }
});
function classifyExecutionFailure(error) {
  const errorCode = String(error?.code || "");
  const errorMessage = String(error?.message || error || "");
  const safetyBlocked = /safety|security check|blocked by|safety check|policy block|安全|阻止/i.test(errorCode + " " + errorMessage);
  return {
    result: safetyBlocked ? "safety_blocked" : "failed",
    error_source: safetyBlocked ? "platform_safety" : "mcp_execution",
    error_code: errorCode || null,
    error_message: errorMessage.slice(0, 500)
  };
}


function flattenSnapshotText(result) {
  const raw = (Array.isArray(result?.content) ? result.content : [])
    .filter(part => part?.type === "text")
    .map(part => String(part.text || ""))
    .join("\n");
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(value => String(value || "")).join("\n");
  } catch { /* LOG-IGNORE: snapshot text may be plain text instead of JSON */ }
  return raw;
}

export function parseSnapshotNodes(text) {
  const nodes = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/\((\d+),(\d+)\)\s+([^\s"]+)\s+"([^"]+)"(.*)$/);
    if (!match) continue;
    nodes.push({
      x: Number(match[1]),
      y: Number(match[2]),
      role: match[3],
      name: match[4],
      tail: match[5] || "",
      line
    });
  }
  return nodes;
}

function focusedWindowName(text) {
  const lines = String(text || "").split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "Focused Window:");
  if (start < 0) return null;
  for (let i = start + 1; i < Math.min(lines.length, start + 8); i += 1) {
    const line = lines[i];
    const match = line.match(/^(.*?)\s{2,}\d+\s{2,}(?:Maximized|Minimized|Normal)/);
    if (match && match[1].trim() && match[1].trim() !== "Name") return match[1].trim();
  }
  return null;
}

function chatWindowName(text) {
  const lines = String(text || "").split(/\r?\n/);
  let currentWindow = null;
  for (const line of lines) {
    const windowMatch = line.match(/window\s+"([^"]*)"/);
    if (windowMatch) currentWindow = windowMatch[1];
    if (currentWindow && /\[value:"https:\/\/chatgpt\.com(?:\/|")/i.test(line)) return currentWindow;
  }
  return null;
}

function exactName(node, names) {
  return names.some(name => node.name.toLowerCase() === name.toLowerCase());
}

function findNode(text, { roles = [], names = [], namePattern = null, focused = false } = {}) {
  const nodes = parseSnapshotNodes(text);
  return nodes.find(node => {
    if (roles.length && !roles.some(role => String(node.role).toLowerCase().includes(String(role).toLowerCase()))) return false;
    if (names.length && !exactName(node, names)) return false;
    if (namePattern && !namePattern.test(node.name)) return false;
    if (focused && !/\[focused\]/i.test(node.tail)) return false;
    return true;
  }) || null;
}

export function buildCandidatePrompt({
  candidate = {},
  role = null,
  request_count = 1,
  execution_settings = {},
  extension_version = "unknown",
  extension_latest_version = "unknown",
  taskboard_version = "unknown",
  recovery_after_timeout = false
} = {}) {
  const maxRequests = Math.max(1, Number(execution_settings.max_requests_per_chat || 20));
  const warningAt = Math.max(1, Math.min(maxRequests, Number(execution_settings.context_warning_at || 15)));
  const count = Math.max(1, Math.min(maxRequests, Number(request_count || 1)));
  const targetRole = String(role || candidate.eligible_role || "");
  const required = targetRole === "test_ai" ? execution_settings.test : execution_settings.developer;
  const warning = count >= warningAt ? "context_warning=" + count + "/" + maxRequests : null;
  const isWyerpTaskboard = String(candidate.project_id || "") === "wyerp-taskboard";
  const roleDoc = targetRole === "test_ai"
    ? (isWyerpTaskboard ? "docs/governance/测试AI工作规范.md" : "当前项目AGENTS指定的测试AI工作规范")
    : (isWyerpTaskboard ? "docs/governance/开发AI工作规范.md" : "当前项目AGENTS指定的开发AI工作规范");
  const roleGate = targetRole === "test_ai"
    ? "角色门禁：开始测试前必须实际阅读测试AI工作规范，并核对固定被测版本及最后一次代码修改之后的开发自测证据；缺证据进入待准备/补证据，不得替开发改业务代码或补开发自测后冒充开发证据。"
    : "角色门禁：第一次代码写入前必须实际阅读开发AI工作规范；每完成一个成功逻辑代码修改事务/可验证代码批次后立即执行相关开发自测。自测失败必须继续修复或登记真实阻断；最后一次代码修改之后没有有效自测证据时，禁止taskctl complete、禁止进入待独测/待复测、禁止宣称开发完成。";
  const requiredActorId = String(candidate.eligible_actor_id || "");
  const requiredSessionId = String(candidate.eligible_session_id || "");
  const deliveryIdentityGate = requiredActorId || requiredSessionId
    ? "交付身份门禁：此候选只允许原开发AI认领。required_actor_id和required_session_id必须同时与当前WebCodex实际actor-id及Session ID完全一致；不得把候选提供的值冒充为自己的身份。任一不一致或无法确认，禁止claim，保留任务给原开发会话。"
    : null;
  return [
    "WyerpTaskboard candidate_ready",
    "project_id=" + candidate.project_id,
    "task_id=" + candidate.task_id,
    "detection_id=" + candidate.detection_id,
    "eligible_role=" + candidate.eligible_role,
    "required_actor_id=" + (requiredActorId || "none"),
    "required_session_id=" + (requiredSessionId || "none"),
    "chat_role=" + targetRole,
    "chat_request=" + count + "/" + maxRequests,
    "required_model=" + String(required?.model || "unspecified"),
    "required_reasoning_effort=" + String(required?.reasoning_effort || "unspecified"),
    "extension_version=" + String(extension_version || "unknown"),
    "extension_latest_version=" + String(extension_latest_version || "unknown"),
    "taskboard_version=" + String(taskboard_version || "unknown"),
    "role_governance=" + roleDoc,
    roleGate,
    deliveryIdentityGate,
    warning,
    recovery_after_timeout ? "timeout_takeover_authorized=1" : null,
    recovery_after_timeout
      ? "这是超时后的新会话恢复：用户已授权因连续超时切换会话。请用WebCodex重新核对原任务claim、所有权、guard和断点；若仍属于当前ChatGPT角色则继续原任务，不要重新创建平行任务。"
      : null,
    "请先核对当前聊天实际模型和推理强度是否满足required_model/required_reasoning_effort；不满足则不要claim，并提示用户手动切换。版本只做各自项目内核对：extension_version必须等于extension_latest_version；taskboard_version由当前看板服务自身package版本提供。扩展版与看板版允许不同，不得因二者不同停止。然后使用WebCodex核对当前项目真值、用户留言、guard、资源冲突和角色资格；满足条件后继续执行，不要仅总结。无人值守交接规则：developer_ai完成实现、自测和开发报告后必须调用taskctl complete，由服务端原子切到待独测/待复测并释放开发占用；test_ai完成独测/复测报告后必须沿用正式claim时相同的--actor-id和--session-id调用taskctl test-result --result pass|fail|blocked，由服务端原子回流开发或进入待交付并释放测试占用；若delivery-actions包含candidate_merge，必须同时传--commit-sha和--branch，把独测PASS绑定到实际测试的唯一候选提交。待交付候选会携带required_actor_id和required_session_id，只有原开发AI在原Session中才能认领，不匹配不得尝试或伪造身份；认领后进入交付中。必须把独测PASS绑定的candidate_merge提交合入origin默认分支并推送，切回默认分支确认本地HEAD与远端SHA完全一致，完成合并后回归并生成包含“结论：PASS”、候选SHA和main SHA的报告，最后必须使用原actor-id和当前交付claim的原session-id调用taskctl complete --actor-id 原actor --session-id 原Session --report 报告路径，自动核验Git与报告并关闭任务。任何merge/push/remote_sync/regression/report/verification失败，都必须调用taskctl delivery-failed登记failure-stage、failure-code、note和next-action；不得只在聊天里汇报或让任务无错误信息地停在交付中。交付中禁止手动transition到待用户验收/已完成；不得长期停留交付中。独测PASS后若发生代码修改，必须重新独测。禁止再用手工transition+release代替原子流程。"
  ].filter(Boolean).join(" | ");
}

export class ChatgptMcpExecutor {
  constructor(rootDir, {
    automationControl = null,
    mcpClientFactory = null,
    systemEventLog = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = {}) {
    this.rootDir = rootDir;
    this.automationControl = automationControl;
    this.mcpClientFactory = mcpClientFactory;
    this.systemEventLog = systemEventLog;
    this.sleep = sleep;
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    this.automationControl ||= await new AutomationControlStore(this.rootDir).init({ resetLifecycle: false });
    this.mcpClientFactory ||= async () => new WindowsMcpClient(this.rootDir, { automationControl: this.automationControl, systemEventLog: this.systemEventLog }).init();
    return this;
  }

  actionFingerprint(action, body) {
    const stableKey = body?.detection_id || body?.candidate?.detection_id || body?.target_url ||
      body?.conversation_url || body?.task_id || "current";
    const attempt = Number(body?.attempt || 0);
    return ["chatgpt-mcp", action, stableKey, attempt].join(":");
  }

  approvalDetails(action, body) {
    return {
      action,
      project_id: body?.project_id || body?.candidate?.project_id || null,
      task_id: body?.task_id || body?.candidate?.task_id || null,
      detection_id: body?.detection_id || body?.candidate?.detection_id || null,
      role: body?.role || body?.candidate?.eligible_role || null,
      conversation_url: body?.conversation_url || null,
      target_url: body?.target_url || null,
      attempt: Number(body?.attempt || 0) || null
    };
  }

  async snapshot(client) {
    return flattenSnapshotText(await client.callTool("Snapshot", SNAPSHOT_ARGS));
  }

  async mcpTool(client, name, args, actionFingerprint) {
    if (SIDE_EFFECT_TOOLS.has(name)) {
      await this.automationControl.issueInputLease({ kind: name, action_fingerprint: actionFingerprint });
    }
    return client.callTool(name, args);
  }

  async ensureChatFocused(client, snapshot, actionFingerprint, preferredTitle = null) {
    let text = snapshot;
    const focused = focusedWindowName(text);
    const detectedChatWindow = chatWindowName(text);
    const target = preferredTitle || detectedChatWindow;
    if (!target) throw new TaskboardError("MCP未找到ChatGPT窗口", {
      code: "CHATGPT_MCP_WINDOW_NOT_FOUND", status: 409
    });
    if (focused !== target) {
      await this.mcpTool(client, "App", { mode: "switch", name: target }, actionFingerprint);
      await this.sleep(300);
      text = await this.snapshot(client);
    }
    if (!/https:\/\/chatgpt\.com/i.test(text)) throw new TaskboardError("MCP切换后未确认ChatGPT页面", {
      code: "CHATGPT_MCP_FOCUS_VERIFY_FAILED", status: 409, details: { target }
    });
    return text;
  }

  async clickNamed(client, text, spec, actionFingerprint, errorCode) {
    const node = findNode(text, spec);
    if (!node) throw new TaskboardError("MCP未找到目标控件", {
      code: errorCode, status: 409, details: { names: spec.names || null, pattern: String(spec.namePattern || "") }
    });
    await this.mcpTool(client, "Click", { loc: [node.x, node.y], button: "left", clicks: 1 }, actionFingerprint);
    return node;
  }

  async sendText(client, text, actionFingerprint) {
    let snapshot = await this.snapshot(client);
    const composer = findNode(snapshot, {
      roles: ["编辑", "edit"],
      names: ["询问 ChatGPT", "Ask ChatGPT", "Message ChatGPT"]
    });
    if (!composer) throw new TaskboardError("MCP未找到ChatGPT输入框", {
      code: "CHATGPT_MCP_COMPOSER_NOT_FOUND", status: 409
    });
    await this.mcpTool(client, "Type", {
      loc: [composer.x, composer.y],
      text,
      clear: true,
      caret_position: "end",
      press_enter: false
    }, actionFingerprint);
    await this.sleep(250);
    snapshot = await this.snapshot(client);
    await this.clickNamed(client, snapshot, {
      roles: ["按钮", "button"],
      names: ["发送", "Send"]
    }, actionFingerprint, "CHATGPT_MCP_SEND_NOT_FOUND");
  }

  async execute(body = {}) {
    const action = String(body.action || "");
    const meta = ACTION_META[action];
    if (!meta) throw new TaskboardError("不支持的ChatGPT MCP动作", {
      code: "CHATGPT_MCP_ACTION_UNSUPPORTED", status: 400, details: { action }
    });
    if (action === "refresh_last_resort" && body.recovery_exhausted !== true) {
      throw new TaskboardError("刷新仅允许作为恢复耗尽后的最后手段", {
        code: "CHATGPT_MCP_REFRESH_EVIDENCE_REQUIRED", status: 409
      });
    }
    const actionFingerprint = this.actionFingerprint(action, body);
    const permission = await this.automationControl.requestAction({
      source: "chatgpt-mcp-executor",
      kind: meta.kind,
      summary: meta.summary,
      details: this.approvalDetails(action, body),
      action_fingerprint: actionFingerprint
    });
    if (!permission.allowed) return {
      ok: false,
      executed: false,
      action,
      ...permission
    };

    const client = await this.mcpClientFactory();
    try {
      let snapshot = await this.snapshot(client);
      snapshot = await this.ensureChatFocused(client, snapshot, actionFingerprint, body.window_title || null);

      if (action === "new_chat") {
        await this.clickNamed(client, snapshot, {
          roles: ["按钮", "button"],
          names: ["新聊天", "New chat"]
        }, actionFingerprint, "CHATGPT_MCP_NEW_CHAT_NOT_FOUND");
      } else if (action === "navigate_session") {
        const targetUrl = String(body.target_url || "");
        if (!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+/i.test(targetUrl)) {
          throw new TaskboardError("目标ChatGPT会话URL无效", {
            code: "CHATGPT_MCP_TARGET_URL_INVALID", status: 400
          });
        }
        await this.mcpTool(client, "Shortcut", { shortcut: "ctrl+l" }, actionFingerprint);
        await this.sleep(200);
        snapshot = await this.snapshot(client);
        const address = findNode(snapshot, {
          roles: ["编辑", "edit"],
          namePattern: /地址和搜索栏|Address and search bar|搜索 Google 或输入网址|Search Google or type a URL/i
        }) || findNode(snapshot, { roles: ["编辑", "edit"], focused: true });
        if (!address) throw new TaskboardError("MCP未找到Chrome地址栏", {
          code: "CHATGPT_MCP_ADDRESS_BAR_NOT_FOUND", status: 409
        });
        await this.mcpTool(client, "Type", {
          loc: [address.x, address.y],
          text: targetUrl,
          clear: true,
          caret_position: "end",
          press_enter: true
        }, actionFingerprint);
      } else if (action === "send_candidate") {
        const prompt = String(body.prompt || buildCandidatePrompt(body));
        if (!prompt.trim()) throw new TaskboardError("候选任务Prompt为空", {
          code: "CHATGPT_MCP_PROMPT_EMPTY", status: 400
        });
        await this.sendText(client, prompt, actionFingerprint);
      } else if (action === "stop_and_continue") {
        await this.clickNamed(client, snapshot, {
          roles: ["按钮", "button"],
          namePattern: /^(停止|停止生成|停止响应|Stop|Stop generating)$/i
        }, actionFingerprint, "CHATGPT_MCP_STOP_NOT_FOUND");
        await this.sleep(800);
        await this.sendText(client, "继续", actionFingerprint);
      } else if (action === "retry_or_continue") {
        const retry = findNode(snapshot, {
          roles: ["按钮", "button"],
          namePattern: /^(retry|重试|再试一次|重新生成|continue|继续)$/i
        });
        if (retry) {
          await this.mcpTool(client, "Click", { loc: [retry.x, retry.y], button: "left", clicks: 1 }, actionFingerprint);
        } else {
          await this.sendText(client, "继续", actionFingerprint);
        }
      } else if (action === "refresh_last_resort") {
        await this.mcpTool(client, "Shortcut", { shortcut: "ctrl+r" }, actionFingerprint);
      }

      await this.automationControl.finishExecution({
        action_fingerprint: actionFingerprint,
        trace_id: permission.trace_id || null,
        result: "succeeded"
      });
      return {
        ok: true,
        executed: true,
        action,
        mode: permission.mode || null,
        approval_id: permission.approval_id || null,
        trace_id: permission.trace_id || null,
        action_fingerprint: actionFingerprint
      };
    } catch (error) {
      const failure = classifyExecutionFailure(error);
      await this.automationControl.finishExecution({
        action_fingerprint: actionFingerprint,
        trace_id: permission.trace_id || null,
        ...failure
      }).catch(async finishError => {
        await this.systemEventLog?.error("chatgpt-mcp-executor", "execution_finalize_log_failed", finishError, {
          action,
          trace_id: permission.trace_id || null,
          action_fingerprint: actionFingerprint,
          original_result: failure.result,
          original_error_source: failure.error_source,
          original_error_code: failure.error_code
        });
      });
      await this.systemEventLog?.append({
        level: "error",
        component: "chatgpt-mcp-executor",
        event: failure.result === "safety_blocked" ? "execution_safety_blocked" : "execution_failed",
        trace_id: permission.trace_id || null,
        action_fingerprint: actionFingerprint,
        operation: action,
        result: failure.result,
        error_source: failure.error_source,
        error_code: failure.error_code,
        error_message: failure.error_message,
        details: this.approvalDetails(action, body)
      });
      throw error;
    }
  }
}
