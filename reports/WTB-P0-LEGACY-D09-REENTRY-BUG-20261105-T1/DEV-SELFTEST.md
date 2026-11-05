# LEGACY D09 reentry — formal abnormal-takeover development self-test

Task: `WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1`.
Track/priority: P0 BUG. Developer (new): `wtb-dev-d09-takeover-20261105-d4`, Session `wc_sess_e7def54ae78546c1b5b99ba17a74acdf`.
User's latest instruction: “BUG修完了没有？现在只有你一个开发，有占用就异常接管”. Official takeover event: `evt_93e9a0dd1406687a793c38e5`.

## Source, boundaries and continuity

- Preserved old formal developer: `wtb-dev-d09-formal-20261105-d2`; Session `wc_sess_c447db8381804b13876c6fc4df2bbf28`; developer checkpoint R1/R2 PASS already existed at `D07_TEST_3`. No historical record or original worktree was rewritten.
- Preserved prior isolated WIP commit `657669f5aa9ba0adbddc986f6cc6e5b24e6f19b9`, whose tested source and negative tests were brought forward into a fresh, independent candidate workspace.
- Candidate was first verified on main `39e90cf0781563782b73266b12b0d25c714fce94`. During validation another controller QA merge advanced main to `2e7a6d83986f8b39383274efa7f107fc1b9d28b3` with new C00 step verification in the same files. Our isolated commit was rebased cleanly onto the new main and **all three rounds repeated/verified on that base**.
- Only source code changes: `server/task-step-checkpoint.mjs`, `tests/task-step-checkpoint.test.mjs`; inherited WIP report remains append-only context. No change to main, other actors' sessions/worktrees or already completed tasks.

## Fix and acceptance

When a legacy v1 developer cursor still points at D09 after legitimate old developer handoff and independent QA PASS, require a later authentic controller dispatch and a *new* developer claim to begin a fresh D01 attempt. Preserve historical records/attempts; refuse STOP, forged or missing dispatch, replayed actor/Session and duplicate claim. Existing modern v2 C00 evidence gates are preserved and tested.

## Final independent worktree self-test on latest base

1. R1: `node --test tests/task-step-checkpoint.test.mjs`: **39/39 PASS**, exit 0 (including latest C00 tests).
2. R2: `node --test tests/task-step-checkpoint.test.mjs tests/task-store.test.mjs tests/delivery-lifecycle.test.mjs`: **66/66 PASS**, exit 0.
3. R3: `npm.cmd test`: **58 files, 0 failed**, exit 0; duration 269413 ms, package version 0.7.0.
4. `npm.cmd run check`: PASS, exit 0. `git diff --check`: PASS, exit 0.

## Required remaining stages

Developer D07 step and formal developer self-test result are separate from this file, and must be recorded with the final frozen commit SHA. Developer then performs official `handoff` to the **unique independent tester**, who must verify the frozen commit without borrowing the developer's uncommitted worktree. Only after QA PASS may the controller merge main, rerun regression and verify real affected task reentry. This developer report does not claim independent QA or production success.
