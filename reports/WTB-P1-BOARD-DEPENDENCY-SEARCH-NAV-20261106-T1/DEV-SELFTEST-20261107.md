# WTB-P1-BOARD-DEPENDENCY-SEARCH-NAV-20261106-T1｜开发三轮自测与 BUG 三问（2026-11-07）

## 来源、身份与代码范围
- 任务：`WTB-P1-BOARD-DEPENDENCY-SEARCH-NAV-20261106-T1`，P1 BUG；正式 claim 事件 `evt_ea19fbe24b135b44cc843f05`，状态开发中。
- 开发 actor：`wtb-dev-20261107-dependency-search-n3`；业务 Session：`wc_sess_825033eadb04469ab2c6ee5910162622`。
- 用户补充授权“BUG可以强制接”，原任务登记事件 `evt_f2e9703057f02540538cd272`。授权仅用于继续本任务已正式 claim 的 BUG，不代替独测或总控派工证据。
- 独立受管 worktree：本报告所在 Git 仓库；起点 `origin/main` = `e4e154f93210321665b8cde7a57530c1e1157b4c`。
- 修改范围仅 `web/app.js`、`tests/board-static-assets.test.mjs`；另附本自测报告。未修改主目录、其它 AI worktree、任务计划、服务端状态机。
- Ponytail：`.agents/skills/ponytail/SKILL.md`，full；复用 `applyFilters()`、`render()`、既有 `taskDependencies()` 与任务卡，未新增路由、API、依赖和数据库。

## 功能与根因
原有前置编号按钮调用 `openTask(ref.id,nested)`，会打开另一任务详情；卡片仅列出未完成前置，隐藏已完成的可继续跳转目标。现在通过 `filterBoardForDependency` 校验相同项目与注册任务，关闭旧详情、清空冲突过滤条件、填入完整 ID、切换看板、重置分页并运行现有全文过滤。任务卡展示全部注册前置（含已完成）。原卡片普通点击仍使用 `openTask`。

## 真实检查（候选源码）
- R1 正向：`node --test tests/board-static-assets.test.mjs`；首次 9/10 FAIL：跨 VM 空对象深比较的测试断言自身问题，修正后最终 **11/11 PASS，退出码 0**。
- R2 负向与兼容：相同测试中验证无效引用、路径/self、旧项目 epoch、已完成前置、与手工完整 ID 搜索一致（关联卡片也匹配）、原详情不被意外打开；`npm run check` **PASS，退出码 0**。
- R3 整仓：`npm test` **62 个测试文件、failedFiles=0、退出码 0**；运行器统计 `durationMs=311253`，软件版本 `0.7.0`。另运行 `git diff --check` **退出码 0**。
- 开发自测通过不等于唯一独测通过；尚未进行真实用户视觉验收。

## BUG 修复三问（仅开发候选阶段）
1. 问题解决了吗？候选代码和定向测试显示 **是**：前置编号会搜索看板而非打开新详情，完成前置可跳、过滤符合主搜索语义。
2. 下次会复现吗？同样输入的正向、边界和兼容测试有现有回归覆盖；但未正式部署，**不能保证线上不会复现**，仍需独立 QA + 总控主目录发布验证。
3. 后续流程正常吗？测试和应用兼容回归 **正常**；正式角色步骤 **尚未全通**：原 D01 `stepctl record` 被 `CHECKPOINT_PREDECESSOR_REQUIRED` 拒绝，缺可信总控 C01–C03/正式派工。已登记故障 `evt_7490156dcddf0d11ebcf1e6f`；依赖总控补真实前置后方可按规则记录 D01–D08 并正式 handoff 到唯一独测。关联父任务 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1` 仍为 HOLD，不能虚报已修。

## 交接说明
候选 Git SHA 与远端分支在提交/推送后通过原任务真实事件和后续报告追加固定；本报告不伪造自包含 Git SHA。下一步是完成安全 Git 候选，原开发继续补合法 D01 至 D08 断点，再正式交唯一独测；独测 PASS 后仅由总控合并主线、运行验收、清理与关单。
