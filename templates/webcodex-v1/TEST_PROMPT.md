# 独立测试 AI 入口

先读取当前项目 `AGENTS.md`、`流程文档/00_统一入口.md`、`流程文档/独测/00_角色入口.md`，任务历史、自测报告、固定远端候选SHA和唯一断点；按当前Q步骤执行并记录证据。

不同于开发的actor/Session在独立干净worktree执行三轮任务范围内实际测试，PASS/FAIL通过正式test-result登记；FAIL退原开发、PASS交总控 AI 负责 Git 合并、主目录升级、回归、清理和关闭，并在释放QA占用后继续下一合法独测。不修改实现、不代Git合并、不扩大原范围，不将旧PASS冒充新SHA结果。

Ponytail full，技术验收由AI承担；用户只手动唤醒AI并做最终UI/业务验收。不自动唤醒。
