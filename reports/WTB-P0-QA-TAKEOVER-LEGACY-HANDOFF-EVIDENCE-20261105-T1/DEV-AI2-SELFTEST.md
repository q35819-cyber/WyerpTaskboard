# Legacy developer handoff and independent QA takeover | P0 BUG | Developer AI-2

- Task: `WTB-P0-QA-TAKEOVER-LEGACY-HANDOFF-EVIDENCE-20261105-T1`.
- Official developer claim: `evt_0e3be1db733cb6850ebe39df`.
- Tested isolated worktree base: `838d8a60fee1df7322da0ece8af9ecf5b9f40b0e` (`main` = `origin/main` at test time).
- Original incident `WTB-P0-ONBOARD-TEMPLATE-ROLE-DRIFT-20261105-T1`: developer handoff event `evt_7be7be898fa73ad0119ce569` did not include `commitSha` or `headBranch`; preceding same-actor/Session `code_published` event `evt_2681b47345e8325fe3d8f4cf` verified remote candidate `639fd3a60d7b408c5f78429736cab5d4dbc6afcd`. Q2 took over test legally (event `evt_c7b8c4a44c64f9db9cb492dc`) and independently passed with that frozen candidate (event `evt_a91356ad79657af498515313`), yet the original controller delivery-claim gate rejected it with `DELIVERY_INDEPENDENT_PASS_REQUIRED`.

## Minimal change

Only `server/candidate-evaluator.mjs` plus new `tests/delivery-qa-takeover-evidence.test.mjs` were changed. Modern handoffs with Git SHA/branch retain exact equality against QA's final candidate. For a legacy handoff missing **both** fields, require a prior `code_published` by the **same developer actor and Session**, `remoteVerified=true`, valid Git SHA, matching QA SHA/branch, legitimate report path/SHA256, atomic developer handoff and no intervening invalidating source event. The existing Q1/Q2 actor/Session, task-scoped user authorization, registered revision, former Session, revocation and independent QA PASS gates remain unchanged. No historical event, original task status, workflow state machine, or main branch was rewritten.

## Actual development verification

1. R1 `node --test tests/delivery-qa-takeover-evidence.test.mjs`: **4/4 PASS**, exit code 0. Positive legacy and modern handoff cases; more than 20 intentionally corrupted publication/authorization/identity/report cases rejected.
2. R2 `node --test tests/delivery-qa-takeover-evidence.test.mjs tests/delivery-lifecycle.test.mjs tests/task-store.test.mjs`: **31/31 PASS**, exit code 0.
3. R3 `npm.cmd test`: **60 test files, 0 failed**, exit code 0, 253907 ms, package version 0.7.0.
4. `npm.cmd run check`, `git diff --check`: exit code 0.

## Remaining independent gates

The unique tester must independently check the frozen commit and source audit, test legitimate Q2 takeover and forged/expired authorization negatives. Controller alone can merge the candidate with other pending QA-approved changes into the latest `main`, re-run full regression and verify the original task's delivery claim/close. A developer self-test PASS does **not** mean the original production bug is closed; the old events and failed claim history must remain untouched.
