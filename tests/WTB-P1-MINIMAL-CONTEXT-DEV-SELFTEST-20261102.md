# WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1｜最小任务编号入口开发自测（2026-11-02）

## 新方案、责任和历史保全
- 用户新方案优先于R3修补旧候选，正式stop_request evt_088623c1c6c4b5caa4dbfe9d，经原开发ack-stop evt_c222840af446588f11dc0335、resume evt_9011ffb9975d1fff1dca9943，于原开发actor wtb-dev-p1-recovery-20261101-59558da5 / Session wc_sess_59558da53899414cb784e68bfbecb624重新claim evt_81ef77ef7f99834da58c436c。
- 旧27文件候选完整保存在远端 archive/wtb-p1-old-pre-redesign-20261102 commit 4f24caefbcac1e706d11d0e3ced0d58b9c18155b。旧分支、旧QA报告、旧工作区未重置或删除，未跟踪的Python缓存与tests/evidence保留，绝不加入新候选。
- 新分支 feat/wtb-p1-minimal-id-context-20261102，直接从已独测交付 origin/main 6c204713bf8f5468ee9f59793535fecb52fa6973创建；没有cherry-pick、合并旧P1实现。正式开发test-start evt_b2bfcf2e4b770884edf9b19e。

## Ponytail full与最小实现
- 实际阅读 .agents/skills/ponytail/SKILL.md，并检查现有CLI request()/current()/guardState()/output()及调用处，复用现有 GET /api/projects、/tasks、/plans/0、/history、/guard 和服务端原有相对路径安全解析；无新API、认证、角色、状态机或依赖。
- 文件修改：cli/taskctl.mjs（添加 context --task 唯一入口、一次性安全输出边界），tests/taskctl.test.mjs（仅3个新增真实fixture测试及一个可选重复项目设置）；未改服务端代码、主规则、用户数据或第三方软件。
- 相对main初步diff：2文件，+143/-1行；新增生产函数 safeContextPath/contextOutput/taskContext 均由 context分支实际调用，均为单一入口必要功能；未加入兼容旧系统的无用状态机、模拟器、安全平台；没有可安全删除的其它本任务新增模块。
- 输出任务项目/状态/角色/负责人/Session/主计划真实正文/关联安全路径/最近历史/当前guard阻断/下一步，编号未找到或多项目重复或非法编号明确拒绝；敏感文件路径拒绝、正文中的JWT/Controller Proof/Bearer/Cookie/API Key/私钥等已知值只在最终输出处脱敏；原始计划不修改。
- 已知限制：相关文件返回服务端已登记的安全路径而非复制所有关联文件正文，符合本任务新方案“安全路径或必须读取的内容”；任意未标记的未知秘密文本不能靠名称正则完全识别，应避免将私密材料注册为任务计划。不自动唤醒其他AI。

## 同一源码版本的三轮真实开发自测
1. 正向/任务状态/错误回流：node --test tests/taskctl.test.mjs；25/25 PASS，0 FAIL，exit0。覆盖context唯一ID、项目名、计划正文、断点路径、原任务不改写及普通legacy CLI回归。Job 243c06df-8f93-4e19-aae1-14d4a4244f9b，completed。
2. 现有回归/语法检查：npm.cmd run check，exit0 PASS；node --test tests/http-server.test.mjs tests/project-registry.test.mjs，50/50 PASS，0 FAIL，exit0；未变更已有HTTP/注册功能。
3. 负向真实fixture：node --test --test-name-pattern=taskctl context rejects|taskctl context blocks tests/taskctl.test.mjs（参数作为一个argv值），2/2 PASS，0 FAIL，exit0（其他非匹配测试跳过）；覆盖不存在/重复/非法ID与越界读取；第一轮同时注入7类合成密钥并验证不会从完整CLI JSON回显。

git diff --check：exit0；主仓库main未修改。旧R3的失败与修补证据被保留作历史，不能复用为本新候选PASS。
**下一步骤**：只提交/推送本报告及上述两文件，核对真正远端候选SHA和本报告Git blob，再在原actor/Session正式记录开发PASS与handoff给唯一独立测试AI。独测之前不合并main、不关闭。
