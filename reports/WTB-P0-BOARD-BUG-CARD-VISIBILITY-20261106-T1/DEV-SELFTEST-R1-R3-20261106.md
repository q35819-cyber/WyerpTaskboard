# WTB-P0-BOARD-BUG-CARD-VISIBILITY-20261106-T1｜开发三轮自测报告

## 目标与任务权限

- 正式 P0 BUG：将看板上 `track=bugfix` 错误展示为“其它类别”的任务卡，改为醒目且唯一的 `BUG` 徽标和红色左侧色条。属于 P0 BUG 或 P1 BUG、任意合法状态都要正确显示。
- 正式任务号 `WTB-P0-BOARD-BUG-CARD-VISIBILITY-20261106-T1`，来自总控派工 `evt_d1bfe001515f142310b807f8`。
- 开发 actor `wtb-dev-bug-card-20261106-27d92cc0`、正式 Session `wc_sess_27d92cc0c86d411cb09b289458675039`；预认领 `evt_23db9e36bdbd145e97d246eb`，claim `evt_6574900614bd38b6846d222c`，实际 code_change `evt_e168e64b9fedcd26850b2e39`。
- 独立干净 worktree `wyerptaskboard-23ed24de-261b-41eb-a733-d56ceb3542e0`，基于 `origin/main e58c204be5c1d7ac5c9676b32365075285857b3c`。原主目录历史修改和其它 AI 占用保全。
- 已读最新版统一流程、开发角色入口、BUG 强制闭环规范及 `.agents/skills/ponytail/SKILL.md`（full）。
- **唯一授权源码/测试范围**：`web/app.js`、`web/styles.css`、`tests/board-static-assets.test.mjs`。无服务端、真实状态、排序、优先级、筛选或六列布局的修改。

## 实际最小实现

- `web/app.js`：在共享 `TRACK_LABELS` 加 `bugfix: "BUG"`，从而统一卡片、筛选及表格任务类别；只在 `task.track === "bugfix"` 时给卡片 `bug-card` 和类别徽标 `bugfix` CSS 类，保留真实状态及优先级徽标。
- `web/styles.css`：沿用现有 `task-card`/`badge` 样式，只加两条选择器，使 BUG 卡片有红色左侧色条和高对比“BUG”徽标。
- `tests/board-static-assets.test.mjs`：以 Node `vm` 执行**真实 app.js 中的**类型映射、卡片和列表渲染函数，测试状态与类型的正反例。
- 采用原有 DOM 结构与 CSS，不新增依赖、全局 UI 组件、登录或第七列。

## 三轮真实开发测试

1. **R1 核心正向**：`node --test tests/board-static-assets.test.mjs`，第一次 **2/3 PASS、1 FAIL**（测试夹具缺少 `planName` 模拟函数，非业务代码），夹具修正后重新运行 **3/3 PASS、exit 0**。验证不同优先级/不同真实状态的 BUG 卡仍显示“BUG”和原状态、颜色样式与现有 HTTP 资源。
2. **R2 负向与数据不误标**：`node --test --test-name-pattern R2 tests/board-static-assets.test.mjs`，修正后 **1/1 PASS、exit 0**。产品/基础设施/未知类型及标题或任务 ID 含 BUG 都不会误标，列表“任务类别”使用真实 `track`，不通过 ID 猜测。
3. **R3 全仓回归**：`npm.cmd test`，实际 job `618ef0fc-d791-4127-851d-1208383bd142`，**60 个测试文件、0 失败、exit 0，duration 261815ms，data/runtime/validation/npm-test.json state=passed**。
4. `npm.cmd run check` 实际已退出 0。`git diff --check` 在正式交接前再次核验。
5. 审计记录 `data/logs/changes/2026-11-06.jsonl` 中已追加三项源码/测试 SHA256 变更日志并读回。正式开发步骤 D01–D06 PASS；D07 只有 R3 真通过才能通过。

## 测试和发布边界

- **BUG 三问**：①源代码和定向回归已解决“其它类别”误显示，但远端发布前不能宣称用户正式运行版已经修复；②已加正反例防回流，仍须独测和正式 main 合并后回归；③独测/主线交付尚待正式完成，不能宣布所有后续流程正常。
- 用户另要求“待执行列右上角 BUG 数量”和“状态改变立即刷新”，两项不属于本单已授权 `web/app.js` 类型显示最小范围，需分别由对应任务开发，不在已完成任务或本单增补范围。
- 唯一独测 `test_ai` 使用全新 actor/Session 从冻结远端候选 SHA 检出并复核三轮；只有其 PASS 后总控合法合并 main、运行版回归、清理、关单。开发不代测、不自合 main。
