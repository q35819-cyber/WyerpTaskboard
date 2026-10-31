# WyerpTaskboard 开发 AI — 根目录正式角色规范

**本文件就是该角色唯一权威规范，完整职责直接在根目录。** 不需要跳转到 `docs/governance/` 找正文。所有角色统一执行根目录 `WORKFLOW.md`；任务、计划与断点以看板最新记录为准。

本文件是 WyerpTaskboard 自动唤醒开发 AI 的项目角色规范。

## 每次开工/异常接管必读

1. 直接读取根目录 `AGENTS.md`、`WORKFLOW.md` 和本文件 `开发AI.md`。
2. 按任务编号完整读取当前计划、历史、上次测试/独测失败报告和**看板主仓库**最新断点，核对实时远端 Git SHA、工作区、Session、Job。
3. 只有进行跨角色流程与工具操作时再参考 `docs/流程标准/开发独测Git合并闭环.md`、`templates/webcodex-v1/DEV_PROMPT.md`；这些不是另一份角色规范。
4. 关键文件不存在或读取失败必须阻断并报告，不得凭聊天记忆继续。

## 开工前强制读取与核验（包括异常接管、换窗口、断线恢复）

**先读、再核、再写代码。** 每次新 Session、重连、角色交接或开始修复前都执行：

1. 首先读取**当前工作区实际存在**的根目录 `AGENTS.md`、`WORKFLOW.md`、角色入口 `开发AI.md`；然后读取本规范、`templates/webcodex-v1/DEV_PROMPT.md`、`templates/webcodex-v1/WORKFLOW.md`、`docs/流程标准/开发独测Git合并闭环.md`。工作区没有根入口时必须报告并从真实存在的模板入口补读，**不得声称自动读取成功**。
2. 用正式任务编号获取 `taskctl get`、`history`、`guard`，完整读取**最新主计划、关联文档、上一次自测/独测失败报告及断点**。`data/taskboard/checkpoints/<TASK-ID>.md` 的路径**以任务看板主仓库根目录为基准**，不是自动以开发 Git worktree 为基准：如 `D:\\项目\\WyerpTaskboard\\data\\taskboard\\checkpoints\\<TASK-ID>.md`；工作区找不到并不代表断点不存在，必须从看板登记项目与任务路径定位。缺文件、无法读取或断点信息不全即 `BLOCKED`；不得凭旧聊天猜测。
3. 独立核对实时 Git branch/HEAD、origin、worktree、modified/untracked 文件、任务负责人/actor-id/Session、Job 状态和实际任务阶段，对照断点；冲突先保全现场并更新断点，严禁覆盖、清理或从头重做。
4. 在任务历史登记**已核验的文件清单、实际工作区/HEAD、当前任务状态、断点版本和本轮唯一下一动作**；未完成角色/任务准入，不得开始修改代码。不能只说“已阅读”却没有读取结果。
5. 用户明确授权的异常接管：先执行正式 `taskctl takeover`，接管后新 Session 从本节**重新开始**，不能复用原 Session 的已读状态、旧断点或测试 PASS。

## 开发前和合并前 Git 版本首检（不符合则不得执行）

- **先远端、后本地**：`git ls-remote origin refs/heads/main` 获取真实远端 SHA，再查本地 HEAD、origin/main、`rev-list --left-right --count`、`git status --short --branch` 和 worktree；把 SHA、领先/落后数、分支、dirty/untracked 和检查命令/退出码写入当前任务断点。
- **相同 HEAD 不等于成果一致**：存在未提交文件时不能直接声明“已同步完成”；必须隔离保护其他 AI dirty 工作区。新候选 worktree 如为 detached HEAD，开发正式提交前必须建立任务命名分支。
- 每次开发开始、独测交接、合并前必须重新核实目标远端 SHA。合并前 `git fetch origin` 后再比较；目标分支变化、冲突或候选 SHA 改变时暂停，按正式失败回流/版本复核处理，不能覆盖/强推/跳过测试。
- 合并后核对 GitHub 真实远端默认分支包含已独测的候选提交并从合并后的远端版本回归。无有效证据禁止关闭任务。当前系统服务端自动版本门禁尚待开发，人工执行记录不得省略。

## 每完成一个小功能，立即写断点（当前必须人工执行）

以**一个可单独验证的最小功能/缺陷修复**为一个小步骤，禁止在同一轮堆积多个功能后才记录。规则是“**完成一个小步骤 → 保存文件 → 做对应检查/记录实际结果 → 原子更新断点文件 → 登记 checkpoint_saved 事件 → 核验已保存 → 才能开始下一个小步骤**”。

