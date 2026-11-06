# WTB-P0-REQUIREMENT-INFLIGHT-PREFLIGHT-GATE-20261106-T1｜开发三轮验证与独测交接材料

## 正式事件及隔离
- 原总控派工 evt_36630a8b2d36f5dd05166cfc、原开发正式领取 evt_3788bde852db85a78bff3c57。
- actor wtb-dev-req-inflight-preflight-20261106-n1，Session wc_sess_eb1175dd35794ad29337078adebe0f39，独立工作区 wyerptaskboard-27caad1f-e0fa-4279-89b6-bd11fea1fd51，分支 fix/WTB-P0-REQ-INFLIGHT-PREFLIGHT-20261106-N1，基线main 355137f33ff7401d6c47e30a1659988aa43e829a。
- 只修改 cli/taskctl.mjs 和 tests/taskctl.test.mjs，不改HTTP claim、candidate-evaluator、主线或其他AI成果；Ponytail full。

## 唯一修复
- 原CLI preflight 在任意 pending requirement 下，无条件阻断已合法认领者的开发测试、独测和交接。
- 新增verifiedInFlight，仅在test-start/test-result/transition且当前正式claim/takeover的角色、actor、Session与任务占用完全一致、状态在合法执行阶段时不受无关pending requirement阻断。其它命令及未认领者仍按原门禁；STOP、未读留言先于pending判断拒绝。
- 不改变独测唯一责任，不改HTTP的新认领门禁（另张关联任务）、不新增任务。

## 三轮开发验证
- R1：node --test --test-name-pattern 'pending unrelated requirement|pending requirement rejects spoofed' tests/taskctl.test.mjs，新增3/3 PASS、exit0；覆盖真实开发test-start/result、handoff、独测结果和冒用/STOP反向校验。
- R2：node --test tests/taskctl.test.mjs，29/29 PASS、exit0；所有旧CLI回归及新增正反测试正常。node --check cli/taskctl.mjs，git diff --check 均退出0。
- R3：node scripts/run-tests.mjs，Job 8dbeeed0-dd3a-4a55-9c99-e0a8da29a235，**61个测试文件、0失败、exit0，durationMs=287322，PASS**。

## 三问（开发阶段）
1. 解决了吗？CLI在途任务错误预检的R1/R2已通过，整仓R3已PASS，唯一独测/正式发布前不得宣称全面上线。
2. 会复现吗？新增无关待拆需求、旧身份/Session/STOP的正反向回归，排除原CLI逻辑误挡；部署前仍须唯一独测。
3. 后续正常吗？开发D01-D06 PASS，R3已PASS，D08待正式交独测，主线未合并。HTTP的全局新认领门禁仍为独立待修范围，不越权顺带改。

## 后续
整仓R3通过后提交固定候选远端、报告哈希，正式登记code_published、开发test_result、原子handoff到唯一独测；总控负责main合并部署、安全清理和关闭。

## 2026-11-06 新 Session 异常接管续办（原报告附录）
- 用户原话：「还有一个开发中的异常了，按异常接管」，本次接管正式服务端事件 `evt_a1ca0a121ba051f2870ee83c`，原 actor `wtb-dev-req-inflight-preflight-20261106-n1` 与 Session `wc_sess_eb1175dd35794ad29337078adebe0f39` 保留，新 actor `wtb-dev-req-inflight-takeover-20261106-n12` 与 Session `wc_sess_e35aa6f4cc284ae5879c806c6fffea46` 正式接手。
- 实际读取 checkpoint，原开发 D01～D06 全部 PASS；两授权代码文件的 mtime 为 09:32Z/09:36Z，原 R3 工件 `data/runtime/validation/npm-test.json` 10:52Z 报告 `state=passed`、61个测试文件、0失败、`durationMs=287322`，该结果晚于所有源码修改。
- 本次额外复跑 `node --test tests/taskctl.test.mjs`，Job `511046d6-5108-4893-b164-02dab7bd623c`，实际 exit0 **29/29 PASS**；按当前 `package.json scripts.check` 逐项实际运行 35 条 `node --check`，全部 exit0；`git diff --cached --check` 和 `git diff --check` exit0。
- D07 已由合法接管身份依据原整仓 R3 和本次重测实际登记 **PASS**；禁止以作者自测冒称唯一独测。改动只有原计划两个源码文件，报告为独立证据资料。原开发/其它 AI worktree、dirty main、历史失败和固定验收范围均未更改。
