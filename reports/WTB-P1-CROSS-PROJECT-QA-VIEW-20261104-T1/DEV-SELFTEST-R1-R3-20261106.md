# WTB-P1-CROSS-PROJECT-QA-VIEW-20261104-T1｜开发三轮自测

## 正常功能目标
- 看板**只读**展示所有已注册项目的「待独测 / 待复测」候选和当前独测/复测占用；各项同时显示 projectId、taskId 及从当前任务开发 handoff 事件核验的候选完整 SHA；无法核实时明确写“待核验”。
- 允许跨项目存在相同 taskId；始终与所属项目 ID 联合显示。
- 全局出现多个测试占用时显示明确警告；某项目不可访问时显示读取失败而非静默省略。不会执行 claim、takeover、test-result 或其他状态变更。
- 没有创建后台服务、数据库或新 API；只复用现有只读 GET `/api/projects`、`/api/projects/:projectId/tasks` 和 `/api/projects/:projectId/tasks/:taskId/history`。
- 只改 `web/app.js`、`web/index.html` 和新增 `tests/global-qa-queue.test.mjs`；不修改 `server/` 任何文件。Ponytail full 已读。

## 实际 Git 与执行身份
- 最初在旧开发 Session `wc_sess_27d92cc0c86d411cb09b289458675039` 认领返回 `409 CLAIM_DEVELOPER_BUSY`（旧 P1 独测 FAIL 的保留责任）；不冒认旧任务。
- 改用全新合法 actor `wtb-dev-cross-project-qa-view-20261106-5acbc19f` 和 Session `wc_sess_5acbc19feeb74bcea4ee684ceea0d3fc`，先 guard/正式 preclaim `evt_7076696199dc8372aabe10c9`，正式 claim `evt_b4ec219eefc4de848e9b1864` →「开发中」。
- 真实受控独立 worktree 基线 `origin/main 21b4aba17a6946502a635aa02a8bbb2e98c15cee`；原主目录脏文件与其它 AI 工作区保全、不 reset、不改原基础设施/BUG。
- `code_change evt_67d112c9fc21aa83a370e35a`；源码增删改 SHA256 审计已追加到该隔离 worktree 下 `data/logs/changes/2026-11-06.jsonl`。正式 D01–D06 断点 PASS。

## 三轮开发自测
- **R1 正常与既有 UI 回归**：`node --test tests/global-qa-queue.test.mjs tests/web-ui-contract.test.mjs`，**18/18 PASS、exit 0**，验证候选列表、项目切换与旧看板布局未被移除。
- **R2 负向边界**：`node --test --test-name-pattern R2 tests/global-qa-queue.test.mjs`，**2/2 PASS、exit 0**：开发之外的旧 test_result 不得冒充 SHA，错误 SHA 不展示；同 taskId 跨项目不混淆，多测试占用给出警告。另 R3 标注项目不可达的单项也在 R1 通过。
- **R3 整仓**：`npm.cmd test`，job `ddf17e69-7032-41cd-91cf-75d5fb3bcd60`，**最终第二次整仓回归 61 个测试文件、0 失败、exit 0，duration 264350ms，data/runtime/validation/npm-test.json state=passed**。第一次整仓 job ddf17e69-7032-41cd-91cf-75d5fb3bcd60 61 文件中1个超时失败，task-step-checkpoint.test.mjs 单独复测 39/39 PASS、exit 0，第二次整仓 job 467fdf5f-bf64-45a3-91b1-30dc8f9c2592 61 文件0失败。两轮失败/复测证据均保留。
- `npm.cmd run check` exit 0；`git diff --check` exit 0。
- 验证边界：尚未在用户本机前台浏览器人工验收 UI 视觉；最终独测应以冻结远端 SHA 启动独立实例、核对两注册项目真实显示以及 HTTP 失败、同时独测占用场景。源码不新增 API 写请求。

## 下一流程
- 仅在 R3 和代码提交远端同 SHA 通过后登记开发自测 PASS，正式 `handoff` 交唯一 `test_ai`，释放开发占用；绝不开发代独测或合并 `main`。
- 独测 PASS 后由总控 AI 受控 main 合并、更新正式运行版、执行合并后回归及关单。旧的 BUG 修复和旧 P1 测试失败返修均由其他 AI 负责。
