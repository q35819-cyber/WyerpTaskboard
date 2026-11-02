# C05_POSTMERGE｜合并后回归

- **准入**：任务唯一断点本角色游标等于 `C05_POSTMERGE`，前置任务步骤已经PASS；相关正式任务事件与权限必须实际存在。
- **执行**：总控将远端main安全同步到用户唯一认可的软件主目录；保全别的AI未提交文件，不reset --hard。按真实需要构建、迁移或安全重启常驻服务，验证启动目录/新进程/HTTP健康和运行版本；基于主目录最新main运行真实回归并保存含SHA、命令、退出码、结果的报告，不能只测试临时worktree。
- **证据**：任务编号、真实actor-id/Session、命令、退出码、Git SHA或事件ID、报告位置和结果。拒绝只写口头PASS。
- **断点**：立即用 `node cli/stepctl.mjs show/record`更新本任务同一 `<任务编号>.md` 并读回核对；写入失败不可进入下一步。
- **失败**：FAIL/BLOCK保留本步骤、记录原责任和修复条件，按正式看板状态返回，不覆盖其它AI成果。
- **PASS下一步**：C06_CLEANUP。交付继续由总控负责。


**现行程序过渡门禁**：当前stepctl/TaskStore/HTTP仍保留旧开发交付游标及developer_ai限制；本文件的角色步骤只有既有 `WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1` 正式开发、独测和主目录升级后才能作为程序强制依据。未迁移前不得伪造步骤记录、交付事件或冒用旧开发Session。
