# D08_HANDOFF｜提交独测

- **准入**：任务唯一断点本角色游标等于 `D08_HANDOFF`，前置任务步骤已经PASS；相关正式任务事件与权限必须实际存在。
- **执行**：固定Git远端候选SHA、开发三轮PASS报告并正式handoff。
- **证据**：任务编号、真实actor-id/Session、命令、退出码、Git SHA或事件ID、报告位置和结果。拒绝只写口头PASS。
- **断点**：立即用 `node cli/stepctl.mjs show/record`更新本任务同一 `<任务编号>.md` 并读回核对；写入失败不可进入下一步。
- **失败**：FAIL/BLOCK保留本步骤、记录原责任和修复条件，按正式看板状态返回，不覆盖其它AI成果。
- **PASS下一步**：D09_NEXT（开发续接合法开发队列）。唯一独测 FAIL 退原开发，PASS 后**总控**继续 C04_MERGE_MAIN～C07_COMPLETE；开发不再负责合并、主目录更新、清理或关单。旧 `stepctl` 门禁须由既有服务端集成 P0 迁移，未迁移前不得虚报断点。
