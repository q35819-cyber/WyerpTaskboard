# WTB-P1 开发自测报告

- 当前候选仅代表原开发 actor/session 的开发自测；必须由不同 actor/session 的独立测试 AI 复测。
- 本报告绑定最新 7 份冻结文档、三轮自测、14 项负向证据验证和最终全量回归。
- 早先一次 ETIMEDOUT 失败尝试已单独保留，后续拆分测试文件后最终全量回归通过，不删除历史失败记录。

报告数据：

{
  "task": "WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1",
  "actor": "wtb-dev-p1-recovery-20261101-59558da5",
  "session": "wc_sess_59558da53899414cb784e68bfbecb624",
  "formalTestStartEvent": "evt_37a2f9d4abbbd032c6b0d2b7",
  "finalFullRegressionJob": "43e413e2-c9be-4261-9e02-fb000b9b7601",
  "frozenDocuments": [
    {
      "file": "AGENTS.md",
      "sha256": "888344b3d6cb73daad68d692bbfdfcd460ae2d390a4020eef0b67bde057ba423",
      "bytes": 1849
    },
    {
      "file": "WORKFLOW.md",
      "sha256": "c286186636f12de3e0ad6cc36321b7b480b342a40f31fe2054e08d09bc169d16",
      "bytes": 12665
    },
    {
      "file": "总控AI.md",
      "sha256": "d02b558db76aef29279cdae7b223ebcc1ce4baf506d1e4b07fba4aaa855399bd",
      "bytes": 15755
    },
    {
      "file": "开发AI.md",
      "sha256": "6d0e7f0e60444b72e4c0b86e93682ef25d461f02aba2b827ce7ea3264fd19fc1",
      "bytes": 26542
    },
    {
      "file": "独立测试AI.md",
      "sha256": "071acbdfeba5f6eae7078fe78640ff0ef7e81985fb4ca9773d226023556687bc",
      "bytes": 17348
    },
    {
      "file": "data/taskboard/plans/WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1.md",
      "sha256": "efea0d2d4ef194913a9859be09d3412ba1a21b31a626b3889da12964cea19404",
      "bytes": 48033
    },
    {
      "file": "tests/fixtures/role-doc-selftest/WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1.md",
      "sha256": "fc7d06e8ccd74294c3f0d925bf0e0ec9b154d3504c010d57de07efd560bb2a7e",
      "bytes": 21014
    }
  ],
  "scriptSHA256": "168b679a0c23d367ca8a28f0d377eec264374c9f2c443926c81480026d081bb0",
  "freezeSHA256": "0dcd91279fcd08b45f33b4d6518f016e943bf2721fc91e467d6bbee3345ee2be",
  "rounds": [
    {
      "round": 1,
      "total": 20,
      "passed": 20,
      "result": "PASS",
      "reportSHA256": "85f2e8a382f7266671b3f39010eed9368e215c6c80c9700613657727e97d681a"
    },
    {
      "round": 2,
      "total": 12,
      "passed": 12,
      "result": "PASS",
      "reportSHA256": "7eef3fe74ec3b38b778ad53748a1f6fba664eeaf4028f008c1c0daf73d01070e"
    },
    {
      "round": 3,
      "total": 19,
      "passed": 19,
      "result": "PASS",
      "reportSHA256": "98190a8facef2bdf97b374e9c0052f2f11c62c6ff48997ed1fa8f9c2c43bffcd"
    }
  ],
  "negative": {
    "total": 14,
    "passed": 14,
    "allRejected": true,
    "reportSHA256": "e0d6d9617c4f4ef5ae7ae0e766ac6145fbff02c04f192b0f680337095656bf9a",
    "cases": [
      {
        "id": "inner_failed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "invalid check result",
        "reasonObserved": true
      },
      {
        "id": "fake_exit",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "invalid check result",
        "reasonObserved": true
      },
      {
        "id": "fake_script",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "script hash mismatch",
        "reasonObserved": true
      },
      {
        "id": "missing_round",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "missing round",
        "reasonObserved": true
      },
      {
        "id": "modified_report",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "report hash mismatch",
        "reasonObserved": true
      },
      {
        "id": "missing_command",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "invalid check result",
        "reasonObserved": true
      },
      {
        "id": "missing_trace",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "missing state transition trace",
        "reasonObserved": true
      },
      {
        "id": "changed_doc_sha",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "source SHA changed",
        "reasonObserved": true
      },
      {
        "id": "fake_cli_output_rehashed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "replayed command/output/state identity differs",
        "reasonObserved": true
      },
      {
        "id": "fake_cli_command_rehashed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "replayed command/output/state identity differs",
        "reasonObserved": true
      },
      {
        "id": "fake_takeover_identity_rehashed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "replayed command/output/state identity differs",
        "reasonObserved": true
      },
      {
        "id": "fake_reviewer_identity",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "reviewer actor/session not bound",
        "reasonObserved": true
      },
      {
        "id": "fake_takeover_authorization_rehashed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "replayed command/output/state identity differs",
        "reasonObserved": true
      },
      {
        "id": "fake_live_identity_rehashed",
        "rejected": true,
        "exitCode": 2,
        "matchedReason": "replayed command/output/state identity differs",
        "reasonObserved": true
      }
    ]
  },
  "evidenceVerification": {
    "command": "node tests/role-doc-selftest-v2.mjs verify",
    "pass": true,
    "docs": 7
  },
  "npmRunCheck": {
    "state": "passed",
    "exitCode": 0
  },
  "npmTest": {
    "state": "passed",
    "files": 60,
    "failedFiles": 0,
    "durationMs": 180865,
    "packageVersion": "0.6.63"
  },
  "priorFailedAttempt": {
    "path": "tests/WTB-P1-DELIVERY-TASK-RECOVERY-FAILED-ATTEMPT-20261101.md",
    "sha256": "27622b38d33bed671f4449f32a37e4739b88656701adb537ef4dc5148ec17f75",
    "superseded": true,
    "reason": "Earlier run hit the original 30-second per-file watchdog in delivery-takeover.test.mjs; long test files were split within authorized tests/ and final 60-file regression passed."
  },
  "scopeNote": "Developer self-test only. Not independent QA, not merged to main, and not parent P1 completion."
}
