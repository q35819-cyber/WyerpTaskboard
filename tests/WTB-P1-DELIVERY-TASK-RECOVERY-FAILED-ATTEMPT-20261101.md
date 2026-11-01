# WTB-P1 全量回归失败尝试记录

- 该报告保留一次未完成的全量回归，不代表最终结果。
- 58个文件中57个文件通过；delivery-takeover.test.mjs在30秒单文件看门狗处被终止。
- 失败原因是ETIMEDOUT，不是已捕获的断言失败；该文件在终止前已输出的用例均为PASS，但没有完成整个文件。
- 修复策略：不修改npm test运行器；将过长测试文件拆成小于30秒的独立测试文件。

```json
{
  "task": "WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1",
  "actor": "wtb-dev-p1-recovery-20261101-59558da5",
  "session": "wc_sess_59558da53899414cb784e68bfbecb624",
  "testStartEvent": "evt_17d7937a411b5c69d90e703a",
  "job": "41e711d5-9c97-4169-aea0-c027661e2867",
  "state": "failed",
  "files": 58,
  "failedFiles": 1,
  "durationMs": 193047,
  "failures": [
    {
      "file": "delivery-takeover.test.mjs",
      "error": "spawnSync C:\\Program Files\\nodejs\\node.exe ETIMEDOUT",
      "exit_code": null,
      "stdout_tail": "✔ pending delivery rejects unauthorized takeover; authorized user retains QA, original identity and generation (3027.1575ms)\n✔ pending delivery without independent evidence returns to independent testing (2286.1453ms)\n✔ missing QA report never silently reuses old PASS; stale permission, spoofing and replay fail (2032.4124ms)\n✔ authorization revision expires after another task update (2045.5342ms)\n✔ authorized replacement completes already-merged candidate; old Session cannot close (3737.113ms)\n✔ authorized pending takeover rejects an independent PASS SHA different from real Git candidate (2460.809ms)\n✔ authorized pending takeover rejects zero-byte independent QA report (2039.6551ms)\n✔ authorized pending takeover rejects valid-shaped but nonexistent Git commit SHA (2340.7365ms)\n✔ a QA report with explicit FAIL verdict cannot reuse historic PASS (2054.9935ms)\n✔ a BLOCKED QA verdict cannot reuse historic PASS (2062.4845ms)\n✔ contradictory explicit final verdict must not preserve an older PASS (2031.7231ms)\n✔ a historic PASS mention without any explicit QA verdict cannot authorize delivery (2046.1058ms)\n"
    }
  ]
}
```
