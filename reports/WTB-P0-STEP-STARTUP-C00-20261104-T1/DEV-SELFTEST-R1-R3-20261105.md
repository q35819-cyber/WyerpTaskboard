# WTB-P0-STEP-STARTUP-C00-20261104-T1｜开发三轮自测与独测交接

## 基线与权限
- 项目：WyerpTaskboard（独立 Git worktree）
- 正式开发 actor：`wtb-dev-isolated-parallel-20261105-27d92cc0`
- 正式 taskctl Session：`wc_sess_27d92cc0c86d411cb09b289458675039`
- 认领事件：`evt_6bfb625f4a9d7d68755b46eb`；正式步骤 D01–D07 均已登记 PASS
- 基线：`origin/main` `1c03b4147b73c1343354c85f72c584cf545fbfc6`
- 独立分支：`feat/WTB-P0-STEP-STARTUP-C00-20261104-T1`
- 候选最终 Git SHA：以正式交接事件及远端 SHA 为准；本报告与源码一起提交，未合并 main
- Ponytail full：实际读取并采用现有结构与测试基础，不加新依赖或新框架

## 唯一目标与最小修改
只改 `server/task-step-checkpoint.mjs`、`tests/task-step-checkpoint.test.mjs`。在 v2 总控启动中，`C00_A_REQUIREMENTS`、`C00_B_MAIN_VERSION`、`C00_C_SAFE_CLEANUP` 的 PASS 必须引用同一任务历史中正式事件，事件 actor/Session 与记录身份一致，证据字段有效，且不能复用已消费的事件或跳过前序步骤。旧 `role-steps-v1` 游标兼容保留；失败不会写成 PASS，也不会推进断点。

- `controller_requirements_reviewed`：`requirementsReviewed=true` 且有非空 `requirementEvidence`。
- `controller_main_version_verified`：`gitExitCode=0`、本地与远端 main 的 40 位 SHA 相同、软件版本格式有效。
- `controller_safe_cleanup_verified`：`resourcesChecked=true`、清理结果 `clean/archived/preserved`，有核验依据；保全情形附 `nextAction`。
上述事件字段用于验证已登记的核验结果；不代表模型单凭聊天即可替代真实 Git/资源检查。

## 三轮开发实测
1. **R1 正向与专项回归 PASS**：`node --test tests/task-step-checkpoint.test.mjs`；37 项、37 PASS、0 FAIL、退出码 0；最终实测 `duration_ms=25075.932`，低于当前单文件 30000ms 超时。覆盖 C00 合法事件、新旧游标、交接、失败回流、Q01 重入、接管等原有路径。
2. **R2 负向 PASS**：`node --test --test-name-pattern="v2 C00 PASS requires fresh" tests/task-step-checkpoint.test.mjs`；1/1 PASS，退出码 0。实际断言缺失 eventId、错误 actor、需求标记错误、Git 退出非零、主线 SHA 不一致、清理未检查或保全缺下一动作均拒绝且断点 SHA 不改变；C01 不得跳过 C00。
3. **R3 整仓兼容 PASS**：`npm.cmd run check` 退出码 0，`npm.cmd test` 本轮 Job `32507941-1249-4860-9b81-89596324d2bd` 退出码 0；57 个测试文件，`failedFiles=0`，总时长 274648ms；`data/runtime/validation/npm-test.json` 为 `passed`，该基线的 package 版本为 `0.6.63`。`git diff --check` 通过。

## 保留首次 FAIL 与整改
原完整回归 Job `88185070-c125-470d-9490-a7f5e027b77a` 退出码 1：57 个文件中仅 `task-step-checkpoint.test.mjs` 因单文件 30000ms 超时 `spawnSync ETIMEDOUT` 失败（不是断言失败）。正式历史记录 `evt_f9c7813207d3e97f33812d61`。
整改严格在授权测试文件中，将四组**各自使用独立 fixture**的多场景循环并行执行，没有放大测试超时或修改通用 `scripts/run-tests.mjs`，专项耗时从超过 30s 降至约 25.1s；随后 R1、R2、R3 全部重跑 PASS。变更操作日志位于本工作区 `data/logs/changes/2026-11-05.jsonl`，真实源文件哈希及操作记录已经登记；无需覆盖其它 AI 的工作区。

## 修复三问（开发候选阶段）
1. **问题解决了吗？** 当前隔离候选能够拦截缺少可信 C00 正式事件及无效结果的 PASS，R1/R2/R3 通过；尚未由独测和总控发布，不称生产已生效。
2. **相同问题还会复现吗？** 当前候选针对上述非法输入有回归测试；正式 main 未合并前，生产仍可能沿用旧门禁。更广泛的服务器门禁整合属于已存在的关联任务 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1`，不得在本任务扩大范围。
3. **后续流程正常吗？** 开发三轮、完整回归和当前待交接步骤正常；唯一独测、总控串行合 main、合并后回归和合法 complete 仍需执行。共享写路径 409 是独立 P0 任务 `WTB-P0-ISOLATED-PARALLEL-CLAIM-GATE-20261105-T1`，本任务不宣称修复。

## 下一责任
唯一独立测试 AI：从远端固定候选 SHA 重新取代码，检查正式事件的合法/非法路径、测试超时及旧流程兼容，三轮独测 PASS 后交总控（而非开发）执行受控合并、发布回归与关闭任务。
