# WTB-P0-QA-HOLD-REQUEUE-D01-CURSOR-20261108-T1 — N12 异常接管开发自测与交独测报告

## 固定身份、权威事件及边界
- 项目 WyerpTaskboard，P0 BUG。原开发 N11 `wtb-dev-20261108-q04-n11`，Session `wc_sess_fP21puVVIyEfK6Ss`；当前开发 N12 `wtb-dev-20261108-qa-hold-takeover-n12`，Session `wc_sess_OSzfq43X0igvjKI6`。
- 用户明确指令「符合条件直接接管，不要问」；其明确授权片段「直接接管」由正式接管服务端核验，接管事件 `evt_e76aebc527fb11820146ae4b`。疑似失联 `evt_4cf727a10bbc27be6a2fafb5`；原 actor / Session 在正式接管后失去写权，旧 N11 独立工作区及 176 行未提交差异完整保留。
- 首次提交全文授权被带有「不要问」的正则误判返回 `USER_SESSION_REQUIRED` 403，后以原文中明确片段依法重试成功。接管修改 task.updatedAt 使旧阅读票据失效，第一次写 D07 被 `RULE_READ_REQUIRED` 正确拒绝；重新服务端读取 13 文件 20 chunks，完成当前版情境验证 `evt_6c3451dc12b1f4e10c1a5836`，方可写 D07。
- 最新干净主线基准 `bce8d22b7a465ef2d1d3ff502d1a217a991f2eff`，新独立 worktree `D:/项目/.wtb-takeover-worktrees/WTB-P0-QA-HOLD-REQUEUE-D01-CURSOR-20261108-N12`，候选分支 `fix/WTB-P0-QA-HOLD-REQUEUE-D01-CURSOR-20261108-N12`。仅源码 `server/task-step-checkpoint.mjs`（+59）和 `tests/task-step-checkpoint.test.mjs`（+117）及本自测报告；N11 未提交源码只读转移、未覆盖或删除。
- 根因：旧唯一 QA Q01 合法拒绝后持久 HOLD，总控可信 HOLD→待开发 requeue 和后置 dispatch，新正式开发 claim 仍遇旧 `D09_NEXT` 光标、`CHECKPOINT_STEP_ORDER`。此补丁仅在真实 QA 证据、事务提交、事件顺序及新 Session 俱全时开启新 developer attempt D01；未改原业务卡写范围、QA PASS、STOP 或硬前置门禁。

## 三轮真实自测（N12 独立复测）
1. **R1 正常 / 生命周期**：独立工作区 `node --test tests/task-step-checkpoint.test.mjs`，作业 `wc_job_Nf-BGh640bBkFTrq`，49 / 49 PASS、exit 0；包含 QA admission HOLD 合法回流和新 D01。
2. **R2 安全 / 反例**：`node --test --test-name-pattern='QA admission HOLD|modern merge rework|legacy D09|D01 second recovery|v2 D01|QA BLOCK return|forged' tests/task-step-checkpoint.test.mjs tests/task-auto-unblock.test.mjs tests/delivery-takeover.test.mjs`，作业 `wc_job_QQtJD1fgN4zaUQkO`，20 / 20 PASS、exit 0；STOP、伪造事件、错误 actor / Session、旧证据、缺失前置拒绝。
3. **R3 全量 / 退化**：`node scripts/run-tests.mjs`，长时作业 `wc_job__RvWvTa7J1z9LN-Z`，62 个测试文件，`failedFiles=0`，exit 0，`durationMs=370089`，版本 0.7.0。之前 `wc_job_EpI_3TcTiakTfu9_` 因 120 秒 runner 限制 timeout / exit -1，不计为 PASS；已完整重跑取得上述最终 PASS。
- **静态检查**：`npm.cmd run check` exit 0；`git diff --check` exit 0。
- 步骤：原 N11 D01–D06 PASS 保存；N12 在当前正式 actor / Session 下 D07_TEST_3 PASS，operation `step.5775b461-ad6a-4324-aaf6-ceaa2136e94f`，当前下一步 D08_HANDOFF。尚未代替唯一独测、未合并 main、未执行总控发版/关单。

## BUG 三问（开发阶段）
1. **解决了吗？** 本隔离候选中 QA HOLD + 真 controller requeue + 后续派工 + 新正式 claim 恢复 D01 已通过正向测试，开发自测通过；生产发布前只能认定候选修复有效。
2. **下次还会复现吗？** 在三轮所覆盖合法与伪造负向用例中已防止旧游标误阻断及不可信重入；需唯一独测和发布后的原业务卡 `WTB-P0-QA-FAIL-READY-COLUMN-20261107-T1` 实测确认，不能保证未覆盖的新边界。
3. **后续流程正常吗？** 候选完整回归 62 文件 0 失败，D07 已合法进入 D08；唯一本任务 QA 三轮、总控 main 发布及原业务卡新 D01 还没完成。关联任务 `WTB-P0-QA-FAIL-READY-COLUMN-20261107-T1` 需在本门禁正式发布后继续。

## 唯一独测交接要求
- 独立测试以候选固定 Git SHA 与本报告 SHA 为准；真实复核已提交 QA HOLD/requeue/dispatch/claim 链、事务凭据、新 D01 / D02、15 类负向、旧失败记录保全、Git base 和安全回归。
- QA PASS 后仅总控执行受控合并/部署/生产 API 复核/关单；任何 FAIL 通过原合法返工流程，不能由本开发伪造独测或独自合并。
