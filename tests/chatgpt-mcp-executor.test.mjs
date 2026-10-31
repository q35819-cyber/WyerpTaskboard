import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ChatgptMcpExecutor, buildCandidatePrompt, parseSnapshotNodes } from "../server/chatgpt-mcp-executor.mjs";

function snapshot({ extra = "", focused = "全局插件方案 - Google Chrome" } = {}) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify([[
        "Focused Window:",
        "Name                      Depth  Status       Width    Height    Handle",
        "----------------------  -------  ---------  -------  --------  --------",
        focused + "        0  Maximized     1936      1066    262790",
        "",
        "UI Tree:",
        "desktop",
        '├── window "全局插件方案 - Google Chrome"',
        '│   ├── (960,585) 文档 "全局插件方案"  [action: click]  [value:"https://chatgpt.com/c/test-chat"]',
        '│   ├── (170,198) 按钮 "新聊天"  [action: click]',
        '│   ├── (1076,1000) 编辑 "询问 ChatGPT"  [action: click]  [value:"询问 ChatGPT"]',
        extra
      ].filter(Boolean).join("\n")])
    }]
  };
}

function harness({ allowed = true, snapshots = [], failTool = null } = {}) {
  const calls = [];
  const leases = [];
  const finishes = [];
  const automationControl = {
    requestAction: async action => allowed
      ? { allowed: true, state: "allowed", mode: "approved_once", approval_id: "approval-1", trace_id: "trace-1", action_fingerprint: action.action_fingerprint }
      : { allowed: false, state: "approval_required", approval_id: "approval-1", trace_id: "trace-1", action_fingerprint: action.action_fingerprint },
    issueInputLease: async value => { leases.push(value); return value; },
    finishExecution: async value => { finishes.push(value); return value; }
  };
  let snapshotIndex = 0;
  const client = {
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === "Snapshot") return snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] || snapshot();
      if (name === failTool) throw new Error("blocked by safety check");
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }
  };
  return { automationControl, client, calls, leases, finishes };
}

test("snapshot parser extracts dynamic UI coordinates", () => {
  const nodes = parseSnapshotNodes('(170,198) 按钮 "新聊天"  [action: click]\n(1076,1000) 编辑 "询问 ChatGPT"');
  assert.deepEqual(nodes.map(node => [node.x, node.y, node.role, node.name]), [
    [170, 198, "按钮", "新聊天"],
    [1076, 1000, "编辑", "询问 ChatGPT"]
  ]);
});

test("MCP new_chat asks approval before any side effect", async () => {
  const h = harness({ allowed: false, snapshots: [snapshot()] });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client
  }).init();
  const result = await executor.execute({ action: "new_chat", detection_id: "det-1" });
  assert.equal(result.executed, false);
  assert.deepEqual(h.calls, []);
});

test("MCP new_chat locates current UI and clicks only the dynamic new-chat coordinate", async () => {
  const h = harness({ snapshots: [snapshot()] });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client
  }).init();
  const result = await executor.execute({ action: "new_chat", detection_id: "det-1" });
  assert.equal(result.executed, true);
  assert.deepEqual(h.calls.map(([name]) => name), ["Snapshot", "Click"]);
  assert.deepEqual(h.calls[1][1].loc, [170, 198]);
  assert.equal(h.leases[0].kind, "Click");
});

test("MCP send_candidate types then clicks Send and never refreshes", async () => {
  const withSend = snapshot({ extra: '│   ├── (1488,1000) 按钮 "发送"  [action: click]' });
  const h = harness({ snapshots: [snapshot(), snapshot(), withSend] });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client,
    sleep: async () => {}
  }).init();
  const result = await executor.execute({
    action: "send_candidate",
    candidate: { project_id: "p", task_id: "T-1", detection_id: "det-1", eligible_role: "test_ai" },
    role: "test_ai",
    request_count: 1,
    execution_settings: { max_requests_per_chat: 20, test: { model: "GPT-5.6 Sol", reasoning_effort: "high" } }
  });
  assert.equal(result.executed, true);
  assert.ok(h.calls.some(([name]) => name === "Type"));
  assert.ok(h.calls.some(([name, args]) => name === "Click" && args.loc[0] === 1488));
  assert.equal(h.calls.some(([name, args]) => name === "Shortcut" && args.shortcut === "ctrl+r"), false);
});

