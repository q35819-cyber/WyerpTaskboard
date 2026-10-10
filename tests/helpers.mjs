import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function registryText(rows = null) {
  const data = rows || [
    ["A-10","F-001","product","P0","待开发","开发AI","—","—","—","—","权限收口","账号登录与权限开发计划.md","cp/A-10.md"],
    ["B-10","F-022","infrastructure","P0","开发中","开发AI","worker","B-10窗口","wc_sess_test","2026-09-28T11:30:00Z","看板","任务看板与AI协作控制开发计划.md","cp/B-10.md；reports/B-10/report.md"],
    ["T-01","F-TEST","product","P1","待独测","独立测试AI","—","—","—","—","独立测试夹具","测试计划.md","cp/T-01.md"]
  ];
  const withTraceability = data.map((r) => r.length === 13 ? [...r.slice(0, 12), "tests/fixture-source.txt", r[12]] : r);
  const normalizedData = withTraceability.map((r) => r.length === 14 ? [...r.slice(0, 13), "read/" + r[0] + ".md", "write/" + r[0] + ".js", r[13]] : r);
  const lines = [
    "# fixture",
    "<!-- PROJECT_TASK_REGISTRY_START v1 -->",
    "| 任务ID | 父任务/功能 | 轨道 | 优先级 | 当前阶段 | 计划角色 | 当前负责人 | 会话窗口名称 | 技术会话/尝试ID | 最近更新时间 | 准备条件与边界 | 主计划 | 关键文件/溯源 | 只读依赖 | 计划写文件 | 目标位置 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...normalizedData.map((r) => `| ${r.join(" | ")} |`),
    "<!-- PROJECT_TASK_REGISTRY_END -->",
    ""
  ];
  return lines.join("\n");
}

export async function makeFixture() {
  const boardRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-board-"));
  const projectRoot = path.join(boardRoot, "managed-project");
  await fs.mkdir(path.join(boardRoot, "web"), { recursive: true });
  await fs.writeFile(path.join(boardRoot, "web", "index.html"), "<!doctype html><html><body>独立任务看板</body></html>", "utf8");
  await fs.writeFile(path.join(boardRoot, "web", "app.js"), "console.log('fixture');", "utf8");
  await fs.writeFile(path.join(boardRoot, "web", "plan-index.mjs"), "export function buildPlanIndex(){return {lines:[],entries:[],targetLine:null,foundTask:false}};\n", "utf8");
  await fs.writeFile(path.join(boardRoot, "web", "styles.css"), "body{font-family:sans-serif}", "utf8");
  await fs.writeFile(path.join(boardRoot, "package.json"), JSON.stringify({ name: "wyerp-taskboard-fixture", version: "0.5.0", private: true, type: "module" }, null, 2), "utf8");
  await fs.mkdir(path.join(boardRoot, "config"), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "tasks.md"), registryText(), "utf8");
  await fs.writeFile(path.join(projectRoot, "账号登录与权限开发计划.md"), "# 账号登录与权限开发计划\n\n夹具计划内容。\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "任务看板与AI协作控制开发计划.md"), "# 任务看板与AI协作控制开发计划\n\nB-10夹具计划内容。\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "测试计划.md"), "# 测试计划\n\n独测夹具计划内容。\n", "utf8");
  await fs.mkdir(path.join(projectRoot, "cp"), { recursive: true });
  await fs.mkdir(path.join(projectRoot, "reports", "B-10"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "cp", "B-10.md"), "# B-10断点\n\n夹具断点内容。\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "reports", "B-10", "report.md"), "# B-10测试报告\n\n夹具测试报告内容。\n", "utf8");
  await fs.writeFile(path.join(boardRoot, "config", "chat-browser-wake.json"), JSON.stringify({ version: 1, enabled: true, token: "t".repeat(64), lease_ms: 30000, expected_extension_version: "0.5.0" }, null, 2), "utf8");
  await fs.writeFile(path.join(boardRoot, "config", "projects.json"), JSON.stringify({
    version: 1,
    projects: [{
      id: "fixture",
      name: "Fixture",
      root: projectRoot,
      adapter: "markdown-task-registry-v1",
      registryFormatVersion: 1,
      workflowProfile: "wyerp-ai-flow-v1",
      taskRegistry: "tasks.md",
      resourceLedger: "ledger.md",
      checkpointDir: "cp",
      reportDir: "reports",
      defaultTrack: "product",
      trackOverrides: { "B-10": "infrastructure" }
    }]
  }, null, 2), "utf8");
  return { boardRoot, projectRoot, registryPath: path.join(projectRoot, "tasks.md") };
}