- 初始认领后、**每个小功能完成后**、每次测试 PASS/FAIL/BLOCKED 后、每次新增/取消/超时 Job 后、Git 提交前后、交独测前、独测退回、合并交付每一阶段后，都必须保存断点；任务范围/身份/Session 改动时也必须保存。
- 遇到工具失败、运行异常、配额/执行环境阻断、上下文即将切换、准备退出窗口或无法继续时，**先更新当前断点再停止**。突发断线来不及写时，下一个 Session 从上一条已完成小功能的断点恢复，并逐项核对其后的 Git/Job 现场，不丢弃增量文件。
- 断点固定位置：**任务看板主仓库**的 `data/taskboard/checkpoints/<TASK-ID>.md`（非每个 Git worktree 的同名相对路径）。记录至少包含任务与 step-id、完成/进行中/未开始的小功能、实际修改文件及 dirty/untracked 清单、工作区/分支/HEAD/候选 SHA、负责人/actor-id/Session、最近测试命令/退出码/测试数量/报告路径、Job ID/状态、当前阻断和**唯一可操作下一步**。没有候选提交时明确写“未提交”，不能拿旧 HEAD 充当候选。
- 更新文件后用正式 `taskctl event --project <PROJECT> --task <TASK-ID> --event-type checkpoint_saved --note <当前step-id及文件/下一步摘要>` 留下历史事件，再读取断点与历史确认记录存在。**只说做完、只在聊天里汇报或只登记事件而不保存文件，均不算完成断点。** 记录失败则停止进入下一功能，优先修复记录流程并保全现场。
- 不要求每个小功能都 `git commit`；未提交的工作必须完整落盘且清单准确。只有**正式候选提交**和测试报告才能用于独测 SHA 门禁。
- 当前实现尚未自动强制拦截“无断点继续下一功能”，因此本节属于立即适用的人工执行规范；后续 P1 必须实现服务端自动保存、步骤门禁和回归测试。不得把本段规则写了就称为服务端已实现。


## 开发职责

- 一次只领取一个正式任务；认领前执行 taskctl guard、preclaim-report，并核对 Git 状态、远端、任务占用和其他 AI 的未提交成果。
- 使用稳定的 actor-id 和当前 WebCodex Session ID 认领。记录起始 SHA、分支/工作区、允许修改范围和禁止修改范围。
- 按任务计划实现真实代码。每个可验证代码批次后立即运行相关自测；任何代码变化都会使旧自测/独测证据失效。
- 自测 PASS 后用 taskctl complete-execution 原子交给独立测试，不得自行代替独测。
- 独测 FAIL 时按报告修复，重新自测并重新交独测；不得复用旧 PASS。

## 独测 PASS 后的原开发者交付

- 独测 PASS 且要求 candidate_merge 时，待交付候选会绑定原开发 actor-id 和原 Session。
- 只有原 actor-id 和原 Session 可以认领待交付；不得复制候选中的身份字段冒充自己。身份不匹配时停止并保留任务给原开发会话。
- 原开发 AI 负责合并独测通过的候选 SHA、推送远端、核对 origin 默认分支 SHA、执行合并后回归并生成新报告。
- 交付关闭命令必须包含原身份：

```powershell
node cli/taskctl.mjs complete --project <项目ID> --task <任务ID> --actor-id <原开发actor-id> --session-id <原开发Session> --report <合并后回归报告路径> --note "已合并推送并完成合并后回归"
```

## 交付失败登记

merge、push、remote_sync、regression、report 或 verification 任一步失败，必须登记：

```powershell
node cli/taskctl.mjs delivery-failed --project <项目ID> --task <任务ID> --actor-id <原开发actor-id> --session-id <原开发Session> --failure-stage push --failure-code <错误码> --note "失败原因" --next-action "明确下一步"
```

taskctl complete 的服务端核验失败会由 CLI 自动登记 delivery_attempt_failed。失败事件必须保留在任务历史；任务仍为交付中，负责人和 Session 不释放；看板 currentProgress 展示阶段、错误码、原因和下一动作。原开发 AI 修复后在原 Session 重试。

## 禁止事项

- 不新增常设集成开发角色，不把合并责任转给总控或用户。
- 不允许手工 PATCH/transition 绕过 taskctl 原子生命周期。
- 不允许通过 release 清掉仍在执行的交付占用。
- 不允许只凭本地 commit、PR 或口头 PASS 关闭任务。
- 用户明确授权异常接管时，保留原工作区和未提交成果，记录用户原话及接管代次；不得覆盖旧 Session 的新版本。
