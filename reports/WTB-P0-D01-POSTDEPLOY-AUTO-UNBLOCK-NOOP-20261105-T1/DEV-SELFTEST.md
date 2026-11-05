# P0 D01 postdeploy auto-unblock NOOP — development self-test

Task: `WTB-P0-D01-POSTDEPLOY-AUTO-UNBLOCK-NOOP-20261105-T1`

## Real incident and root cause

- Historical developer claim: `evt_d7b7bb4884097581fc387251`.
- Original D01 block: `evt_aeb42e9a715fed67c8912aa4`.
- Subsequent trustworthy controller dispatch: `evt_0fec2c23a0bbbabf6639d382`.
- The previously QA-approved D01 recovery code shipped in `main` `1fd70314d8d3fd2ef0d61a1e57048eaf58744c0d`, but a real successful project scan still left the original task blocked.
- Code investigation found `eligibleTemporaryUnblock` passes `preserveAutoUnblockScope=true` to `assertDeveloperClaimExclusive` even for the D01-specific missing-dispatch recovery. Other tasks in QA / delivery with overlapping source-file paths were still treated as write reservations, so the recovery gate returned no eligibility and emitted no `auto_unblock`.

## Minimal change

- In `server/task-store.mjs`, pass `preserveAutoUnblockScope=!d01Blocked`. The D01 machine restore can return a formerly blocked task to `待开发` after real dispatch and existing safeguards, without treating an unrelated same-project QA/delivery task as a permanent blocker. All other temporary blocks retain their original write-reservation checks. Claim authorization remains separate; this does not confer an execution session.
- In `tests/task-auto-unblock.test.mjs`, reproduce matching source-path conflicts against unrelated `待独测` and `交付中` tasks, verify D01 resumes once and the unrelated task is untouched. Existing STOP, unresolved user message, fake dispatch, old QA FAIL, handoff, original QA write-protection and journal idempotency tests continue.
- No original task status or past event edited; no extra modules, API, automatic AI wake, or workflow expansion.

## Three actual development test rounds (2026-11-05)

1. R1: `node --test tests/task-auto-unblock.test.mjs`: 15/15 PASS, exit 0. An earlier 14/15 run detected a regression in ordinary temporary block QA reservation; this was fixed by making the change D01-specific. The original failure evidence is preserved.
2. R2: `node --test tests/task-auto-unblock.test.mjs tests/task-scan.test.mjs tests/task-store.test.mjs`: 48/48 PASS, exit 0.
3. R3: `npm.cmd test`: 58 test files, 0 failed, exit 0, 262014 ms, package version 0.7.0.

`npm.cmd run check` and `git diff --check`: PASS. Actual D01-D07 step checkpoint records are in `data/taskboard/checkpoints/WTB-P0-D01-POSTDEPLOY-AUTO-UNBLOCK-NOOP-20261105-T1.md`.

## Delivery limits / follow-up

Developer-selftest PASS does not constitute independent QA PASS or production deployment. Independent tester must validate this fixed candidate, then controller should merge it through the established main flow, restart the real service, and prove original blocked task recovers through machine `auto_unblock` and can start a fresh, formal D01. Keep the original blocking event, prior QA failures, and other task owners intact.
