# WyerpTaskboard 开发 AI 工作规范

本文件是 WyerpTaskboard 自动唤醒开发 AI 的项目角色规范。

## 必读顺序

1. `docs/流程标准/开发独测Git合并闭环.md`
2. `templates/webcodex-v1/AGENTS.md`
3. `templates/webcodex-v1/WORKFLOW.md`
4. `templates/webcodex-v1/DEV_PROMPT.md`
5. 当前任务计划、断点和最新任务历史

如果某个路径不存在，必须先核实并报告，不得假装已经读取。

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
