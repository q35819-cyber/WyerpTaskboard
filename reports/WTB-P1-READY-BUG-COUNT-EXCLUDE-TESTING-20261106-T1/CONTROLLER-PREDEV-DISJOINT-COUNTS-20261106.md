# C03隔离预开发｜待执行列开发/测试/BUG三项互斥统计

Status: CONTROLLER_PREDEVELOPMENT_REFERENCE_ONLY. NOT formal developer QA / NOT unique independent test / NOT merged or published.

Original existing task: WTB-P1-READY-BUG-COUNT-EXCLUDE-TESTING-20261106-T1 (待准备, requires WTB-P1-READY-BUG-COUNT-20261106-T1完成; parent currently 阻断).
Latest user contract: every task shown in shared qa_pending column is counted exactly once: test-stage task including bugfix -> 测试; otherwise claimable developer bugfix -> BUG; otherwise claimable developer task -> 开发.
Invariant: 开发+测试+BUG === count of deduplicated ready-column items for the current project and filter; unaffected by column pagination.

Files changed in isolated clean worktree based on main 355137f33ff7401d6c47e30a1659988aa43e829a: web/app.js and tests/board-static-assets.test.mjs.
Production logic: testing = tasks.filter(task => !isReadyTask(task)).length; bugs = tasks.filter(task => isReadyTask(task) && task.track === "bugfix").length; developers = tasks.length - testing - bugs.

Actual controller tests (not developer formal R1/R2/R3 nor independent QA):
- node --test --test-reporter=spec tests/board-static-assets.test.mjs : 9/9 PASS, exit 0. New test runs actual renderBoard in a fake DOM, confirms 2 normal dev + 3 bug dev + 1 normal QA + 2 bug QA = 8 with counters 2/3/3 and subset checks.
- node --test tests/board-state.test.mjs tests/adaptive-scan.test.mjs tests/web-ui-contract.test.mjs : 23/23 PASS, exit 0.
- npm run check : PASS, exit 0.
- git diff --check : PASS, exit 0.
- node scripts/run-tests.mjs : 61 files, failedFiles 0, durationMs 324070, package_version 0.7.0, exit 0, remote job 5ad1e665-c7e9-45a7-abfb-6d31c4afc9fa.

Risk/next gates: this branch does not include the frozen prior QA candidate of original WTB-P1-READY-BUG-COUNT-20261106-T1; before release verify latest main contains original BUG counter, short column title and this new classification. Since the original task is blocked, first legally recover and deliver it. Then original developer must take this standalone patch into latest main, perform three formal distinct selftests and hand off exact SHA for three fresh independent QA rounds. Controller alone merges, upgrades runtime, performs postmerge verification, safe cleanup and closure.
