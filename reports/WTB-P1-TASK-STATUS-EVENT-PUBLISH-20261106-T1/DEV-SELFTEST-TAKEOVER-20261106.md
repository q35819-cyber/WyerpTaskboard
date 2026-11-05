# WTB-P1-TASK-STATUS-EVENT-PUBLISH-20261106-T1｜D5 正式接管与开发自测

## 合法任务接管
- 用户本次原话：WTB-P1-TASK-STATUS-EVENT-PUBLISH-20261106-T1 这个呢？异常接管；正式takeover事件 evt_67fe86d0d14045c2769c5c87，之后从旧D03 PASS游标续D04。
- 新actor wtb-dev-status-event-takeover-20261106-d5；任务Session wc_sess_229036c4fabd494681897d3bf482bac5；原actor wtb-dev-normal-status-events-20261106-n3、Session wc_sess_450dac8197e941c99ebae0739073af30 的正式历史全部保留，原Session无active jobs。
- 原有未提交候选工作区0312023c (server/http-server.mjs、server/task-status-events.mjs、tests/task-status-events.test.mjs)保留且不更改；新隔离工作区 c72b37d8 基线 main d3f465dd034a1a8bacb530bb8ddd99f19158c27d；没有更改主工作区的脏文件；Ponytail full已读。
- 新候选仅移植3个任务授权文件，使用git apply --check验证HTTP补丁，新增服务端SSE与测试，没有引入UI、后台AI、轮询或其它平台能力。操作审计 data/logs/changes/2026-11-06.jsonl 内3条迁移记录。

## 功能和安全边界
- SSE endpoint GET /api/projects/:projectId/task-status-events；由真实持久化事务 committed journal 和EventStore核对后，跨进程推送项目级refresh信号，仅payload {"refresh":true}。
- 只通知old_status和new_status真正变化；忽略未提交、日志-only、优先级变化、伪造事务；多项目隔离，客户端收到事件须从权威GET /api/projects/:projectId/tasks重读。
- watcher在有SSE订阅时启动、最后订阅断开自动停止；支持断线重新连接与重读快照，不发送Token、用户输入或内部事件。

## 三轮实测
- R1：node --test tests/task-status-events.test.mjs，2/2 PASS，exit 0；包含实际新进程TaskStore状态更新、项目间隔离、断线重连、GET权威快照。
- R2：node --test --test-name-pattern "R2 rejects" tests/task-status-events.test.mjs，1/1 PASS，exit 0；验证伪committed、未committed、同状态、日志-only、错误revision均不触发SSE。
- R3首次尝试：相对脚本路径 node scripts/run-tests.mjs 意外运行了主工作区（Job 140f9d8f-7d2b-4d29-962f-c02596d5ffec，63文件1失败，退出1）；该结果**不代表隔离候选R3**，不得用于交接证据。
- R3正确候选测试：node D:/项目/.webcodex-managed-worktrees/wyerptaskboard-c72b37d8-d73d-42be-ae23-09fb6e1e4796/scripts/run-tests.mjs，Job 3ecd33c7-f754-4d86-9035-6abfd08aa4f7 全部61文件failedFiles=0、退出0、380943ms，结果PASS（原基线d3f465dd）。
- git diff --check：exit 0；修改只有三个任务文件。package.json原check脚本35条node --check逐条运行35/35 PASS、退出0。远端main前进到ebbe2edc00a99184969bf96e1984d521e3a12636并修改server/http-server.mjs后，已在独立分支成功rebase且保留双方源代码，完成新基线专项及整仓重验。


## 与已合并主线兼容的最终确认
- 候选分支：feat/WTB-P1-TASK-STATUS-EVENT-PUBLISH-20261106-D5；基线：ebbe2edc00a99184969bf96e1984d521e3a12636，自动无冲突rebase，保留原Ready Column准入实现和本单SSE实现。
- 最终基线R1：node --test tests/task-status-events.test.mjs，2/2 PASS，exit0（包括跨进程和负向）。
- 最终基线R2：node --test --test-name-pattern "R2 rejects" tests/task-status-events.test.mjs，1/1 PASS，exit0。
- 最终基线R3：node D:/项目/.webcodex-managed-worktrees/wyerptaskboard-c72b37d8-d73d-42be-ae23-09fb6e1e4796/scripts/run-tests.mjs，Job 778cd214-6f19-46f6-b985-f4d806e73759，61文件，failedFiles=0，exit0，durationMs=360672。
- 复核静态：同基线package.json的35条node --check均PASS、exit0；git staged diff --check退出0。
- 通过开发自测不等于独立QA/主线发布；开发仅交远端固定SHA供唯一独测，再由总控依法合并发布。

## BUG/功能闭环三问
1. 本地是否实现？R1/R2证明服务端跨进程状态更新和负向过滤实现；R3已经零失败，正式交付仍需唯一独测、总控合并与服务验证。
2. 以后会不会漏/误触发？跨项目和未提交的正负测试已增加，不保证平台fs.watch在极端文件系统丢失事件时完全无漏；客户端断线依赖重新读取快照。
3. 后续流程是否正常？当前处D07，尚未独测、main合并或在线浏览器消费；客户端事件消费是其它任务，不能在本任务擅自扩范围。

## 责任
开发D07 PASS后固定SHA推送隔离分支，以正式handoff交唯一独测；唯一独测PASS后由总控合并/部署/回归/关单；开发不得自行合main。
