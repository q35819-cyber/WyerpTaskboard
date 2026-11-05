# WTB-P0-TEST-RUNNER-STEP-CHECKPOINT-TIMEOUT-20261106-T1｜开发自测报告

## BUG 与最小修复

- 原因：`scripts/run-tests.mjs` 对大多数单个测试文件设 `30000ms` 超时，而 `task-step-checkpoint.test.mjs` 包含39项复杂步骤/Session/接管测试，原C06两次全仓回归均因该文件 `ETIMEDOUT` 失败；独立执行该文件真实PASS，耗时约27–28秒。
- 仅一行修改：在既有 `90000ms` 有界预算名单中追加 `"task-step-checkpoint.test.mjs"`；保留 `service-control.test.mjs` 的180秒、`delivery-lifecycle.test.mjs`和`delivery-takeover.test.mjs`的90秒、其它文件30秒。
- 保留 `spawnSync` 的 `result.error || result.status !== 0`、failure记录、`state=failed`和 `process.exitCode=1` 逻辑。**不改任何测试断言、后端、其它文件预算或已完成任务。**
- 已读取最新 AGENTS、WORKFLOW、角色入口、流程更新日志，全文 Ponytail full。唯一授权源码文件 `scripts/run-tests.mjs`。
- 新开发actor `wtb-dev-step-timeout-20261106-bc1a988d`，正式Session `wc_sess_bc1a988d5ab247c0ad93ce6c628b445d`；总控派工 `evt_573d22d2609e5e6e1916343d`，正式预认领 `evt_a3ae744bdb40d3f81c71dad4`，claim `evt_56dda2dab3ed67e4d9a59f23`，代码变更事件 `evt_3b6623827edd8b21dd3230b1`。
- 干净独立 Git worktree `wyerptaskboard-1928d6e5-7f48-4ed1-9a67-27d15bff0e61`，源自 `origin/main 59a0b9443a593dd8fb2267ff0af314372faa7109`。原主目录未提交工作及其它AI占用均原样保全。

## 三轮实际验证

1. **R1 核心正向：** `node --test tests/task-step-checkpoint.test.mjs` → **39/39 PASS、exit 0、duration 27200.1401ms**；这个旧30秒预算临界文件现有90秒有界预算。
2. **R2 失败回流：** 使用OS临时目录的真实 `scripts/run-tests.mjs` 复制及独立极小测试夹具，未改仓库测试断言。插入真实断言异常 `EXPECTED_ASSERTION_FAILURE` 时，运行器真实 **exit 1，state=failed，failedFiles=1**；在仅复制夹具中将目标90秒临时同比缩短至200毫秒、插入4秒异步测试，真实产生 **ETIMEDOUT、exit 1、state=failed、failedFiles=1**。原源码保持90秒，其它预算不变。初版临时夹具错误把普通文件也缩至130毫秒，导致2个文件超时，已纠正并完整重跑两项PASS。
3. **R3 完整回归：** `npm.cmd test` job `edf503c4-c5ff-4c3a-a1c7-626edc8f02a3`，**60个测试文件、0失败、exit 0、durationMs=278863、data/runtime/validation/npm-test.json中state=passed**；`npm.cmd run check` exit 0；`node --check scripts/run-tests.mjs` exit 0；`git diff --check` exit 0。

## 交付及 BUG 三问

- 是否解决：候选的一行超时配置已解决原步骤文件30秒临界预算误判，正式运行版需唯一独测PASS后总控合main并重跑验证。
- 会不会复现：该文件专用预算90秒，仍有上限；如实际测试超过90秒仍会明确 `ETIMEDOUT` 并失败，不能保证环境无限慢时不超时。
- 后续流程：开发D01–D06已正式PASS；D07等R3完整通过；D08仅正式test-result PASS、远端SHA验证后才交唯一独测；总控负责main、验证、C06/C07。**本任务不自动解除C06另外两项阻断，也不修改它们。**
