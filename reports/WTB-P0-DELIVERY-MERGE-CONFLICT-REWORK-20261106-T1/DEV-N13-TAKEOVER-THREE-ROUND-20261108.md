# WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261106-T1｜N13 异常接管开发三轮自测与交独测报告

## 真实来源、身份、候选及最小改动
- 项目 WyerpTaskboard，P0 BUG；原 N5 开发 actor `wtb-dev-20261108-merge-conflict-takeover-n5`、Session `wc_sess_S-JHRQJVIo0cmT0t`；本次 N13 开发 actor `wtb-dev-20261108-delivery-rework-takeover-n13`、Session `wc_sess_GJ-bFGlx5GDPwB9G`。
- 用户常设授权“符合条件直接接管，不要问”；原 N5 超过 5 分钟无真实活动，原 Session Jobs=0；疑似失联事件 `evt_7a9f56e83c2fe067ba6f5c7a`，正式原子接管事件 `evt_be02171cc717f08236378dfc`，旧 actor/Session 已撤权；原 N5 工作树完整保留、远端候选 `2a464edae65c3428d438a94a2713282f9c2a67cb` 未覆盖。
- 技术前置 `WTB-P0-Q04-TAKEOVER-D01-STEP-RESET-20261108-T1` 已唯一独测 PASS 且总控交付，上游确认事件 `evt_32c73e4a01cf9c7aa6334481`；本原任务从旧 Q04_PASS、developer 游标 null 以新 N13 正式接管 `D01_CLAIM` 真实 PASS、attempt 2（`step.2e10cc96-10a5-4362-84cb-26e3716d30c4`），旧 QA 与失败历史保留。
- 本次独立 clean worktree 基于 `origin/main` `a252807ac336e64cdffa295de7cb3b5d0bd18888`，branch `fix/WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261108-N13`。从 N5 正式 WIP commit `c3d7ac2` 精确移植 5 个授权文件，`git apply --3way --check` 和实际应用均无冲突：
  1. `server/task-store.mjs`
  2. `server/http-server.mjs`
  3. `server/workflows/wyerp-ai-flow-v1.mjs`
  4. `cli/taskctl.mjs`
  5. `tests/delivery-lifecycle.test.mjs`
- 改动限于 controller 真实 Git merge 冲突时的受控返原开发通路；核验原 QA PASS 与候选 SHA、真实 merge 失败、远端 main SHA、原开发身份和 STOP；旧 PASS 不直接当新候选独测通过。**未更改主目录、流程规则、其它任务计划或旧 WIP。**

## 开发三轮不同角度的真实执行
1. R1 核心正向与生命周期：在 N13 独立候选的 `tests/delivery-lifecycle.test.mjs` 执行 `node --test`，Job `wc_job_E5L-M65SqzDQP1zK` exit 0，**18/18 PASS**，涵盖真实 Git 冲突返修、controller HTTP、独测证据保全与旧 PASS 作废。
2. R2 安全负向与角色/断点：工作目录明确为 N13 worktree，`node --test tests/task-store.test.mjs tests/delivery-takeover.test.mjs tests/task-step-checkpoint.test.mjs`，Job `wc_job_8_GgktIzngnXf9nR` exit 0，**83/83 PASS、0 跳过**。覆盖 STOP、错误/失效 SHA、冒充 controller、并发、非法提交、旧 Session 撤权、已读规则票据、依赖及 QA 门禁。此前从脏主目录 cwd 运行同测试时，虽加载 N13 测试文件却因用 `process.cwd()` 比较了主目录内暂不同步的流程副本而出现 82/83；主目录同断言亦复现。经核实是 cwd 不正确，改从干净 N13 目录执行后同断言和完整 R2 全 PASS，**未跳过/篡改测试**。
3. R3 完整整仓/回归与服务控制：在 N13 clean cwd 运行 `node scripts/run-tests.mjs`，Job `wc_job_yr7G_hvjG5vy2Gt7` terminal **exit 0**，62 test files、**failedFiles=0**、durationMs=413010、package 0.7.0；最后的 `service-control.test.mjs` 11/11 PASS。
4. 静态与代码范围：`npm.cmd --prefix <N13 worktree> run check` exit 0，`git diff --check HEAD` exit 0；正式 D01–D07 checkpoint attempt2 按序 PASS，D07 operation `step.81f361da-67d5-4cd2-b388-67aff738bc77`，交接前当前下一步 D08。

## BUG 三问（开发阶段）
1. **问题解决了没有？** 最新主线的 Q04 重入根因已经正式发布，N13 实际 D01 attempt2 成功；在候选代码中受控 Git 冲突返修路径和 3 轮自测全部通过。**尚未唯一独测和总控合并本新候选**，不能宣称生产流程已经修复。
2. **下次会不会复现同类问题？** 所测正常和负向条件下均不会重复阻断合法接管，伪造冲突/旧 SHA/STOP/旧 Session 均被拒绝；发布后仍须验证真实原业务卡 `WTB-P1-READY-BUG-COUNT-20261106-T1` 的回流与重新 QA，未知场景不能保证。
3. **后续流程是否正常？** 开发唯一接管、D01–D07、源文件隔离、完整回归均正常；唯一 QA 的 Q01–Q04、总控合并/部署/安全清理/正式关单未完成。本任务 QA PASS 和发布后才能解除原业务卡的交付冲突。

## 独立测试与总控交付注意
- 唯一独测须独立 actor/Session，在远端冻结 Git SHA 上执行三轮正向/安全/回归，校验真实冲突 Git 证据、角色与原开发约束、新候选作废旧 QA 结果、STOP 防护，不能引用 N13 自测充当独测。
- QA PASS 后仅总控负责串行 main 合并、生产代码版本检查、服务 HTTP 实测、关单前清理与释放；如 FAIL 必须按原任务返工，不覆盖旧 N5 工作区或原业务候选。
