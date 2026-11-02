# C04_MERGE_MAIN｜受控合并main

- **准入**：任务唯一断点本角色游标等于 `C04_MERGE_MAIN`，前置任务步骤已经PASS；相关正式任务事件与权限必须实际存在。
- **执行**：总控以本人的合法actor-id/Session从独测PASS的待交付队列正式认领，核对独测报告、固定候选SHA、远端分支和Git冲突，串行受控合并并推送远端main；已合并先证明祖先关系，不重复merge。原开发是否空闲不影响总控交付。
- **证据**：任务编号、真实actor-id/Session、命令、退出码、Git SHA或事件ID、报告位置和结果。拒绝只写口头PASS。
- **断点**：立即用 `node cli/stepctl.mjs show/record`更新本任务同一 `<任务编号>.md` 并读回核对；写入失败不可进入下一步。
- **失败**：FAIL/BLOCK保留本步骤、记录原责任和修复条件，按正式看板状态返回，不覆盖其它AI成果。
- **PASS下一步**：C05_POSTMERGE。交付继续由总控负责。


**现行程序过渡门禁**：当前stepctl/TaskStore/HTTP仍保留旧开发交付游标及developer_ai限制；本文件的角色步骤只有既有 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1` 正式开发、独测和主目录升级后才能作为程序强制依据。未迁移前不得伪造步骤记录、交付事件或冒用旧开发Session。
