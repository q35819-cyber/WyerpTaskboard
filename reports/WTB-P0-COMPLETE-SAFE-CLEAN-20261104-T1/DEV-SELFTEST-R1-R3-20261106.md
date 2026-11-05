# WTB-P0-COMPLETE-SAFE-CLEAN-20261104-T1｜C06开发自测与门禁

## 用户批准目标
- 先完成 C04 合并，再做 C05 合并后回归和实际运行 PASS，然后 C06 **先将回归证据归档、检查本任务资源占用、实际执行安全清理并生成机器回执**，最后由独立 C07 门禁任务验证回执并关单。
- 不修改 C07 关单门禁、不修改任何已完成任务和其他AI工作区。只更改 `server/task-store.mjs`、`tests/delivery-lifecycle.test.mjs`。
- 正式开发 claim `evt_75b52d5e415b2cacec6fa881`，合法预认领 `evt_d1acca53c7193f04ccb30f94`；开发 actor `wtb-dev-safe-clean-20261106-27d92cc0`、Session `wc_sess_27d92cc0c86d411cb09b289458675039`，独立干净 worktree 基线 `origin/main e58c204be5c1d7ac5c9676b32365075285857b3c`。main原有未提交内容保全。
- 复用 TaskStore 内原有 `verifyDeliveryCompletion`（真实独测PASS、总控claim/Session、候选已并入远端main、C05报告SHA核验与脏改防护）。

## 本轮实现
- 新增 `TaskStore.cleanupMergedDelivery`，仅合法总控交付中任务可调用；C05 原回归报告从已登记同仓库 worktree 读取后复制到 worktree **外部**的 `data/taskboard/archives/delivery-cleanup/<taskId>/<mainSha>/post-merge.md`，读回核对 SHA256。
- 临时资源清理前必须由可信宿主代码配置的 `inspectCleanupResources` 检查返回：同任务归属、活动 Job=0、其他所有者=0、开放PR=0。默认无可信检查器时**fail closed**，绝不接受客户端任意 boolean。另实际验证 worktree Git status 只有本次 untracked C05报告、候选本地分支SHA与独测SHA一致且已被main包含、工作区为真实同仓库独立worktree。
- 仅归档后删除原临时报告；真正释放资源只执行无强制参数的 `git worktree remove` / `git branch -d`，核对命令退出码并读回工作区/分支确实不存在。**远端分支一律不删**；回执记录任务、真实 SHA、actor/Session、文件摘要、相对归档路径、非强制命令退出码，并写事件 `delivery_cleanup_verified`。
- 不调用`delivery_complete`，不改变任务状态。后续 C07 自动拒绝无回执的 complete 属独立 P0 `WTB-P0-DELIVERY-COMPLETE-CLEANUP-GATE-20261106-T1`。
- 技术边界：可信宿主 `inspectCleanupResources` 与任务看板实际运行服务的连线尚未在本卡授权范围内集成，因此无检查器的实际运行端会保留工作区并返回 `C06_RESOURCE_UNVERIFIED`。正式上线前独测/总控应核实机器检查器接入责任和不会将测试fixture的假资源状态视为生产证据。

## 三轮测试及实际命令
- R1：`node --test --test-name-pattern "C06 archives" tests/delivery-lifecycle.test.mjs`，**1/1 PASS**，真正创建Git临时仓库/候选分支、合并、归档、清理、读回回执和原交付中状态。
- R2：`node --test --test-name-pattern "C06 fails closed|C06 refuses" tests/delivery-lifecycle.test.mjs`，**2/2 PASS**，拒绝不明归属、无检查器、活动Job、其它AI、开放PR、脏改、未并main。无强删。
- R3相关旧功能回归：`node --test tests/delivery-lifecycle.test.mjs`，**15/15 PASS**（含所有原测试）；`npm.cmd run check`、`git diff --check`均PASS。`npm.cmd test` job `471002ed-01a0-462f-b3bd-48f6cd08f9f8` **第一次全仓 60 文件中 1 文件超时失败，exit 1**：tests/task-step-checkpoint.test.mjs 进程因 30秒/文件硬超时 ETIMEDOUT（该文件 33 项用例已实际通过才被脚本杀死）；该文件单独执行 node --test tests/task-step-checkpoint.test.mjs **exit 0**、耗时28秒；整仓第二遍 npm.cmd test job c023dd59-e0d2-4555-a955-8879c3e3d44f **exit 1，60文件中1个 task-step-checkpoint.test.mjs 再次30秒超时 ETIMEDOUT**，其余59文件通过；两次整仓均不满足R3 PASS，禁止交独测。第一次失败证据 data/runtime/validation/npm-test.json（随后第二遍会覆盖运行时快照，原报告保留此事实）。
- 变更登记 `evt_30374aafd0d415a3aa44f34a`；两份源码/测试旧SHA和新SHA写入本worktree `data/logs/changes/2026-11-06.jsonl`，读回PASS。

## R3根因界限与恢复条件
- 整仓 runner scripts/run-tests.mjs 将多数测试文件每项限制30秒；独立复测任务步骤文件实际exit0约28秒。两次整仓该文件均因时限触发，属于**待总控独立任务修复/测试运行环境复核**，本C06不能擅改其他文件；修复后必须重新执行全量整仓，不能复用这两次失败为PASS。
- 此外正式运行端未安装可信inspectCleanupResources检查器时将自动拒绝清理（C06_RESOURCE_UNVERIFIED），总控发布前须核验责任和接入条件。

## 正式步骤阻断
- 当前原任务真正 `claim` 成功，状态「开发中」，但 `node cli/stepctl.mjs record ... D01_CLAIM --event-id evt_75b52d5e415b2cacec6fa881` 实际**exit 1 `CHECKPOINT_PREDECESSOR_REQUIRED: 总控未完成可信正式派工`**。总控此前两个事件 `evt_2e9a1c9cfe0238d44d6c6447`、`evt_10c5136a3753248593cc777a` 是规则/顺序批准，不是 `controller_dispatch`。开发者不得冒controller补事件。
- 已通知总控原Session `wc_sess_26abfde9797a48e3bd17d116f2c47de5`（消息 `wc_msg_44f27a99a9c54a34a6d48ccc6114a222`）依法补发正式派工并读回。修复前D01不得写PASS、D08不得交独测、不得自合main或close。
- 若派工缺失未补齐，即使三轮代码测试PASS，**只能冻结远端WIP候选、保留真实BLOCK**；C07功能必须另任务独测发布，不得虚报已全部实施。
