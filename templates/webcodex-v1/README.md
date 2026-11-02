# WebCodex 简化开发模板 v1

**适用范围**：本模板可以作为其他 Node、Python 或不同技术栈项目的**手工接入基线**。任务看板仍集中管理任务ID与流程；新软件只需使用相同三角色/流程规范、Ponytail 和自己的构建测试命令。**自动探测/自动注册尚未交付**，不能称为一键接入。

**路径可移植规则**：本模板中指向程序文件、流程、断点、源码、工作区的路径全部以**目标项目根目录**为基准写相对路径，禁止固定本机盘符、UNC共享路径或用户目录。程序执行时才从当前项目配置推导真实绝对路径；外部文档链接和 Git URL 不属于本地路径。任务断点、历史或配置不得保存开发机专属的绝对路径。

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
- 流程文档/总控/、流程文档/开发/、流程文档/独测/：三角色统一且唯一的分步骤入口。旧版活动角色正文已退役，不能重新复制到目标项目。
- .agents/skills/ponytail/SKILL.md：**强制 full**，开发前必须实际阅读并按最少必要代码规则执行
- 流程文档/：总控、开发、独测的统一最小步骤文件，**本模板目录只存放任务看板项目根目录 `流程文档/` 的同版副本**，不能在这里维护另一套独立规则。


## 最少步骤接入其他软件（现阶段手工）

1. 在新软件仓库先检查原有 `AGENTS.md`、`WORKFLOW.md`、角色文档和未提交修改；**存在就合并关键条款，不覆盖**。不复制 WyerpTaskboard 的任务登记数据、历史或私有配置。
2. 把模板的 `AGENTS.md`、`WORKFLOW.md`、`流程文档/` 配置到项目根目录，`.agents/skills/ponytail/SKILL.md` 保留相同相对路径；**仅以 `流程文档/00_统一入口.md` 为三角色步骤权威入口**。不再复制已退役的旧角色正文，迁移已有旧文档时先保全未提交成果与历史。
   同时把本模板的 `流程文档/` 复制到新软件**项目根目录**的 `流程文档/`（已有文件先比较合并，不覆盖未提交内容），三角色入口统一以项目根目录 `流程文档/00_统一入口.md` 为准。该模板快照从任务看板根目录同步，修改新流程只能先修改任务看板权威源再同步发版。

3. 按实际语言选择 `examples/node-project/wyerp-taskboard.project.json` 或 Python 对应样例，修改唯一项目 ID、项目路径、Git 远端与真实 build/test 命令；已存在的项目配置优先复用，不要随意增加其他字段。
4. 在项目根目录实际运行其质量命令，保留退出码；使用当前任务看板注册信息及任务ID安排角色执行。**此处不是自动注册指令**；未来自动 onboarding 功能必须由对应 P1 任务独立开发和测试后才能宣称可用。
5. 开发自测/独测报告必须写出 Ponytail 检查：**复用了什么、检查过哪些调用方、最小必要 diff、实际测试**。不能只写“已用 Ponytail”。

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
这是可运行的模板基线，不代表生产自动 onboarding、自动派工或其他未来门禁已实现。接入前先执行项目实际测试和任务看板自身的既有 Git/独测流程；不因为历史模拟报告 PASS 而跳过真实测试。

## 通用项目接入契约（P0 最小交付）
- 项目差异写入 `wyerp-taskboard.project.json`，统一校验 `software-project-config.schema.json`；不得在项目内复制一套状态机或角色提示词。
- Node.js 与 Python 样例使用同一模板版本、同一验收范围字段和同一质量门禁结构，仅技术栈与测试命令不同。
- 示例目录中的命令可直接运行；测试会实际执行两种技术栈的示例测试命令。
- 本目录交付的是可运行模板与接入契约。自动探测、正式 onboarding API/CLI、配置迁移执行器仍由 `WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1` 实现；不得把契约文档误报为生产自动接入能力。
