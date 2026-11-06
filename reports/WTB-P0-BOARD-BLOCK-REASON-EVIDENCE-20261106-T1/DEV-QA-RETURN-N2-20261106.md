# WTB-P0-BOARD-BLOCK-REASON-EVIDENCE-20261106-T1｜原开发独测 FAIL 合法返修 N2（2026-11-06）

## 正式流程与权限
- 原唯一独测正式 FAIL 事件 evt_8a5b3f3015e5e9b73056549f，报告 reports/WTB-P0-BOARD-BLOCK-REASON-EVIDENCE-20261106-T1/QA-Q02-FAIL-20261106.md，旧冻结候选 SHA 056049d55e547759d12df1fa7c38ee411e94aaff 保留。
- 原开发 actor wtb-dev-board-block-reason-20261106-n1，以新 Session wc_sess_f84557a927c54864ada9999cd2cd1958，正常 preclaim evt_796cc8867f4365aa037e6f09，claim evt_dd361bf85d60a7932c1bada2（测试失败待修复→修复中），未使用强制或越权权限。
- 新隔离 worktree wyerptaskboard-30cc91dd-e116-46f9-8cd8-cdf4987005fe；分支 fix/WTB-P0-BLOCK-EVIDENCE-QA-RETURN-20261106-N2，基线 origin/main SHA 355137f33ff7401d6c47e30a1659988aa43e829a；主线与其它AI工作区不动。
- 旧候选 cherry-pick 真实冲突在 server/http-server.mjs 和 web/app.js；均属本任务授权范围，已保留最新主线实时状态订阅、多级依赖跳转以及旧候选阻断详情。原历史与QA FAIL证据均未改。

## 最小整改 F01–F04
- F01/F02：只接受当前状态真实 test_ai test_result FAIL 事件及同一任务 reports/<ID>/<safe-name>.md 路径；路径必须留在项目根内且无reparse/symlink，报告最多1MiB；从报告实文中提取 F01/F02 等失败项。目录越界、其它任务、开发冒名的QA事件不得获取证据。
- F03：只读现有 ScanStore 的候选，严格匹配 project_id、task_id、task.status、task.updatedAt、registryRevision、detected_at 不超过30分钟、expires_at 未到期、非 stale/consumed、blockers 为非空有效文本。无可信扫描时明确显示历史事件，verifiedCurrentCause=false，绝不虚报当前根因。**不新增扫描服务、不自动解阻**。
- F04：普通历史 note 全文保留，不再强制1200字截断；token/密码/手机号/邮箱等敏感内容仍整段隐藏。卡片摘要仍限制240字，详情展示独测报告、失败项目、扫描时间和恢复条件。

## 三轮测试与真实数据
- R1：独立worktree运行 node --test tests/blocker-evidence.test.mjs **15/15 PASS、exit 0**，新增真实HTTP报告读取、扫描匹配等6组测试；JS模块node --check四项均exit0。
- R2：同专项覆盖12类无效扫描、报告路径穿越/冒用、1600+普通备注和敏感内容，**15/15 PASS**；UI兼容 node --test tests/board-static-assets.test.mjs tests/web-ui-contract.test.mjs **22/22 PASS**；git diff --check exit0。只读真实项目回放：CROSS-PROJECT-QA-VIEW测试失败待修复的 evt_469286487a7e63bd601772e6 报告和失败项正确；ONBOARD-COMMAND-VERIFY已被其他开发领取为修复中，故当前不应显示旧QA FAIL为当前根因。
- R3 第一轮整仓 **62文件1失败/exit1**，Job 7b6e66d8-276c-4e62-a74e-55979ae55517；仅 logging-coverage.test.mjs 检出本轮新增的 server/http-server.mjs 空catch回退。已按最新规范改为 verifiedScanCandidates：失败写系统日志并返回无当前扫描依据，防止假当前阻断。重新独立复测 logging-coverage **4/4 PASS**、阻断证据 **15/15 PASS**、UI兼容 **22/22 PASS**，Node语法通过。R3整仓最终重跑 Job 958e1925-6d9c-449b-a96b-703314e317a2 **62文件、failedFiles=0、退出码0、durationMs=376635，PASS**。

## BUG三问（阶段性）
1. 解决了吗？本开发候选F01–F04专项已PASS，R3已PASS，唯一独测尚未完成，不能称已经上线。
2. 还会复现吗？旧缺报告/旧版本虚报、越权路径、1200字截断已增加相应正反回归；仍需独立测试对固定新SHA完整复核。
3. 后续是否正常？当前修复中，D01–D06正式PASS；R3已PASS，候选远端冻结、D08交唯一独测，之后由总控合并部署，不得由开发自行关单。
