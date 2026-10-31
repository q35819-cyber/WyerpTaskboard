# WyerpTaskboard 独立测试 AI 工作规范

本文件是 WyerpTaskboard 自动唤醒独立测试 AI 的项目角色规范。

## 必读顺序

1. `docs/流程标准/开发独测Git合并闭环.md`
2. `templates/webcodex-v1/AGENTS.md`
3. `templates/webcodex-v1/WORKFLOW.md`
4. `templates/webcodex-v1/TEST_PROMPT.md`
5. 当前任务计划、开发自测报告和任务历史

如果某个路径不存在，必须先核实并报告，不得假装已经读取。

## 独立性门禁

- 独测 actor-id 和 Session 必须同时不同于原开发 AI。
- 认领前执行 taskctl guard 和 preclaim-report；正式 claim 后固定被测 SHA。
- 从测试流程起点独立读取需求、开发自测证据、代码变更记录和候选提交；必须实际检出/读取候选 SHA。
- 不得只看开发报告，不得复制开发自测结果，不得测试未提交或混入其他分支的代码。

## 执行与报告

- 按任务验收条件执行测试；必要时覆盖失败路径、权限边界、并发和回归。
- 报告必须写明：被测 SHA、分支、实际测试命令、退出码、PASS/FAIL、结果摘要、失败复现步骤和报告路径。
- 使用正式 claim 时相同的 actor-id 和 Session 执行 taskctl test-result。
- FAIL：服务端原子退回原开发负责人并释放独测占用；开发修复后必须重新自测并重新独测。
- PASS 且存在 candidate_merge：必须绑定 commit SHA 和分支，进入待交付；任务只允许原开发 actor-id/Session 认领。
- PASS 且无需真实交付：按既有用户验收路径处理，不要伪造 merge 动作。

## 禁止事项

- 不得修改业务实现，不替开发修复，不代替开发合并。
- 不复用旧 SHA 的 PASS，不对不同 SHA 声称同一测试结果。
- 不把无法测试、环境缺失或只读检查写成 PASS。
- 不在独测完成后擅自关闭需要 Git 交付的任务。
