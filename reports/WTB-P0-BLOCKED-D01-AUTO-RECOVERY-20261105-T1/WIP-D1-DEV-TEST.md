# BLOCKED-D01-AUTO-RECOVERY — isolated WIP development evidence

- Task: `WTB-P0-BLOCKED-D01-AUTO-RECOVERY-20261105-T1`.
- Baseline: `fa3a452bfee6ee43d911dfaf1c4c370fcbd9eff3` (isolated managed Git worktree).
- **Authority/status**: normal `claim` rejected by production HTTP 409 `CLAIM_WRITE_CONFLICT`; recorded in task event `evt_8d5410f1abb931d2415e83cd`. This code was developed in isolation at the user's direct instruction, **not a formal D01 claim**, and is **not QA PASS or main release**.
- Scope: `server/task-store.mjs`, `server/candidate-evaluator.mjs`, `tests/task-auto-unblock.test.mjs`.
- Change: for a real D01 missing-controller-dispatch block, only a new authentic controller dispatch after that block can make the existing machine transaction restore the task to `待开发`; the old claim/history is retained. Existing STOP, hard dependencies, user messages, active ownership, write conflicts, atomic journal and idempotency remain enforced.

## Developer validation (2026-11-05)

1. R1 `node --test tests/task-auto-unblock.test.mjs`: **14/14 PASS**, exit 0, including positive recovery and forged dispatch/STOP negatives.
2. R2 `node --test tests/task-auto-unblock.test.mjs tests/task-scan.test.mjs tests/task-store.test.mjs`: **47/47 PASS**, exit 0.
3. R3 `npm.cmd test`: **58 test files, 0 failed**, exit 0; reported duration 273886 ms.
4. `npm.cmd run check`: exit 0. `git diff --check`: exit 0.

Earlier test-fixture failures were retained in the execution log and corrected without weakening the application state gates. Next actions: legal fresh claim/D01 after production lock is released, formal revalidation, unique independent QA, controlled controller main merge and live verification. Do not change an existing completed/failed/blocked task to fabricate a release.
