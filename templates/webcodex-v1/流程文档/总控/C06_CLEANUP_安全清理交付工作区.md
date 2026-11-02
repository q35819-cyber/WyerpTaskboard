# C06_CLEANUP｜清理已合并工作空间

- **准入**：任务唯一断点本角色游标等于 `C06_CLEANUP`，前置任务步骤已经PASS；相关正式任务事件与权限必须实际存在。
- **执行**：总控核对候选已包含在远端main、独立worktree无未提交成果/正在运行的Job/其他AI占用后，用非强制命令安全清理本任务worktree与已合并且可删的本地分支。关联未关闭PR/共享远端分支保留并留痕；不删除其他AI工作区或历史报告。
- **证据**：任务编号、真实actor-id/Session、命令、退出码、Git SHA或事件ID、报告位置和结果。拒绝只写口头PASS。
- **断点**：立即用 `node cli/stepctl.mjs show/record`更新本任务同一 `<任务编号>.md` 并读回核对；写入失败不可进入下一步。
- **失败**：FAIL/BLOCK保留本步骤、记录原责任和修复条件，按正式看板状态返回，不覆盖其它AI成果。
- **PASS下一步**：C07_COMPLETE。交付继续由总控负责。


**现行程序过渡门禁**：当前stepctl/TaskStore/HTTP仍保留旧开发交付游标及developer_ai限制；本文件的角色步骤只有既有 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1` 正式开发、独测和主目录升级后才能作为程序强制依据。未迁移前不得伪造步骤记录、交付事件或冒用旧开发Session。
