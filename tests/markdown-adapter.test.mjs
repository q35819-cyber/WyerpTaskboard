import test from "node:test";
import assert from "node:assert/strict";
import { appendRegistryTaskText, parseRegistryText, patchRegistryText } from "../server/adapters/markdown-task-registry-v1.mjs";
import { wyerpAiFlowV1 } from "../server/workflows/wyerp-ai-flow-v1.mjs";
import { registryText } from "./helpers.mjs";

const project = { defaultTrack: "product", trackOverrides: { "B-10": "infrastructure" } };

test("markdown adapter parses v1 registry and session fields", () => {
  const parsed = parseRegistryText(registryText(), project);
  assert.equal(parsed.tasks.length, 3);
  const b10 = parsed.tasks.find((task) => task.id === "B-10");
  assert.ok(b10);
  assert.equal(b10.track, "infrastructure");
  assert.equal(b10.sessionWindowName, "B-10窗口");
  assert.equal(b10.plan, "任务看板与AI协作控制开发计划.md");
  assert.equal(b10.readDependencies, "read/B-10.md");
  assert.equal(b10.writeTargets, "write/B-10.js");
  assert.match(parsed.registryRevision, /^[a-f0-9]{64}$/);
});

test("patch changes one task and produces new revision", () => {
  const original = registryText();
  const changed = patchRegistryText(original, project, "B-10", {
    priority: "P1",
    sessionWindowName: "新窗口",
    writeTargets: "web/app.js；tests/web-ui-contract.test.mjs"
  }, wyerpAiFlowV1);
  assert.equal(changed.before.priority, "P0");
  assert.equal(changed.after.priority, "P1");
  assert.equal(changed.after.sessionWindowName, "新窗口");
  assert.equal(changed.after.writeTargets, "web/app.js；tests/web-ui-contract.test.mjs");
  assert.notEqual(changed.beforeRevision, changed.afterRevision);
  assert.equal(parseRegistryText(changed.text, project).tasks[0].priority, "P0");
});

test("duplicate task id is rejected", () => {
  const rows = [
    ["A-10","F-001","product","P0","待开发","开发AI","—","—","—","—","a","计划A.md","a"],
    ["A-10","F-002","product","P1","待开发","开发AI","—","—","—","—","b","计划B.md","b"]
  ];
  assert.throws(() => parseRegistryText(registryText(rows), project), (error) => error.code === "DUPLICATE_TASK_ID");
});

test("status column tolerates parenthesized human notes without poisoning the registry", () => {
  const rows = [
    ["C-03-T9","C-03","product","P0","已取消（被后续最终规则覆盖）","—","—","—","—","2026-10-03","旧规则已被覆盖，历史说明保留在边界列","计划.md","cp/C-03-T9.md"]
  ];
  const original = registryText(rows);
  const parsed = parseRegistryText(original, project);
  assert.equal(parsed.tasks[0].status, "已取消");
  assert.doesNotThrow(() => wyerpAiFlowV1.validateStatus(parsed.tasks[0].status));
  const changed = patchRegistryText(original, project, "C-03-T9", { priority: "P1" }, wyerpAiFlowV1);
  assert.equal(changed.before.status, "已取消");
  assert.equal(changed.after.status, "已取消");
  assert.match(changed.text, /已取消（被后续最终规则覆盖）/, "非状态写操作不得静默改写原始历史说明");
});

test("unknown decorated status is still rejected by workflow", () => {
  const rows = [
    ["BAD-01","F-X","product","P0","不存在阶段（备注）","—","—","—","—","—","非法状态测试","计划.md","cp/BAD-01.md"]
  ];
  const parsed = parseRegistryText(registryText(rows), project);
  assert.equal(parsed.tasks[0].status, "不存在阶段");
  assert.throws(() => wyerpAiFlowV1.validateStatus(parsed.tasks[0].status), (error) => error.code === "INVALID_STATUS");
});
test("invalid status transition is rejected", () => {
  assert.throws(() => patchRegistryText(registryText(), project, "B-10", {
    status: "已完成"
  }, wyerpAiFlowV1), (error) => error.code === "INVALID_STATUS_TRANSITION");
});

test("append task serializer keeps registry column count stable", () => {
  const original = registryText();
  const appended = appendRegistryTaskText(original, project, {
    id: "C-NEW-001", parent: "C-NEW", track: "product", priority: "P0", status: "待开发", plannedRole: "开发AI",
    boundary: "内容含 `code`、普通竖线 A | B、中文标点与普通说明，但不得改变列数", plan: "新增任务计划.md",
    traceability: "server/example.mjs；tests/example.test.mjs", readDependencies: "read/a.md",
    writeTargets: "server/example.mjs；tests/example.test.mjs", targets: "cp/C-NEW-001.md；reports/C-NEW-001/"
  });
  const parsed = parseRegistryText(appended.text, project);
  assert.equal(parsed.headers.length, 16);
  assert.equal(parsed.tasks.find((item) => item.id === "C-NEW-001")?.targets, "cp/C-NEW-001.md；reports/C-NEW-001/");
  const block = appended.text.slice(appended.text.indexOf("<!-- PROJECT_TASK_REGISTRY_START v1 -->"), appended.text.indexOf("<!-- PROJECT_TASK_REGISTRY_END -->"));
  const row = block.split(/\r?\n/).find((line) => line.includes("| C-NEW-001 |"));
  assert.match(row, /A \\| B/);
  assert.equal(parseRegistryText(appended.text, project).headers.length, 16);
});

test("append task rejects malformed source registry before writing", () => {
  const broken = registryText().replace("| cp/A-10.md |", "| extra-column | cp/A-10.md |");
  assert.throws(() => appendRegistryTaskText(broken, project, {
    id: "C-NEW-002", parent: "C-NEW", priority: "P0", status: "待开发", plannedRole: "开发AI",
    boundary: "should not write", plan: "计划.md", traceability: "x", targets: "cp/x.md"
  }), (error) => error.code === "REGISTRY_PARSE_ERROR" && error.details?.expected === 16 && error.details?.actual === 17);
});
