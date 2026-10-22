# 独立手工 MCP 集成计划

## 1. 用户目标

为 WyerpTaskboard 增加一套与自动任务系统完全解耦的 Windows-MCP 调用通道。该通道只在用户或当前AI明确执行命令时启动，调用结束立即关闭，不自动扫描任务、不自动接任务、不自动操作浏览器。

## 2. 已确认事实

- WebCodex 注册层能看到 `windows-mcp` 名称，但真正列工具时返回 `provider_replaced`，说明旧 provider 绑定已失效。
- 看板现有 `WindowsMcpClient` 走本机 stdio，`node cli/windows-mcp.mjs list-tools` 已现场成功连接 Windows-MCP 4.0.9 并列出工具。
- 因此本次不修 WebCodex provider gateway，而是新增一条看板自身可控的手工 stdio 通道。

## 3. 范围

### 本次实现

1. 独立配置 `config/manual-windows-mcp.json`。
2. 独立客户端入口，只接受 `manual_only=true` 的配置。
3. 独立 CLI `cli/manual-windows-mcp.mjs`：`status / list-tools / call / snapshot`。
4. 每次命令单独创建临时 stdio MCP session，用完关闭，不保留后台 MCP 进程。
5. 沿用现有工具白名单和禁止快捷键保护。
6. 记录手工 MCP 调用日志，组件名与自动链路区分开。
7. 自动化测试证明：手工通道不会读取/修改 task-scan、Chat Wake、健康监控的运行开关与状态。

### 明确排除

- 不启动 task-scan。
- 不启用 Chat Wake。
- 不启用 ChatGPT 健康监控计划任务。
- 不启用无人值守。
- 不自动 claim 任何任务。
- 不修复或替换 WebCodex 的 `windows-mcp` provider 注册实例。
- 不提供任意 PowerShell/FileSystem 等高风险 MCP 工具；仍受白名单控制。

## 4. 架构

`用户/AI显式命令 → cli/manual-windows-mcp.mjs → ManualWindowsMcpClient → 独立manual配置 → 本机 windows-mcp.exe stdio → 单次调用后关闭`

自动系统继续走原有模块，不引用 manual 配置。

## 5. 验收

1. `manual-windows-mcp status` 能连上 Windows-MCP 4.0.9。
2. `list-tools` 只标记手工白名单工具为 allowed。
3. 非白名单工具拒绝。
4. 每次调用结束后无长期驻留的手工 MCP 子进程。
5. 手工调用前后 task-scan / Chat Wake / ChatGPT health 自动配置与运行状态不发生变化。
6. `npm run check` 与相关单测通过，最终全量 `npm test` 通过。

## 6. 回滚

删除 `manual-windows-mcp` 新配置/客户端/CLI/测试和 package script 即可；原自动链路不依赖本功能，因此回滚不影响现有任务看板主流程。
