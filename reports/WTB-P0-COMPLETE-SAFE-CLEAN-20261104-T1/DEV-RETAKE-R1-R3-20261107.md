# C06 关单前安全清理｜开发续办 R1/R2/R3

- 任务：`WTB-P0-COMPLETE-SAFE-CLEAN-20261104-T1`（P0 infrastructure，解锁后置 P0 BUG）
- 新开发 actor：`wtb-dev-20261107-block-ready-takeover-d2`；Session：`wc_sess_20261107_block_ready_takeover_d2`
- 本轮正式 claim：`evt_d95f4cbcb80d52eb9adda697`；首次合法领取/自动解阻旧事件均已核对
- 工作区：新的独立 worktree；基线与远端 main 均为 `ac1e0c7c00cf870816c53f65be93049a51bae861`
- Ponytail：`full`，读取现有 `TaskStore.cleanupMergedDelivery`、调用与测试，最小复用原旧 WIP a36b198、6b7fcf8，绝不重开/覆盖旧 actor 工作区。

## 功能与范围

C04 合并、C05 运行回归 PASS 后，C06先拷贝可验证的 C05 报告到待删除工作区外部，验证其摘要，再核对归属、活跃 Jobs、其它 AI 和 PR 引用；仅当候选 Git SHA 已包含于 main、工作区清洁且无人使用时，执行非强制 `git worktree remove` / `git branch -d`，读回成功并写绑定 task、SHA、actor/Session、命令退出码的机器清理回执。旧路径与归档核对见 `server/task-store.mjs`。

严格不修改其它 AI 工作区、不强删、不动远端候选分支，不在本单实现 C07 关单门禁（关联 `WTB-P0-DELIVERY-COMPLETE-CLEANUP-GATE-20261106-T1`）。生产环境没有可信宿主 `inspectCleanupResources` 检查器时 fail closed（`C06_RESOURCE_UNVERIFIED`）；这项实际接入在部署前必须由总控核实，不得把单元测试注入的资源证明当生产证明。

## 三轮不同角度自测

- R1 正向：`node --test --test-name-pattern "C06 archives" tests/delivery-lifecycle.test.mjs` → **1/1 PASS、exit 0**，真实临时 Git 仓库完成归档与非强制安全清理。
- R2 反向：`node --test --test-name-pattern "C06 fails closed|C06 refuses" tests/delivery-lifecycle.test.mjs` → **2/2 PASS、exit 0**，未知归属、活动 Job、其它 AI、PR 共享、脏改、未合并、缺检查器均拒绝且保全。
- R3 交付兼容：`node --test tests/delivery-lifecycle.test.mjs` → **15/15 PASS、exit 0**（含旧交付、权限及真实 Git 兼容）。`node scripts/run-tests.mjs` 整仓回归已启动，最终结果在完成后补录；未有最终 0 失败前绝不交独测。

## 历史真实失败

旧原开发工作区两轮整仓测试曾因单文件 30 秒超时失败，D01 当时亦被缺新派工阻断；完整历史保留于 `DEV-SELFTEST-R1-R3-20261106.md`。本轮 D01 已凭真实 claim 和原系统恢复证据通过，当前 main 的测试脚本对长任务步骤测试已延长预算。未把旧失败伪装成成功。

## 交接边界

开发成功后固定当前分支远端 SHA，发布 `code_published` 与自测事件，以原子 `handoff` 进入唯一独测；只有独测 PASS 才由总控负责 C04～C07，并检验生产宿主接口。候选不代表 main 已上线。

## R3 初轮失败与真实复核（不隐瞒）

第一次在新分支运行 `node scripts/run-tests.mjs`：**61 个文件中失败 1 个，exit 1**，唯一失败文件 `task-auto-unblock.test.mjs` 的错误为 `spawnSync node.exe ETIMEDOUT`。测试运行器在 `scripts/run-tests.mjs` 对此文件默认仅给 **30 秒**；已输出的断言全部 PASS，未返回真正断言失败。该文件在相同候选中单独执行 `node --test tests/task-auto-unblock.test.mjs` **19/19 PASS，exit 0，28.4 秒**。这不等于官方全仓 PASS。

因本任务只负责 C06 归档/安全清理，不擅自扩权修改共享测试运行器；已在低竞争状态启动原整仓脚本第二次真实回归，Job `3be802e1-07ac-47c8-a98d-7d52a9abb63e`，结果待退出码。若再次超时，将保留原证据、登记共享根因，并在未达 R3 PASS 前保持本任务未交独测。

## R3 最终结果与当前候选交接

在最终源码不再修改的前提下，**第二轮**原仓库完整 `node scripts/run-tests.mjs` 实测：**61 个文件、0 个失败、退出码 0**，完成时间 `2026-11-06T17:35:29.123Z`，耗时 `327876 ms`。权威结果在本工作区 `data/runtime/validation/npm-test.json`（本地运行数据，未提交 Git）。这解决了旧原开发 R3 反复超时、第一轮本续办单文件 30 秒超时的证据缺口。保留这些真实 FAIL 的记录，不以第二轮 PASS 隐藏失败历史。

最终独立续办三轮：R1 真实安全清理 1/1 PASS，R2 真实负向 2/2 PASS，R3 交付模块 15/15 PASS + 全仓 61 文件全部 PASS；`git diff --cached --check` 和受影响的两份 JS 文件 `node --check` 退出 0。候选 SHA 以本报告所在 Git commit 与远端回读为准。

**上线约束**：本候选新增 C06 方法本身，生产环境的 `inspectCleanupResources` 宿主检查器没有与运行服务绑定时仍会拒绝清理。总控在最终交付时须核对宿主集成责任；关联 `WTB-P0-DELIVERY-COMPLETE-CLEANUP-GATE-20261106-T1` 负责 C07 回执门禁。不要将 C06 单元测试注入的检查器当成已部署机器证明。