test("MCP retry_or_continue clicks retry when it exists", async () => {
  const withRetry = snapshot({ extra: '│   ├── (1200,800) 按钮 "重试"  [action: click]' });
  const h = harness({ snapshots: [withRetry] });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client
  }).init();
  await executor.execute({ action: "retry_or_continue", conversation_url: "https://chatgpt.com/c/x", attempt: 1 });
  assert.ok(h.calls.some(([name, args]) => name === "Click" && args.loc[0] === 1200));
});

test("MCP safety block is written back as platform_safety", async () => {
  const h = harness({ snapshots: [snapshot()], failTool: "Click" });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client
  }).init();
  await assert.rejects(
    () => executor.execute({ action: "new_chat", detection_id: "det-safety" }),
    /blocked by safety check/
  );
  assert.equal(h.finishes.length, 1);
  assert.equal(h.finishes[0].result, "safety_blocked");
  assert.equal(h.finishes[0].error_source, "platform_safety");
  assert.equal(h.finishes[0].trace_id, "trace-1");
});

test("refresh_last_resort hard-requires exhausted recovery evidence", async () => {
  const h = harness({ snapshots: [snapshot()] });
  const executor = await new ChatgptMcpExecutor("x", {
    automationControl: h.automationControl,
    mcpClientFactory: async () => h.client
  }).init();
  await assert.rejects(
    () => executor.execute({ action: "refresh_last_resort", conversation_url: "https://chatgpt.com/c/x" }),
    error => error?.code === "CHATGPT_MCP_REFRESH_EVIDENCE_REQUIRED"
  );
  assert.deepEqual(h.calls, []);
});

test("candidate prompt keeps role/model/version handoff contract", () => {
  const prompt = buildCandidatePrompt({
    candidate: { project_id: "p", task_id: "T-1", detection_id: "det-1", eligible_role: "test_ai" },
    role: "test_ai",
    request_count: 2,
    execution_settings: { max_requests_per_chat: 20, test: { model: "GPT-5.6 Sol", reasoning_effort: "high" } },
    extension_version: "0.6.25",
    extension_latest_version: "0.6.25",
    taskboard_version: "0.6.32"
  });
  assert.match(prompt, /task_id=T-1/);
  assert.match(prompt, /required_model=GPT-5\.6 Sol/);
  assert.match(prompt, /required_reasoning_effort=high/);
  assert.match(prompt, /extension_version=0\.6\.25/);
  assert.match(prompt, /taskboard_version=0\.6\.32/);
  assert.match(prompt, /role_governance=当前项目AGENTS指定的测试AI工作规范/);
  assert.match(prompt, /最后一次代码修改之后的开发自测证据/);
  assert.match(prompt, /不得替开发改业务代码/);
});

test("WyerpTaskboard role governance docs referenced by wake prompt exist", async () => {
  const [developer, tester] = await Promise.all([
    readFile(new URL("../docs/governance/开发AI工作规范.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/governance/测试AI工作规范.md", import.meta.url), "utf8")
  ]);
  assert.match(developer, /delivery-failed/);
  assert.match(developer, /原开发actor-id/);
  assert.match(tester, /独立测试 AI/);
  assert.match(tester, /不得修改业务实现/);
});

test("WyerpTaskboard developer candidate prompt hard-requires role doc and self-test after code changes", () => {
  const prompt = buildCandidatePrompt({
    candidate: {
      project_id: "wyerp-taskboard", task_id: "WTB-X", detection_id: "det-dev", eligible_role: "developer_ai",
      eligible_actor_id: "developer_1", eligible_session_id: "wc_sess_original_1"
    },
    role: "developer_ai",
    execution_settings: { developer: { model: "GPT-5.6 Sol", reasoning_effort: "high" } },
    taskboard_version: "0.6.37"
  });
  assert.match(prompt, /role_governance=docs\/governance\/开发AI工作规范\.md/);
  assert.match(prompt, /每完成一个成功逻辑代码修改事务\/可验证代码批次后立即执行相关开发自测/);
  assert.match(prompt, /自测失败必须继续修复或登记真实阻断/);
  assert.match(prompt, /禁止taskctl complete/);
  assert.match(prompt, /required_actor_id=developer_1/);
  assert.match(prompt, /required_session_id=wc_sess_original_1/);
  assert.match(prompt, /不得把候选提供的值冒充为自己的身份/);
  assert.match(prompt, /taskctl delivery-failed/);
});
