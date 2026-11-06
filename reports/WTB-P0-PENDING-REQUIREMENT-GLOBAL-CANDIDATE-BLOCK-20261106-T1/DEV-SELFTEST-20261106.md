# WTB-P0-PENDING-REQUIREMENT-GLOBAL-CANDIDATE-BLOCK-20261106-T1｜开发自测证据（2026-11-06）

## 任务和真实认领
- 正式总控派工 evt_d06a71eec89b866c1929d8b0；当前开发预认领 evt_c52c3d9ffb69180ba2ffff5b；合法claim evt_b5a638562a8d5baec93b2a3d，任务真实状态「开发中」。
- 开发 actor wtb-dev-pending-req-candidates-20261106-n1，Session wc_sess_eb1175dd35794ad29337078adebe0f39。Git独立工作区 wyerptaskboard-a97ef11c-5c14-404d-b7d9-7032581e2095，分支 fix/WTB-P0-REQ-GLOBAL-CANDIDATE-20261106-N1，基线 main 355137f33ff7401d6c47e30a1659988aa43e829a。
- 最新权威流程版本2026.11.03-r1及Ponytail full。主线其他AI的dirty成果未动；不改任务状态、任务内容、UI六列或已完成卡。

## 唯一最小变更
- server/candidate-evaluator.mjs：删除一行全局blocker（requirements.pendingCount > 0 → 给所有候选加“存在待AI拆解的新需求”）；原watch.pending_requirements仍正常统计，不隐藏/自动清理新需求。
- tests/candidate-evaluator.test.mjs：新增两组真实 fixture：有2个待拆需求时开发与QA候选不被全局误挡、原需求计数仍为2；有待拆需求时未完成前置、用户STOP依然真实阻断。
- 未触碰 CLI 的另一项“待拆需求阻断在途任务测试/交接”缺陷，该问题另需合法P0任务及总控正式派工，不越权扩大本任务范围。

## 三轮自测
- R1 正向：node --test tests/candidate-evaluator.test.mjs，**6/6 PASS、exit0**（新增R1 + 原有授权模式回归）。作业411f153a-f1c7-48fd-b097-ddc4aa79ac57。
- R2 负向及兼容：同文件含新增R2 STOP与硬前置保护 **6/6 PASS**；node --test tests/adaptive-scan.test.mjs **6/6 PASS**，检查共享六列待执行、唯一测试角色与扫描调度不回归；两个文件node --check exit0，git diff --check exit0。
- R3 整仓脚本：node scripts/run-tests.mjs，作业1820dd3a-d8e8-4218-9eb9-3a961747fe32，**61个测试文件，failedFiles=0，退出码0，durationMs=345878，整仓PASS**。

## BUG 三问（本开发阶段）
1. 解决了吗？正反专项验证通过，R3整仓PASS，但实际HTTP/CLI领取门禁仍未解决、独测/主线部署未完成，不能称实际系统已修复。
2. 还会复现吗？新增针对2个待拆需求、合法候选、STOP和未完成前置的回归；旧错误全局拦截代码已删除。正式部署前不能保证线上不复现。
3. 后续流程正常吗？本任务D01–D06已PASS，D07端到端因HTTP/CLI全局claim门禁FAIL，唯一独测和总控C04–C07尚未开始；CLI通用preflight另有待处理的关联流程BUG，此任务不可假称一起解决。

## 交接规则
仅当R3=0失败、固定候选SHA推送并核对远端及报告哈希后，方可登记D07，正式提交唯一独测。开发不得自行代独测、合main或关单。

## 端到端准入判定：BLOCK（不可交独测）

- 已只读核实当前代码中的 server/http-server.mjs:1556–1561 与 cli/taskctl.mjs:194–203：只要同项目存在待AI拆解需求，HTTP claim和CLI preflight一律返回REQUIREMENT_INTAKE_PENDING。
- 因此此分支虽然让开发/QA候选保持eligible与可见，**真实claim仍会失败**。整仓测试未覆盖此端到端冲突；不能以61/61通过冒称工作流修复。
- 未授权修改的HTTP/CLI和对应测试必须由总控去重后正式派独立最小P0，完整修复、R1/R2/R3/唯一独测、总控部署后再处理原候选。此处仅保存WIP，不交独测/合并/关单。原始失败已在正式事件中登记。
