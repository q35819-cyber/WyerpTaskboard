# P0 BUG | D09 legacy blocked-task auto recovery | Developer AI-1

- Task: `WTB-P0-BLOCKED-D09-AUTO-RECOVERY-20261105-T1`.
- Official developer claim: `evt_577efa79f97e35a6d5390aef`.
- Base: `838d8a60fee1df7322da0ece8af9ecf5b9f40b0e` (verified current `main` / `origin/main`).
- Parent incident: `WTB-P0-LEGACY-ROLE-RETIRE-20261102-T1`, historical block `evt_4185cf43c29fefa0cdd8e981`, previous checkpoint error `evt_f546ed98987e0a00723cdd7c`; the original task and all old event records remain untouched.
- Required upstream published gate: `WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1`, actual QA PASS and controller delivery `evt_acc5777078783c88f69b37ca`.

## Smallest change

`server/task-store.mjs` recognizes only a genuine historical `developer_step_cursor_blocked` with its prior developer claim and explicit `D09_MERGE_MAIN CHECKPOINT_STEP_ORDER` evidence. To recover it also requires: independent tester PASS linked to a verified controller delivery of the D09 gate fix, published merge commit ancestor of the current `main`, a *new* real controller dispatch **after** that delivery and block, no STOP, HOLD/owner, uncompleted hard dependencies, pending user acknowledgement or newer developer claim. The existing atomic `auto_unblock` event restores only `待开发`; it never invents a claim or deletes original events. Ordinary/other temporary block paths remain unchanged.

`server/candidate-evaluator.mjs` includes this type in the already-existing transaction-verified fresh auto-unblocked BUG priority check. `tests/task-auto-unblock.test.mjs` adds a real Git-backed fixture, legitimate restore-and-new-claim proof, parallel idempotent scanner, stale/forged QA, unpublished merge, missing/early dispatch, STOP, unfinished upstream and hard dependency negatives.

## Actual development tests (2026-11-05)

1. R1 `node --test tests/task-auto-unblock.test.mjs`: **17/17 PASS**, exit 0. Two earlier fixture setup failures were corrected without weakening the production gate.
2. R2 `node --test tests/task-auto-unblock.test.mjs tests/task-scan.test.mjs tests/task-store.test.mjs`: **56/56 PASS**, exit 0.
3. R3 `npm.cmd test`: **59 files, 0 failed**, exit 0, **254067 ms**, package version 0.7.0.
4. `npm.cmd run check` and `git diff --check`: exit 0.

## Boundary / delivery

This is developer self-test PASS only, not independent QA or live deployment. The unique independent tester must use the frozen candidate SHA from the Git handoff and independently check actual D09 source failure history, test fixture negatives, build and whole-suite regression. The controller alone merges, upgrades/restarts as necessary, dispatches the original blocked task *after* the fixed build is published, runs the actual machine scan, verifies exactly one `auto_unblock` event and fresh legal D01, and closes tasks only after postmerge validation. Never manually rewrite the old block or use a chat note as recovery evidence.
