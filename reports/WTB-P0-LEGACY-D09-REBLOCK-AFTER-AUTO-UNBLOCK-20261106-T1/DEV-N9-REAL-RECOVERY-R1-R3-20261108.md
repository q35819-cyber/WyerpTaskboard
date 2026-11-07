# WTB-P0-LEGACY-D09-REBLOCK-AFTER-AUTO-UNBLOCK-20261106-T1｜开发 N9 复核与交独测

## 当前事实（仅开发候选）
- 项目：WyerpTaskboard；角色：developer_ai；actor: wtb-dev-20261108-legacy-d09-reblock-n9；Session: wc_sess_aJQ-jIiN76JmXDyI。
- 正式新认领：evt_4d56996c3dea38f75d1d8508；状态原待开发→开发中，STOP=false，前置两项已完成。
- 最新已完成根因前置：WTB-P0-D01-REENTRY-AUTOUNBLOCK-STATE-RECOVERY-20261108-T1；正式主线提交 cddc24d0309dd1c3295a313d4220d6dceab80ea0，main merge基准 8ca613bec63b7fdd571db4fc73eb49c0eb9e2a13。
- 旧正式 WIP fbcfa0f8831eb04b54854c87af6d60c075d20781 已保全、不覆盖最新main。本任务不重写前置任务已上线的同根因源码；本候选只有本任务复核报告（代码与最新基准一致）。
- 原 checkpoint 的 D07_TEST_3 BLOCK attempt1 保留。新一轮真实 stepctl record D01_CLAIM PASS attempt2（操作 step.535d2697-365b-406a-bc3b-2708fab9c073），随后 D02 / D03 / D04 / D05 / D06 / D07 均按序 PASS；没有绕过步骤门禁。

## 开发三轮实际检查
1. **R1 正常功能**：node --test --test-name-pattern="D01 second recovery once reaches D02|legacy D09 starts a new D01" tests/task-auto-unblock.test.mjs tests/task-step-checkpoint.test.mjs；2/2 PASS，exit 0；并以实际当前任务 D01 → D02 复核。
2. **R2 异常与安全**：node --test --test-name-pattern="D01 second recovery rejects|legacy D09 blocks missing dispatch|v2 D01 never retroactively accepts|modern merge rework refuses missing or forged chain" tests/task-auto-unblock.test.mjs tests/task-step-checkpoint.test.mjs；4/4 PASS，exit 0；测试作业 wc_job_dOq25Yjvi5dz1Qv_；错 actor / Session、STOP、缺可信交易/派工、伪造授权未放行。
3. **R3 整仓回归**：node scripts/run-tests.mjs；作业 wc_job_7zt-fGMlXvv9jYjf，最终 completed exit 0；62 test files、failedFiles 0、durationMs 388348、package 0.7.0。
4. **静态检查**：npm.cmd --prefix <本任务N9独立工作区> run check，exit 0。
- 以上开发证据不能替代唯一独测；没有人工移动原阻断状态、没有修改其它任务与主目录。
- 本报告为复核候选，不表示独测 PASS、总控已合并或完成关单。

## BUG 修复三问（开发阶段）
1. **解决了吗？** 已在最新主线代码和本任务真实新一轮 D01 验证该已报告的旧 D07/D09 断点问题可恢复；新代码根因由前置 P0 交付，而非 N9 重新实施。
2. **下次会复现吗？** 在测试覆盖的可信 auto_unblock、正式新 claim、STOP、事务 journal、Session 和依赖条件下已验证不会再次阻断合法新轮次；不能保证未知新场景，仍需唯一独测与后续监测。
3. **后续流程正常吗？** 开发 D01–D07 与 62 文件整仓回归正常；独立QA、总控合并/上线验证与正式关单尚未执行，不能声称整条交付流程已完成。

## QA 与总控下一动作
- 唯一独测：独立actor/Session，核验本报告与候选 Git SHA，三轮独立执行真实 D01 旧 BLOCK→自动解阻→新 claim/新 attempt、负向拒绝与整仓回归。不得把开发 PASS 复写为独测 PASS。
- 若独测 PASS：总控核验候选仅复核报告且源码修复已在main，受控执行 C04–C07、真实本机服务版本/运行验证、安全清理和最终关单。
- 如 QA FAIL：原任务退 N9 或依法接管修复，保留历史和证据，不扩大已完成前置任务范围。
