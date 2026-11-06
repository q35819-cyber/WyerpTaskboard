# WTB-P0-BOARD-BLOCK-EVIDENCE-D08-AUTO-RESUME-20261107-T1 | 异常接管开发自测

## 身份与接管
- 用户明确授权异常接管，实际 takeover PASS：`evt_b93cfcab0b7f025bba6f13a4`。
- 原开发 actor `wtb-dev-20261107-board-block-d2`、Session `wc_sess_20261107_board_block_d2`，旧断点 D06_TEST_2 PASS（2026-11-06T20:15:55Z）。
- 新开发 actor `wtb-dev-d08-takeover-20261107-n2`、任务 Session `wc_sess_dcd4d3fa371e4d18880489d1a9e11349`；独立工具 Session `wc_sess_20089b35272c459ab12f7b4acdd10fc1`。
- 原开发基线 `0c425629f55274a2a324b3d78becf46a2cf70739`，新候选已对齐远端 `main` `e4e154f93210321665b8cde7a57530c1e1157b4c`（上游测试运行器修复已合并；本BUG两个代码文件在两版主线间无变化）。旧目录 `D:/项目/.wtb-takeover-worktrees/WTB-P0-BOARD-BLOCK-EVIDENCE-D08-AUTO-RESUME-20261107-D2` 只读保全，没有删除、stash、reset、覆盖。
- 从旧目录逐字节保留现有代码候选移入新独立 worktree；仅 `server/task-store.mjs`（SHA256 `dbd06f5ff1313ef36104b5ea2e42514c7f999c28b394a2d6d8d9b0af4a7053ba`）及 `tests/task-auto-unblock.test.mjs`（SHA256 `c0fef10cba73f7f1666d15ced21da8b2f4a5a647f76713a623b9d3545475eb83`）。
- 实际读取 Ponytail full；无新增依赖、无 UI、CLI、任务状态直接修改。

## 根因与最小修复
原阻断任务 `WTB-P0-BOARD-BLOCK-REASON-EVIDENCE-20261106-T1` 仍为「阻断」。来源 `developer_d08_pending_requirement_scope_gate_blocked`，经真实需求清零后旧 `eligibleTemporaryUnblock` 未识别此 D08 类型与修复中来源阶段，无法按机器条件恢复。
候选补齐该事件的可信自动解阻条件：旧 QA FAIL、同一开发人合法返修、冻住的可远端验证提交/报告、待拆和待用户补充清零、未读/STOP/硬前置等均守门；成功只允许 `阻断→待开发`，只写一次 `system auto_unblock`，仍须开发正式重入、独测和总控发布。负向伪证不恢复。

## 三轮自测
- R1 正向与 R2 负向：`node --test --test-name-pattern "D08 pending clears|D08 auto-unblock rejects" tests/task-auto-unblock.test.mjs`：2/2 PASS，退出码 0；作业 `ca1dcaf7-53af-437f-b8e3-e955112f0c7d`。
- 既有自动解阻完整回归：`node --test tests/task-auto-unblock.test.mjs`：21/21 PASS，退出码 0，约 42.2 秒；作业 `3015ef69-a82e-4123-9d65-1ff4e390ddfb`。
- 语法检查：`npm.cmd run check`，退出码0；`git diff --check`，退出码0。
- 原生 Node 测试发现模式：`node --test --test-concurrency=1 --test-reporter=spec`，作业 `7bdcd232-45b9-46cf-a7c7-4ec0eedb735f`，501 项中 500 PASS、1 FAIL（`erp-x20-integration.test.mjs`；当前独立项目映射无 `erp-x20`，属于旧环境集成测试；未改动 ERP）。该命令不是项目正式整仓清单，失败证据保留。
- R3 正式整仓：在最新主线的 `scripts/run-tests.mjs` 上运行 `node scripts/run-tests.mjs`，作业 `655efef2-a149-452f-8959-d8f818bd6c21`，**62 个测试文件、0 失败、退出码 0、durationMs=324199，PASS**；项目原生清单按设计不包含旧 ERP 集成环境测试。
- 合并准入：R1/R2/R3 均在隔离候选执行，后续仍需唯一独测从远端固定 SHA 独立检出，PASS 后总控合并、回归、重扫实际阻断。

## BUG 修复三问（待独测和总控）
1. 是否解决：在开发隔离环境已验证，线上原阻断仍未恢复；须独测/总控合并后重扫。
2. 是否会复现：候选R1/R2覆盖正常、并发、STOP、伪证、旧QA失败等路径；上线后其他环境仍须独测和真实主线验证。
3. 后续流程是否正常：候选验证 `system auto_unblock→待开发→合法认领`；独测、合并、实际阻断详情尚未闭环，禁止冒称已交付。
