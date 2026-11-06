# WTB-P1-CROSS-PROJECT-QA-VIEW-20261104-T1｜独测失败返修开发报告

- 原冻结候选：250470ffc2b6e2565aa756c1892c7987925ac63c。
- 原独测真实 FAIL：evt_469286487a7e63bd601772e6；真实历史 code_published.metadata.commitSha 有效，handoff.metadata.commitSha 缺失；UI错误显示待核验。
- 总控正式返修派工：evt_0f9b65fab1202de0a5e9efb4。
- 新轮 claim：evt_c5cdd55d8c9e2f182e74696c；开发 actor wtb-dev-20261107-cross-qa-rework-d1；Session wc_sess_20261107_cross_qa_rework_d1。
- 隔离worktree：D:/项目/.wtb-takeover-worktrees/WTB-P1-CROSS-PROJECT-QA-VIEW-20261107-D1；从旧失败候选检出，保留原历史及主目录128项未提交成果。
- 限定代码修改：web/app.js、tests/global-qa-queue.test.mjs；没有增加后端API、自动状态机、跨项目写入或主线合并。
- R1 正向：真实code_published.commitSha=250470ffc2b6e2565aa756c1892c7987925ac63c、remoteVerified=true、原开发handoff缺commitSha，页面仍可显示正确SHA；node --test tests/global-qa-queue.test.mjs，5/5 PASS，exit 0。
- R2 负向：不匹配开发actor、控制/测试角色事件、非法sha、remoteVerified false、缺branch、handoff后发布事件均返回待核验；不能使用其它项目历史，真实同ID分开；同一命令5/5 PASS，exit 0。
- R3 UI兼容：node --test tests/global-qa-queue.test.mjs tests/web-ui-contract.test.mjs，19/19 PASS，exit 0；node --check web/app.js 和 git diff --check PASS。
- R3 整仓：node scripts/run-tests.mjs 退出码 0；data/runtime/validation/npm-test.json：state=passed、61 个测试文件、failedFiles=0、durationMs=279522。- R3 合同兼容：node --test tests/global-qa-queue.test.mjs tests/web-ui-contract.test.mjs，19/19 PASS，exit0。
- 静态完整检查：npm.cmd --prefix <隔离worktree> run check 已实际完成；先前 shell 版超时未计 PASS；受影响文件 node --check 和 git diff --check 已通过。
- WIP状态：尚未冻结新Git SHA、尚未独测。不能以开发自测替代唯一独测，禁止自行main合并/关单。
- BUG三问：1. 原SHA展示BUG已被最小修复并经定向测试；上线待独测/总控。2. 已增正反回归减少复发，需整仓+独测确认。3. 跨项目队列读操作正常（19项UI兼容通过），但最终流程到交独测尚未完成。
