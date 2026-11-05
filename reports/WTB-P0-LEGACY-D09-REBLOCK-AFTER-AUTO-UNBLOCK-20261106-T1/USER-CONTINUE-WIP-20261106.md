# D09 自动解阻后重入 BUG｜用户继续开发验证记录

- 任务：`WTB-P0-LEGACY-D09-REBLOCK-AFTER-AUTO-UNBLOCK-20261106-T1`
- 当前**正式看板状态：阻断**，STOP=false、无人正式占用，不能宣称正式接管、已交独测或已修复正式版。
- 用户当前原话：「做那个BUG任务啊」。本轮开发在新隔离工作区 `wyerptaskboard-e9effaac-6092-42c3-bec3-311016a37c79`，基于 `origin/main=59a0b9443a593dd8fb2267ff0af314372faa7109`。
- 保留旧开发分支 `fix/WTB-P0-D09-REBLOCK-TAKEOVER-20261106-D2`（候选 `4f4d79c`）及其它 AI worktree，使用 `git restore --source` 将原 **两处授权文件** 的改动复制到全新独立 WIP 分支，并验证原main自e58c204后未对这两处文件新增修改。
- 没有写入原任务的正式认领/测试 PASS/交接事件；没有修改主仓库、测试运行器、已完成任务或旧工作区。

## 流程门禁实测结果

1. `taskctl guard`：任务状态阻断，STOP=false，预认领不存在。
2. `taskctl takeover` 携用户原话与检查证据：真实 HTTP409 `SUSPECTED_DISCONNECT_STAGE_INVALID`，只能对执行中的任务做疑似失联检查。
3. 不附检查证据、携用户原话再次 `takeover`：真实 HTTP403 `USER_SESSION_REQUIRED`，客户端缺乏服务端认可的用户会话凭证。**不得伪造用户授权或直接更改任务状态。**
4. 总控会话已收到消息 `wc_msg_be2ebdb9c8214d95b89c5bdc07fb0610`，要求恢复合法接管/自动解阻及优先独测测试运行器。
5. 阻断事件类型 `developer_r3_runner_timeout_blocked` 当前不在 TaskStore 自动解阻允许类型集合内；不能把「运行器候选待独测」当成已经解除本任务阻断。

## 真实验证

- R1：`node --test --test-name-pattern "journal-backed auto_unblock" tests/task-step-checkpoint.test.mjs` → **1/1 PASS、exit0**。
- R2：`node --test --test-name-pattern "reblocked D09 rejects" tests/task-step-checkpoint.test.mjs` → **1/1 PASS、exit0**，检查未提交伪造解阻记录与 STOP，不改变旧D09记录。
- 完整相关回归：`node --test tests/task-step-checkpoint.test.mjs` → **41/41 PASS、exit0，duration 28069.7271ms**。
- `npm.cmd run check` → **exit0**；`git diff --check` → **exit0**。
- R3 `npm.cmd test`，Job `29d05006-dfec-47c2-9a9d-961a6d6814d7` → **PASS，exit0，60个测试文件全部通过、failedFiles=0，durationMs=274537，data/runtime/validation/npm-test.json state=passed（Job 29d05006-dfec-47c2-9a9d-961a6d6814d7）**。原测试运行器仍把该文件限制30秒；专用90秒修复在另任务`WTB-P0-TEST-RUNNER-STEP-CHECKPOINT-TIMEOUT-20261106-T1`的远端候选 `3879a837d56546586c1c1f18cc0f7bd0393330cf`，当前待独测，未正式合并。

## 后续准入与职责

- 当前分支仅是**开发预验证/WIP**。任务须由授权服务端恢复为真正可认领状态并正式claim，绑定本开发新actor/Session，再按最新流程从合法D01/D07完成三轮重新自测，不能复用本报告假装已完成正式阶段。
- 唯一独测 AI 只在正式handoff、报告SHA及候选SHA一致后检出独测；总控负责合main、运行版回归、后续旧业务卡真实自动解阻和关单。
- 本任务的源代码不需要从零重写；恢复时优先复用旧候选，确保真实自动解阻事件、事务日志、STOP和旧角色会话记录完整保存。
