# WebCodex 简化开发模板 v1

## 文件
- AGENTS.md：所有执行者的简短规则
- WORKFLOW.md：唯一任务状态与交付流程
- TASK_TEMPLATE.md：任务信息与证据
- DEV_PROMPT.md：开发入口
- TEST_PROMPT.md：独立测试入口
- SOFTWARE_PROJECT_CONTRACT.md：跨技术栈项目配置与接入契约
- software-project-config.schema.json：版本化项目配置 Schema
- examples/node-project/、examples/python-project/：两种技术栈的可运行接入样例
- ONBOARDING_REPORT_TEMPLATE.md：接入自检报告模板

## 当前 WebCodex 工具映射
| 需要做的事 | 当前工具 | 使用要求 |
|---|---|---|
| 开始/恢复项目工作 | work_on_project | 先建立或恢复 Workflow Session，并读取项目指令 |
| 查看 Git 状态 | git_status | 开始任务和交付前都检查 |
| 读取文件 | read_files | 已知文件优先批量读取，避免反复猜路径 |
| 执行单条程序命令 | run_process | 优先传 executable + args，不拼 shell 字符串 |
| 执行相关 shell 操作 | run_shell | 只用于确实需要管道、重定向或短命令组合 |
| 查看长任务 | observe_jobs / list_jobs | 观察已有 Job；不把启动当完成，不擅自重复启动 |
| 查看工具参数 | tool_manifest | 先发现工具和 schema，不猜名称或参数 |

注意：实际工具以当前会话提供的工具目录和 schema 为准；不要假设本地 Codex CLI、IDE 插件或桌面端能力存在。提交、推送、发布等独立高影响动作分开调用和核验。

## 设计来源与取舍
- OpenAI Codex：https://github.com/openai/codex — 参考指令分层；不照搬 CLI 专属命令。
- Astral uv：https://github.com/astral-sh/uv/blob/main/CONTRIBUTING.md — 参考先确认任务/设计再开工，以及明确测试命令。
- Zed：https://github.com/zed-industries/zed/blob/main/CONTRIBUTING.md — 参考小范围变更、测试证据和自审。
- Zed PR 模板：https://github.com/zed-industries/zed/blob/main/.github/pull_request_template.md — 参考简洁交付材料。
- GitHub 分支保护：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches — 参考远端合并门禁。

## WebCodex 适配
- 只使用当前会话真实可用工具。
- 文件读取、单条进程、相关 shell、长时 Job 分别使用对应能力。
- 长时任务观察到最终结果。
- 独立的测试、提交、推送、发布分开执行和核验。
- 上下文切换依赖任务断点和 SHA，不依赖聊天记忆。

## 验收前提
这些是流程模板，不代表现有任务看板已经实现所有门禁。必须先用独立模拟仓库验证状态机和 Git 闭环，再接入看板。

## 通用项目接入契约（P0 最小交付）
- 项目差异写入 `wyerp-taskboard.project.json`，统一校验 `software-project-config.schema.json`；不得在项目内复制一套状态机或角色提示词。
- Node.js 与 Python 样例使用同一模板版本、同一验收范围字段和同一质量门禁结构，仅技术栈与测试命令不同。
- 示例目录中的命令可直接运行；测试会实际执行两种技术栈的示例测试命令。
- 本目录交付的是可运行模板与接入契约。自动探测、正式 onboarding API/CLI、配置迁移执行器仍由 `WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1` 实现；不得把契约文档误报为生产自动接入能力。
