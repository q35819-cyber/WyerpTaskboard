# WTB-P0-ATOMIC-PRECLAIM-LEASE-20261108-T1｜开发返修证据 S29（2026-11-08）

## 原独测 Q01 FAIL 与真实根因
- 唯一独测 FAIL 事件：`evt_396a3a79ff433b4c0b4fa1a1`；状态从`待独测`退回`测试失败待修复`。
- 原开发本地候选 `c02c6708b3e8f07c56e3731a5bbb21e3f6599d2f` 未发布到远端可核验分支，缺少同一开发会话可信 `code_published`、远端 SHA 核验和候选内追踪的报告，因此不能让本地测试 PASS 代替 Q01 准入。
- S24 历史随机端口整仓失败与 S26 独测本地 PASS 均保留；本轮不能冒用旧独测 PASS。

## 本轮开发合法性及候选保全
- 正式新开发 claim `evt_2aff9c13f631b97b0f239d6f`，actor `dev-gpt6-atomic-qa-rework-20261108-s29`，Session `wc_sess_uSamIkSu_BLp97WF`，登记状态`修复中`，STOP=false，无登记硬前置；规则 22 分块，情境验证 PASS `evt_2fcd44b6895afc3037c50ad4`。
- 从当前主线 `f782993d4237d7fb76aaf59ad649fa1f2e75cbb7` 在隔离worktree建立分支，`git merge --no-ff` 无冲突纳入原候选 `c02c6708...`；保留原候选所有代码、失败历史，不改主线。
- 代码差异仅原任务授权的五个源码/测试路径：`cli/taskctl.mjs`、`server/http-server.mjs`、`server/task-store.mjs`、`tests/delivery-lifecycle.test.mjs`、`tests/task-store.test.mjs`。本报告只用于追溯测试。
- 返修隔离分支：`fix/wtb-p0-atomic-preclaim-lease-qa-rework-s29`；推送后已用 `git ls-remote --heads origin` 验得初始合并提交 `1e625042823fe433f34ecc499bbaf0899542d718`。本报告随分支提交后应重新获取远端最终 HEAD。

## 三轮开发自测（本轮真实执行）
| 轮次 | 实际命令 | 结果 |
| --- | --- | --- |
| R1 负向及HTTP并发 | `node --test --test-name-pattern "atomic preclaim\|preclaim failure\|preclaim honors\|HTTP preclaim API" tests/task-store.test.mjs tests/delivery-lifecycle.test.mjs` | exit 0，4 tests，4 PASS |
| R2 关联流程回归 | `node --test tests/task-store.test.mjs tests/delivery-lifecycle.test.mjs` | exit 0，42 tests，42 PASS，0 FAIL（76604ms） |
| R3 整仓回归 | `node scripts/run-tests.mjs` | exit 0，62 files，failedFiles=0，durationMs=445703，package v0.7.0 |

## D01 真正阻断，不能伪造正式交测
- 新开发完成正式claim后在主目录运行 `node cli/stepctl.mjs record ... --step D01_CLAIM`，真实 exit 1 `CHECKPOINT_STEP_ORDER`：原开发的 `D09_NEXT` 已 PASS、checkpoint `developer_ai` cursor 为 null；独测 Q01 失败退回并未为合法返修轮次重新打开 D01。
- 正式开发问题事件：`evt_91bc159b98c6223ed616a6d0`，含 `failureCode=CHECKPOINT_STEP_ORDER`、`paused=true`、`relatedTaskIds` 与下一合法动作。
- 独立根因任务 `WTB-P0-TAKEOVER-D09-MANUAL-REQUEUE-D01-20261108-T1` 当前尚待总控 C07 完成交付与生产验证，**不得**假写 D01/D07 PASS，亦不得冒充已登记 `code_published` 或正式 D08 交接。本次仅完成Git候选保全与真实回归。
- 恢复：根因程序正式上线、生产步骤门禁实际允许新轮次D01后，本Session（或唯一合法接管者）重走D01-D07，基于最终远端 SHA 和此候选内报告计算 SHA256，真实登记 `test_result PASS` 与 `code_published`（commitSha/branch/remoteVerified/reportSha256），再D08交唯一独测Q01-Q04；不自行合并main。

## BUG 三问
1. 原QA发现的远端分支不存在问题：**新返修分支已真实上传且 SHA 经远端核验**；正式 Q01 证据链仍未闭环。
2. 是否不会再次复现：**尚不能保证**。D01返工重入根因未正式发布前，同类返修仍可能被 `CHECKPOINT_STEP_ORDER` 卡住。
3. 后续流程是否正常：**尚未恢复**。本轮源码R1/R2/R3通过，但仍需正式步骤、code_published、唯一独测与总控交付，不能宣称整体PASS。
