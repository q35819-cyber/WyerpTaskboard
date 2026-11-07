# WTB-P0-MULTIPROJECT-FIXTURE-SAFE-PORT-20261107-T1｜开发修复及三轮自测

## 身份与范围
- P0 BUG：`WTB-P0-MULTIPROJECT-FIXTURE-SAFE-PORT-20261107-T1`，正式总控派工 `evt_54b2d10aa26ea67bc70b07f3`，开发认领 `evt_de3986fbe989ca6bc34bd4f6`。
- 开发 actor `wtb-dev-20261107-multiproject-safeport-n4`、业务 Session `wc_sess_825033eadb04469ab2c6ee5910162622`；独立 managed worktree，起始 `origin/main=bfe52ee2e49eb75b495571d5949efe67b4c78e0a`；分支 `fix/wtb-p0-multiproject-safe-port-20261107-n4`。
- Ponytail full。只修改 `tests/multiproject-lifecycle.test.mjs`，参考已有 `tests/delivery-takeover.test.mjs` 的已发布安全监听实现。不改生产源码、任务状态引擎、其它测试文件或任何其他 AI 的工作区；本地主目录 WIP 保留。
- 原始BUG：多项目测试的随机 `listen(0)` 端口偶发被 Node fetch 认定 `bad port`，造成原任务 `WTB-P0-MAIN-DIRTY-RULE-WIP-FF-RECOVERY-20261107-T1` 整仓R3 62文件1 FAIL。原开发失败 `evt_3d519f4f67832c3eec88b3d9`、阻断 `evt_b8dd67ab5cf1a4db96c135b6` 未删除。

## 最小代码修复
- 增加 `listenOnFetchSafePort(server, probe=fetch)`，随机监听后先发真实HTTP探测；**仅** `error?.cause?.message === "bad port"` 时关闭当前监听并重试，最多10次。
- 其他错误（例如 `ECONNREFUSED`）第一时间原样抛出；重试耗尽抛出原 `bad port` 错误；所有已监听失败路径关闭端口。
- 将原 `setup(t)` 的监听替换为该辅助函数，提前注册 `t.after` 清理；不改变任何原多项目状态/历史/身份隔离断言。
- 在同文件增加真实模拟连续2次坏端口后成功、已关闭两次、非坏端口仅1次并关闭、10次上限且10次释放监听的负向测试。

## 三轮真实自测
1. **R1 正向及注入测试**：`node --test tests/multiproject-lifecycle.test.mjs` → **4/4 PASS，exit 0**，原3个多项目流程测试及新安全端口测试通过。
2. **R2 负向及邻近兼容**：`node --test tests/multiproject-lifecycle.test.mjs tests/delivery-takeover.test.mjs` → **18/18 PASS，exit 0**，覆盖坏端口2次、非坏端口、10次耗尽、监听close、原交付接管负向；`npm.cmd run check` → **exit 0**，`git diff --check` 尚待核对。
3. **R3 最新main整仓**：`npm.cmd test` Runner job `adef9174-5628-4ed3-b45b-566653480e66` → **62 个测试文件、failedFiles=0、退出码 0、durationMs=337227**。`npm.cmd run check` 退出码 0；`git diff --check` 退出码 0。整仓真实0失败是开发自测，不是唯一独测。

## BUG修复三问
1. 问题解决了吗？**开发候选已解决本测试夹具的随机禁用端口问题**，R1 4/4、R2 18/18、R3 62 文件 0 失败，但唯一独测、主线发布尚未完成。
2. 后续会复现吗？通过仅重试可信 bad port 且有限10次显著降低同类偶发失败；耗尽上限会明确 FAIL，不保证所有未知端口或其它网络错误都不存在。
3. 后续流程正常吗？已正式 D01–D06 PASS，R3 真实通过；待登记 D07 和 D08 正式交唯一独测。唯一QA、总控合并/运行验证均未完成。根因正式发布后才能重审原 `WTB-P0-MAIN-DIRTY-RULE-WIP-FF-RECOVERY-20261107-T1`；不可替其跳过D01门禁或清理主目录WIP。

## 交接条件
第三轮整仓已真实0失败。提交本报告、固定新候选SHA并远端推送，登记开发测试 PASS 和本任务D07；用同一真实actor/Session完成原子D08交唯一独测。唯一QA再独立取得候选SHA与进行三轮测试；PASS后总控依序C04–C07，不代QA、不自行合main。
