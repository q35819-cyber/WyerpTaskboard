# LEGACY-D09-REENTRY-BUG — isolated WIP development evidence

- Task: `WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1`.
- Baseline: `fa3a452bfee6ee43d911dfaf1c4c370fcbd9eff3`, own clean managed Git worktree.
- **Authority/status**: original production `claim` rejected HTTP 409 `CLAIM_WRITE_CONFLICT`, formally logged as `evt_e4d5609b1577fb51e0c877e4`. This is an **isolated developer WIP**, not a formal D01 claim, independent QA approval, main merge or release.
- Changed scope: `server/task-step-checkpoint.mjs`, `tests/task-step-checkpoint.test.mjs`; no edits to the old LEGACY task or other developers' workspaces.
- Fix: when genuine legacy v1 D09 developer cursor remains after prior completed handoff and independent QA PASS, a fresh controller dispatch after QA verdict and a fresh formal developer claim permit a new D01 attempt, while preserving previous attempts. STOP, old actor/Session, invalid dispatch or repeated claim still fail existing checkpoint gates.

## Developer validation (2026-11-05)

1. R1: `node --test tests/task-step-checkpoint.test.mjs` — **38/38 PASS**, exit 0; last focused result duration 27439 ms.
2. R2: `node --test tests/task-step-checkpoint.test.mjs tests/task-store.test.mjs tests/delivery-lifecycle.test.mjs` — **61/61 PASS**, exit 0 (before minor duplicate-fixture optimization; code unchanged).
3. R3: `npm.cmd test` — **58 files, 0 failed**, exit 0; 245584 ms; version `0.7.0`.
4. `npm.cmd run check` and `git diff --check` — PASS, exit 0.

The first full run failed only by `task-step-checkpoint.test.mjs` exceeding the existing 30000 ms `spawnSync` file timeout; the failure log is preserved in the execution ledger. Reduced duplicated negative-test fixture preparation, kept STOP and actor/Session negative coverage; second full suite passed without raising the timeout or modifying the global test runner.

Next: when genuine formal claim is allowed, start a new official D01, rerun required verification, independent QA, controller-controlled merge and main regression. Do not forge claim, checkpoint, dispatch, QA or task status on behalf of another role.
