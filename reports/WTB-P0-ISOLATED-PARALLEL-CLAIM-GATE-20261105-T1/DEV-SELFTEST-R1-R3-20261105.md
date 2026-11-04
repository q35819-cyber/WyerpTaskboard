# WTB-P0-ISOLATED-PARALLEL-CLAIM-GATE-20261105-T1｜开发三轮自测 R1–R3

- 角色：developer_ai，actor=wtb-dev-isolated-parallel-20261105-27d92cc0；正式认领 Session=wc_sess_27d92cc0c86d411cb09b289458675039。
- 正式 claim：evt_e093646b959b1c336bb769c7；代码变更：evt_4ef5a9451ee4f570df2c4fa4。
- 基线：origin/main fa3a452bfee6ee43d911dfaf1c4c370fcbd9eff3，独立干净 managed worktree；没有修改主目录其他 AI 未提交文件。
- 代码候选：fix/WTB-P0-ISOLATED-PARALLEL-CLAIM-GATE-20261105-T1。固定候选提交 SHA 以正式自测 PASS 及交接事件为准。

## 单一修复范围

1. server/task-store.mjs：同一项目不同 actor/Session 的正式 claim 不再仅因计划文件名重叠返回 CLAIM_WRITE_CONFLICT；原同 actor、同 Session、STOP、硬前置和任务 owner 门禁保持；不同注册项目指向同一物理文件仍拒绝。
2. server/candidate-evaluator.mjs：移除与正式 claim 不一致的同项目开发中计划写路径 blocker，保留写入目标要求、依赖与 STOP 判断及活跃开发统计。
3. 保留既有自动解阻任务语义：内部 auto-unblock 调用仍检查被 QA 阶段保留的同项目文件范围；不重做其动态排序或历史状态。
4. 仅更新 tests/http-server.test.mjs 与 tests/task-scan.test.mjs 对应断言；未修改 auto-unblock 旧测试、其它任务、依赖或应用配置。

## Ponytail full 检查

- 已真实读取主目录 .agents/skills/ponytail/SKILL.md（full）及最新开发角色、任务计划、AGENTS.md、WORKFLOW.md。
- 复用现有 assertDeveloperClaimExclusive 和 CandidateEvaluator；检查自动解阻内部调用、HTTP claim、扫描候选及跨项目物理根目录重叠测试。
- 最小变更四文件，git diff --stat：25 insertions、40 deletions；不加新模块、不加依赖、不扩展到 C00 或其它任务。

## 真实命令、退出码和结果

- R1：node --test tests/task-store.test.mjs tests/task-scan.test.mjs tests/http-server.test.mjs tests/task-auto-unblock.test.mjs；job=1e587d47-5a8c-4faa-9a7d-c63c11bf9053；exit=0；98/98 PASS。
- R2：node --test --test-name-pattern=(overlapping registered project roots|developer claim allows isolated same-project|handoff releases execution identity|hard task prerequisites block candidates|a released developer Session cannot bypass) tests/http-server.test.mjs tests/task-scan.test.mjs tests/task-auto-unblock.test.mjs；job=52db6570-2139-4334-966c-3f9b95274405；exit=0；5/5 PASS。
- R3：npm.cmd test；job=a54ed63c-1f04-4d89-8364-ec5d85dc85d1；exit=0；58 files，0 failed；245941ms；本地 data/runtime/validation/npm-test.json state=passed。
- npm.cmd run check；job=e02d6c5e-92a4-496f-a44a-4ef1b4516ecc；exit=0。
- git diff --check；exit=0；仅有原有 Git 自动换行提示，无 diff 错误。

## 原 R3 FAIL 与闭环

- 首轮 R3 job=6aa7e688-bea6-41a9-9e1a-ca96581f5f4b：58 files，1 failed，exit=1；失败定位 tests/task-auto-unblock.test.mjs:232。
- 由于内部自动解阻要求保留 QA 写范围互斥，限定修正 server/task-store.mjs 的内部调用兼容参数；不改原任务测试。
- 修改后从 R1、R2、R3 重新执行均 PASS；原 FAIL 和修复已登记到任务事件与项目操作日志，未宣称最初 R3 PASS。

## 三问与后续责任

1. 旧 409 解决了吗？在本候选源码及真实 HTTP 定向测试中已修复同项目独立 actor/Session 路径误拒；尚未正式发布 main，线上不宣称修复完成。
2. 会不会复现？新增了同名文件/嵌套路径并行 claim，以及同 actor/Session、跨项目物理路径、硬依赖和 QA 保留范围的回归；正式合并后仍需总控实际服务复验。
3. 流程正常了吗？开发阶段 3 轮 PASS；后续必须唯一独立 QA PASS、总控受控合并与合并后回归，不能用开发 PASS 代替。

## 已知边界

- 当前 claim HTTP/CLI 接口传递 actor 和 Session，但不直接提交可由服务端证明的 WebCodex worktree 身份；本开发实际采用独立 Git worktree。独测应重点核对同 worktree/伪 Session 场景，若要求新增可靠服务端物理绑定，须由总控按原任务批准写范围，不能在本提交擅自扩展接口。
- 无擅自处理其他开发、独测、总控的候选、事件、主线或未提交工作区。
