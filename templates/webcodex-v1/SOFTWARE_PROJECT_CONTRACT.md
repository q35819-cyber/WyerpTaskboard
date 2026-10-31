# 通用软件项目配置与接入契约 v1

本契约把**通用研发流程**与**项目自身配置**分离。所有项目共用任务状态机、三角色权限、SHA 证据、自测/独测、失败回流、Git 交付门禁和系统/用户验收边界；项目只声明技术栈、仓库策略、质量命令、项目规则和环境依赖。

## 1. 配置文件

- 项目配置文件名：`wyerp-taskboard.project.json`。
- 结构定义：`software-project-config.schema.json`，`schemaVersion` 当前为 `1`。
- 配置不得包含密码、API key、Cookie、访问令牌或其他秘密；只记录环境变量**名称**和必需工具，不记录秘密值。
- 构建、测试、lint 命令使用 `executable + args[] + cwd` 结构，不保存拼接的 shell 命令字符串。执行器必须把 `cwd` 约束在项目根目录内，并校验路径、可执行文件和参数。
- `workflow` 只声明模板 ID、模板版本和验收范围，不允许项目自定义另一套角色、状态机或绕过门禁。
- `acceptanceScope` 默认 `system`；只有明确的 UI/交互或业务逻辑验收任务才能标记 `user_ui_business`。
- 新任务不得直接创建为 `待用户验收`；该状态只能由独立测试 PASS（无需交付）或受控 Git 交付完成流程自动进入。

## 2. 最小项目配置字段

| 区域 | 项目声明 | 约束 |
|---|---|---|
| `project` | 唯一 ID、名称、项目根目录 | 根目录由接入器解析为规范绝对路径；示例用 `.` 表示配置文件所在目录 |
| `git` | 远端 URL、默认分支、合并策略 | 不因远端暂不可达而丢弃项目；必须报告阻断 |
| `technology` | 语言、运行时、框架、包管理器 | 探测结果必须附带文件证据，不得凭目录名猜测 |
| `qualityGates` | build、test、lint 命令 | test 必须明确；缺失时标记 `needs_user_input` 或先补齐测试入口，不能假报 PASS |
| `workflow` | 模板 ID/版本、验收范围 | 使用统一流程，不复制项目专属状态机 |
| `projectRules` | 只读路径、允许写入路径、文档保留策略 | 必须保留现有 `AGENTS.md`、README 和业务文档 |
| `environment` | 必需工具和服务 | 只列依赖名称/版本，不写秘密值 |

## 3. 接入契约

正式 onboarding 实现必须遵守以下输入/输出，不得让用户重复填写可从项目目录探测的信息。

### 输入

- 必需：项目根目录绝对路径。
- 可选：用户明确提供的项目名称、技术栈提示或业务验收范围。
- 不要求用户手工填写项目 ID、Git 默认分支、语言、框架、测试命令；这些信息应优先扫描识别并保留证据。

### 执行顺序

1. 解析并规范化项目根目录，拒绝路径穿越、符号链接逃逸和不可访问目录。
2. 只读扫描 Git 远端/默认分支/HEAD/工作区、语言运行时、框架、包管理器、锁文件、构建/测试入口、CI 和现有项目规则。
3. 生成 `wyerp-taskboard.project.json` 配置建议并按本 Schema 校验。
4. 验证每条质量命令的可执行文件、参数和工作目录；至少实际运行 test 命令。失败或缺失不得标记为 PASS。
5. 保留原有项目文档和用户配置；不覆盖、不删除、不上传私有项目文件。
6. 生成 `ONBOARDING_REPORT_TEMPLATE.md` 对应的接入自检报告，状态只能为 `ready`、`needs_user_input` 或 `blocked`。
7. 只有配置与自检通过后，才注册项目并启用统一任务入口；注册失败时保留原项目现场。

### 命令/API 形状

后续 onboarding 执行器应提供等价于以下契约的入口：

- CLI：`taskctl onboard --root <absolute-project-root>`。
- API：`POST /api/projects/onboard`，请求体至少包含 `root`，响应包含 `projectId`、`onboardingStatus`、`profilePath` 和 `reportPath`。

**实现状态说明：** 本 P0 交付模板、Schema、接入契约、报告模板和 Node/Python 可运行样例；上述生产 CLI/API 与自动探测/注册执行器尚未由本任务实现，属于 `WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1` 的后续范围。不得把接口形状写成已存在的功能。

## 4. 模板版本兼容

- 配置 Schema 使用整数 `schemaVersion`；不支持的主版本必须阻断并生成迁移建议，不得静默降级或覆盖。
- `templateVersion` 使用 `MAJOR.MINOR.PATCH`。同一 MAJOR 内的兼容升级允许按迁移规则更新；跨 MAJOR 必须显式迁移并保留旧配置副本/哈希。
- 可选供应商或项目扩展只能放在 `extensions` 命名空间；不得修改公共状态机和权限规则。
- 模板升级不得覆盖项目原有 `AGENTS.md`、README、业务规则、用户配置和未提交修改。

## 5. 样例验证

- `examples/node-project/`：Node.js + `node:test`。
- `examples/python-project/`：Python + `unittest`。
- 两个样例必须使用相同的 `templateId`、`templateVersion`、配置 Schema 和验收范围字段；只有 `technology` 与实际质量命令不同。
- `tests/software-project-template.test.mjs` 会校验两个配置并实际执行两个示例的 test 命令。这是模板契约模拟，不替代 P1 的真实自动发现/注册和三技术栈端到端接入验收。
