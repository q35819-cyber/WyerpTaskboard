# C07_COMPLETE｜真实关闭任务

- **准入**：任务唯一断点本角色游标等于 `C07_COMPLETE`，前置任务步骤已经PASS；相关正式任务事件与权限必须实际存在。
- **执行**：总控核对正式独测PASS、远端main已含候选、唯一主目录已同步并正常运行、回归报告PASS及本任务安全清理，使用自己的合法controller_ai身份取得真实delivery_complete事件并读回状态。用户UI/业务验收另走既有用户确认，不要用户做Git交付。
- **证据**：任务编号、真实actor-id/Session、命令、退出码、Git SHA或事件ID、报告位置和结果。拒绝只写口头PASS。
- **断点**：立即用 `node cli/stepctl.mjs show/record`更新本任务同一 `<任务编号>.md` 并读回核对；写入失败不可进入下一步。
- **失败**：FAIL/BLOCK保留本步骤、记录原责任和修复条件，按正式看板状态返回，不覆盖其它AI成果。
- **PASS下一步**：C08_NEXT。交付结束后总控继续查队列。


**现行程序过渡门禁**：当前stepctl/TaskStore/HTTP仍保留旧开发交付游标及developer_ai限制；本文件的角色步骤只有既有 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1` 正式开发、独测和主目录升级后才能作为程序强制依据。未迁移前不得伪造步骤记录、交付事件或冒用旧开发Session。
