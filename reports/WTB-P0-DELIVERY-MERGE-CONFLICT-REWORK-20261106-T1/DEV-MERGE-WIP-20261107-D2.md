# WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261106-T1｜新 main 冲突协调与 D01 阻断

- actor：wtb-dev-20261107-merge-conflict-rework-d2；Session：wc_sess_20261107_merge_conflict_rework_d2
- 正式claim：evt_b27b875768c28838f970b965；总控回队列 evt_71c01aae5ffc3510d4d64db8；原QA PASS及C04真实冲突历史全部保留。
- 冻结旧QA候选：391b9860df7c30a931ccc5e6282a30fbd0681d26。最新main基线：0c425629f55274a2a324b3d78becf46a2cf70739。
- 仅在隔离worktree D:/项目/.wtb-takeover-worktrees/WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261107-D2 上操作。真实 cherry-pick -n 原旧候选得到 CONFLICT(content) server/task-store.mjs；仅有一个导入段冲突，将最新main的 RequirementStore 和旧候选 deliveryEvidence 同时保留。其余代码按原已独测候选保全，没有丢失二者的更新。
- 受控差异 git diff --cached --check PASS。node --check server/task-store.mjs PASS；合并后文件无 Git 冲突标记。
- R1/R2 定向：node --test tests/delivery-lifecycle.test.mjs tests/task-auto-unblock.test.mjs，37/37 PASS，exit0；覆盖真实Git冲突合法返修、伪造身份/错误SHA/STOP/并发拒绝、D01恢复、系统自动解阻等。
- R3 整仓：真实运行 node scripts/run-tests.mjs 完成，61 个测试文件、failedFiles=0、exit0、durationMs=328791（Job 5f647fab-a1a3-4254-9ae5-f28c1fda12ec）。npm.cmd --prefix <隔离工作区> run check 全部语法检查 PASS；git diff --cached --check 退出0。**仅代码自测通过，不等于合法 D01、正式交独测或主线交付。**
- **正式流程阻断**：当前Main的 stepctl D01_CLAIM 对新claim evt_b27b875768c28838f970b965 返回 CHECKPOINT_STEP_ORDER；旧断点停在 QA Q04_NEXT，现有总控 controller_rework_requeue 只使任务变为待开发，未被现有步骤门禁识别为新开发轮次。用户已授权 BUG 允许强制推进代码，但该权限不代表能伪造 D01 PASS/总控派工。本轮仅隔离预开发，不能正式交QA、合main或关单。
- BUG三问：1 代码冲突在独立候选已消除，流程未完全修好。2 测试保留正反覆盖，D01缺口仍会复现直至正规流程修复。3 后续流程必须先由总控/门禁修复提供可信重新准入，再走D01–D09/三轮自测/唯一QA/总控交付。
