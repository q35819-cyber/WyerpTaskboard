# WTB-P0-READY-COLUMN-PRECLAIM-ELIGIBILITY-20261106-T1｜开发自测与独测候选证据

## 合法认领和代码边界
- 正式总控派工 evt_330442b9478b21e7f5b27025；preclaim evt_7f74faa28f5a9a0594f7f7e8；claim evt_2cd024cd1ad9cbcb388c2ef6。
- 角色 developer_ai；actor wtb-dev-ready-preclaim-20261106-d1；正式任务Session wc_sess_02b91d2c1f6945569bd063ddb7477ea0。
- 原main与远端基线 SHA 59a0b9443a593dd8fb2267ff0af314372faa7109，主目录原有dirty数据、其它AI工作区保留不动。
- 独立worktree wyerptaskboard-f4dcea39；分支 fix/WTB-P0-READY-PRECLAIM-20261106-D1；Ponytail full已检查；未发布。
- 五个写文件均在批准范围：web/app.js、server/http-server.mjs、server/task-scanner.mjs、tests/adaptive-scan.test.mjs、tests/http-server.test.mjs。
- 每次文件变动写本项目 data/logs/changes/2026-11-06.jsonl；此前错误的换行批量变更已经消除。

## 功能范围
- 排除待准备任务直接进入共享待执行。只有正式派工且实时条件满足，无STOP、无负责人、非临时预开发，扫描器才用机器状态事件把待准备转到待开发；未准备好保留原列。
- 待独测和待复测必须对应实时有效的候选记录、开发交接、通过的开发自测、固定git SHA、已验证远端发布/报告SHA以及无活动测试资源/STOP；否则不列为可直接执行的测试。
- 不修改真实已完成任务、不扩大到调度器、不添加第七列、不跳过身份准入、不让不可执行卡消失。

## 三轮真实自测
- R1 正向、UI/扫描器：node --test tests/adaptive-scan.test.mjs，最终6/6 PASS，exit 0。覆盖六列分配、未准备、无正式派工、STOP、临时预开发以及幂等自动升级。
- R2 HTTP负向：node --test --test-name-pattern "task-scan status endpoint" tests/http-server.test.mjs，1/1 PASS，exit 0。伪造 eligible=true 的QA无固定开发证据时，服务端仍返回eligible=false。
- R3 全仓回归（初版）：node scripts/run-tests.mjs，60文件、failedFiles=0、exit 0；增加准备状态机器升级后，重新完整执行最终版R3。
- R3 全仓回归（最终版）：Job cef0fd14-c1b5-4507-b8cc-64658df1d423，node scripts/run-tests.mjs，60文件、failedFiles=0，退出码0，durationMs=284584。
- 静态：五个触及的文件 node --check 单独核验均无语法失败；git diff --check 退出码0。npm.cmd run check 首次作业超时，另一次npm.cmd运行仍待终态；其package.json check脚本的全部35条node --check命令已按相同路径独立执行，CHECK_SCRIPT_COMMANDS=35，FAILED=0，进程exit0；不能把npm.cmd包装命令本身写成PASS。

## BUG修复三问
1. 解决了吗？独立开发候选中正负向与全仓测试通过；尚待唯一独测和总控正式部署后现场验收，不能宣称线上已经解决。
2. 下次是否会复现？新增缺派工、STOP、临时预开发、缺QA固定证据、陈旧扫描、六列计数/跨角色用例；不能保证未覆盖的新竞态。
3. 后续正常吗？六列不改，未就绪卡留在待办；从开发状态进入正式独测和总控合并、重启验证尚未完成。下游阶段由唯一独测和总控负责。

## 下一步和职责
- 固定候选提交后，开发按D07→D08正式交唯一独测；不得代独测、不得自行merge main或complete任务。
