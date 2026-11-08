# WTB-P0-BLOCK-SESSION-REVOKE-ATOMIC-20261108-T1｜开发D2强制推进候选自测报告

## 真实任务资格与边界
- 用户正式指令：P0 BUG 强制优先推进修复。此授权不允许跳过 STOP、可信身份、唯一独测或总控合并。
- 生产任务卡：`待开发`、assignee/Session 为空、STOP=false；正式 scanner eligible=true，但历史仅有 task_created `evt_6946327fb4d21dc5be7c993a`、开发预认领 `evt_49b3d0096136270c52b78f10`、门禁缺陷报告 `evt_cf06ed7dde5f3fe752b408d8`、总控范围澄清 `evt_401eff5bb00579aa825d9679`。**尚无任何可信 controller_dispatch**，新任务 D01 校验当前会拒绝直接 claim 后的步骤，不能伪记 D01 PASS 或声称交测。
- 本次为用户明确授权的**独立隔离工作区预开发**，不是正式领取。代码 worktree `agent:Administrator-19af1cd12ae84d1b:wyerptaskboard-514df825-eca8c7c7`，base origin/main `9f211d41492998d552474050ee363d5fc7efa427`，分支 `fix/WTB-P0-BLOCK-SESSION-REVOKE-ATOMIC-20261108-D2`。主目录与他人分支/WIP/任务历史均未更改。
- 仅修改原计划授权的 `server/task-store.mjs`、`tests/task-store.test.mjs`，不扩展自动解阻机/UI/角色，不删除既有候选。使用 Ponytail full 复核调用、状态及恢复兼容性。

## 根因与最小候选修复
- 原有 `normalizeTaskPatch` 已经在可信正式 BLOCK 状态事务中清空 assignee、sessionWindowName、sessionId，保留该能力，未重复实现。
- 新增 TaskStore BLOCK 会话撤权检查：开发/独测旧 Session 在原 BLOCK 后不能再次提交受保护执行事件，也不能在后续恢复为待开发时复用旧 Session claim；新合法 Session 可以走重新认领。
- `appendTaskEvent` 对受保护执行事件进行撤权核验；与 TaskStepCheckpoint 已有外层项目锁兼容，避免重复锁引发 PROJECT_LOCKED；旧合法 QA BLOCK→返工恢复步骤不被粗暴封锁。
- 失败的更新事务不留半阻断、半占用；R1/R2/R3覆盖真实旧凭据、错误 actor、受保护事件、重复恢复、合法新凭据、已有步骤恢复与 STOP。

## 三轮真实开发自测（同一最终代码）
- **R1 负向/身份与原子性**：`node --test --test-name-pattern "BLOCK atomically|BLOCK revokes QA" tests/task-store.test.mjs`，**2/2 PASS、exit 0**；旧步骤恢复四项 `Q02 recovery rejects|QA recovery refuses BLOCK|user-command authorized QA BLOCK|spoofed user-command bugfix` **4/4 PASS、exit 0**。
- **R2 交叉模块回归**：`node --test tests/task-store.test.mjs tests/task-auto-unblock.test.mjs tests/task-step-checkpoint.test.mjs`，Job `wc_job_A4le9TeYOOQMAZI-`，**94/94 PASS、0 FAIL、exit 0**。
- **R3 最终整仓**：`node scripts/run-tests.mjs`，Job `wc_job_YVa0f9cuNgIBwSYX`，**62个测试文件、failedFiles=0、exit 0、durationMs=440727**，日志 `data/runtime/validation/npm-test.json`，状态 passed，finishedAt `2026-11-08T01:46:28.938Z`。
- 补充：`npm.cmd run check` PASS，`git diff --check` PASS。真实操作日志 `data/logs/changes/2026-11-08.jsonl` 和 `data/logs/errors/2026-11-08.jsonl` 位于本独立项目 worktree，本地保留而不作为正式生产日志；历史初次 FAIL 如下保存。
- 历史：初次三模块 43/45（2 FAIL）因事件双项目锁；初次整仓 62文件中1个失败、具体旧步骤4场景因阻断权限错误过宽；修复后上述R1/R2/R3均真 PASS。不得擦除首次 FAIL 或冒称首次通过。

## 必答 BUG 三问
1. **问题解决了吗？** 本次候选在真实测试夹具已验证原子清空、BLOCK 旧 Session 拒写、重排后旧 Session 拒绝抢回、新 Session 合法领取。**生产尚未部署**，因此只可说候选修复通过开发自测。
2. **还会复现吗？** 上述复现路径由新负向测试守护，当前62文件整仓回归0失败；不能承诺未知历史、意外服务器恢复和未经独测路径永不复现。
3. **后续流程是否正常？** 候选本地的BLOCK→可信恢复、D01/Q01已有步骤兼容回归通过；**本真实任务尚未正式claim/D01/D08，也未独测、总控合并或关单**。必须由正式总控身份补 `controller_dispatch` 事前派工事件或修复相应合法机器准入，并重新进行真实规则门禁/claim/D01、必要自测重验、正式候选发布交唯一独测，最后总控 C04-C07。关联上游缺口事件 `evt_cf06ed7dde5f3fe752b408d8`；用户无需动 Git。

## 下一动作
本候选经本轮真实R1/R2/R3自测，仅作为无正式 D01 权限下的**预开发证据**。新 Git SHA/远端分支以实际提交与 ls-remote 后核验为准。不得将其记为已合法交独测，不以源代码候选冒充已经上线。正式准入恢复后要从新版本 main 重验差异并按原任务正常步骤执行。
