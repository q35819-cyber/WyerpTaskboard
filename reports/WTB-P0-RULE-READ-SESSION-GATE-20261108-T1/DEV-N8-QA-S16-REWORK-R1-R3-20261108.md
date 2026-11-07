# WTB-P0-RULE-READ-SESSION-GATE-20261108-T1｜N8 独测 S16 FAIL 返修及开发三轮自测

## 来源、身份与范围
- 独立测试 QA S16：`evt_b0dc98464df70e8de526691f1c`，正式 Q02 FAIL；报告 `reports/WTB-P0-RULE-READ-SESSION-GATE-20261108-T1/QA-R1-R3-FAIL-20261108-S16.md`，报告哈希由原 QA 证据登记，未替它重写原报告。旧失败候选 `87641606e4ca8cff25597ebab4fc1c412b50b039` 不可冒充 PASS。
- 同一原开发 actor `wtb-dev-20261108-rule-read-takeover-n8`，新业务 Session `wc_sess_G9EYbco8iBNeKbs7`；正式预认领 `evt_09dafb6229dacd1b0ce681e4`、修复认领 `evt_a2a2118acc4e126d990e519c`，状态 测试失败待修复 → 修复中。唯一开发权限，未抢 N11 的 Q04 任务。
- 独立代码 worktree `agent:Administrator-19af1cd12ae84d1b:wyerptaskboard-9a7644e7-d92152e1`，从最新 origin/main `8e19427900ff5e3faa728e4075bf62589936ab9d` 建立。原候选两个提交以 cherry-pick `8924c17`、`1020a84` 无冲突继承，保留旧 QA/开发工作区和所有失败历史。未修改 dirty main。
- **本轮新增代码只改** `server/task-store.mjs`、`tests/task-store.test.mjs`；真实增量 +26/-2（源码 +1/-2，测试 +25）。不增加角色、服务、依赖或配置，Ponytail full 最小根因修复。

## 根因与修复
- QA 真实漏洞：权威规则门禁已启用、开发者尚无合法当前 Session 规则票据，仍可通过 `developer_issue_reported` 伪造成暂停态，并允许 `developer_external_issue_reported`、`suspected_disconnect` 事件写入；前者改变任务卡为 `paused_by_issue`，第三种会影响异常状态投影。原候选对 `code_published` 等拒绝正常，却错误地将三者列入 `assertRuleReadForMutation` 豁免。
- 删除这三种写入豁免，保留只用于阅读启动的 `preclaim_report` 和服务端校验过的 `rule_read_*`；有实际最新完整规则票据后，原合法开发事件仍遵循当前 owner/Session/真实关联任务校验。不修改用户操作或内部调度身份边界。
- 负向测试在启用规则门禁的真实 TaskStore fixture 中，先取得有效开发规则凭据并正式 claim，再修改权威规则文档使旧凭据失效，分别提交三种正式事件，均须 `RULE_READ_REQUIRED`，且事件条数不变、卡片保持 running、无虚假暂停或断线。保留原有正向票据和错误身份校验测试。

## 可复核三轮自测
- R1：`node --test --test-name-pattern "TaskStore rule-read receipts" tests/task-store.test.mjs` **1/1 PASS，exit0**；包含新增真实无票据反例及状态/事件不变断言。
- R2：`node --test tests/task-store.test.mjs tests/http-server.test.mjs tests/taskctl.test.mjs`，Job `wc_job_dr1tnEHaYbvqXlv0`，**103/103 PASS，exit0，27865ms**；旧正常三角色规则读取、票据/身份/错误场景与服务端流程均回归。
- R3：`npm.cmd run check` **PASS、exit0**；`node --test tests/logging-coverage.test.mjs` **4/4 PASS、exit0**；`git diff --check` **PASS**；最终固定源码 `node scripts/run-tests.mjs`，Job `wc_job_hhHmWmDuk3J8Cxz9`，**62个测试文件、failedFiles 0、exit0、durationMs 407555、package 0.7.0**。
- 本轮正式 D01～D07 已登记 PASS，attempt=2，未抹除首次 QA Q02 FAIL。

## BUG 修复三问（仅开发候选阶段）
1. **问题解决没有？** 候选阶段**已验证解决** QA S16 指出的三种事件漏检：新权威文档指纹失效后全部拒绝，真实拒绝后无事件/卡片副作用；R1/R2/R3 PASS。是否在主线部署生效仍**未验证**，须唯一独测 PASS、总控受控合并与实际运行端复测。
2. **下次会不会复现？** **已验证同一原始复现路径不再触发**，回归用例保留；不能保证所有未知外部工具和未经授权 Runner 文件写入被当前 TaskStore 门禁拦住，Runner/stepctl 工具层不属于本任务写入范围。如出现独立工具层绕过，须总控派新 P0 并按前置治理。
3. **后续流程是否正常？** 开发原子返修领取、D01 重开、D02～D07 自测和日志**已验证**；D08 正式发布及交接待复测、唯一独测 Q01～Q04、总控 C04～C07 尚待各自真实完成。本任务未关单，不把开发 PASS 当独测或已部署。

## 交接门禁
- 新开发报告及新候选分支 SHA 以实际 Git 提交、`git ls-remote`、SHA256 核验结果为准；代码发布事件必须先于新一次正式 handoff。修复中交给独测的目标状态应为 **待复测**。
- 旧独测 FAIL、旧候选 SHA、原开发 D01～D09 断点历史与旧工作区全部保留。禁止开发自行独测/合并 main/部署/关单。
