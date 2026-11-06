# WTB-P0-DELIVERY-TAKEOVER-FIXTURE-RANDOM-PORT-20261107-T1｜正式开发自测报告

## 准入与身份
- 总控真实派工：`controller_dispatch evt_746673512487cb20f799345f`。
- 正式开发认领：`evt_1f8816107ee29ac63bebba24`，开发actor `wtb-dev-20261107-fixture-random-port-n2`，session `wc_sess_20261107_fixture_random_port_n2`。
- 原QA失败：`WTB-P0-TAKEOVER-BLOCK-AUTO-RECOVERY-20261106-T1`，`evt_620d079a2fadefceb6b0cca4`；保留旧 FAIL。
- 当前main基线：`0c425629f55274a2a324b3d78becf46a2cf70739`；**新干净隔离worktree** `D:/项目/.wtb-takeover-worktrees/WTB-P0-DELIVERY-TAKEOVER-FIXTURE-RANDOM-PORT-20261107-N2`。
- Ponytail full最小范围：源码仅修改 `tests/delivery-takeover.test.mjs`，从先前被取消单的候选只作参考、重新适配了本单 R1/R2，未复用旧自测结论或候选报告。

## 本次修复
- 随机监听成功后探测 `/api/auth/session`，仅 `error.cause.message === 'bad port'` 可有限次(10次)重新申请端口；
- 每次重试前必须 `server.close` 释放旧监听，非禁止端口网络错误、超时立即 FAIL，不吞真实错误；
- 正常/异常路径 `t.after` 关闭监听和删除临时fixture；
- 不修改生产后端、API、工作流、测试器超时及其它已完成任务。

## 三轮新任务开发自测
- **R1 正向**：`node --test --test-name-pattern "delivery takeover fixture retries only forbidden" tests/delivery-takeover.test.mjs`，真实1/1 PASS，退出码0，连续前两次人工bad-port，第三次真实fetch成功。
- **R2 负向及兼容**：`node --test tests/delivery-takeover.test.mjs`，真实14/14 PASS，退出码0，Job `697cab05-f0f8-40ac-9395-b99736dd1a24`，包含10次禁止端口耗尽、ECONNREFUSED/timeout立即失败，原授权/旧QA/伪造/过期检验回归，时长32043ms。
- **R3 整仓**：真实 `node scripts/run-tests.mjs` 61个测试文件、0失败、退出码0、durationMs=299492，Job `b412e62f-7cd4-4326-a53d-360d0277e202`，测试工件state=passed；`npm run check`与`git diff --check` PASS。
- **静态检查**：`npm.cmd --prefix <新工作区> run check` 执行成功；`git diff --check` exit0。

## BUG三问及交接
1. 根因已按最小代码修复，R1/R2及整仓R3开发自测全部PASS；仍需唯一独测和总控正式发布后确认实际部署有效。
2. 新增正向与负向回归防止回归，但任何系统/平台以后改动仍需独测复验。
3. 其它权限/交付测试14/14及整仓61文件零失败，唯一独测未完成；关联原QA失败单 `WTB-P0-TAKEOVER-BLOCK-AUTO-RECOVERY-20261106-T1` 必须在本修复正式发布后重新走原任务流程。

**本报告仅开发阶段，不能代替唯一独测PASS，也不表示已合并main。**
