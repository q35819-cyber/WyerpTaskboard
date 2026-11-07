# 测试失败任务异常接管门禁修复｜开发验证候选

- 记录时间：2026-11-06（UTC+08:00）
- 角色：开发 AI；原开发、独立测试、总控职责保持分离
- 用户授权：原开发未继续工作则异常接管；随后明确指令「强制修」
- 关联原任务：`WTB-P1-ONBOARD-FLOW-TEMPLATE-20261104-T1`（现状：测试失败待修复）
- 已发布关联根因修复：`WTB-P0-ONBOARD-TEMPLATE-ROLE-DRIFT-20261105-T1`
- 本候选 BUG 编号：`WTB-P0-QA-FAIL-TAKEOVER-20261106-T1`（仍需总控按正式任务流程登记/派工）
- 基线：`main@21b4aba17a6946502a635aa02a8bbb2e98c15cee`
- 隔离分支：`fix/WTB-P0-QA-FAIL-TAKEOVER-20261106-T1`
- Ponytail：`.agents/skills/ponytail/SKILL.md`，full

## 问题与最小修改

用户授权异常接管时，已退回「测试失败待修复」的任务收到 `SUSPECTED_DISCONNECT_STAGE_INVALID` (409)；不带疑似失联标记的直接授权又无法识别用户明确的「你就按异常接管」条件式表达，返回 `USER_SESSION_REQUIRED` (403)。

仅修改 `server/http-server.mjs` 与 `tests/takeover.test.mjs`。在保留原执行中与待交付接管行为的前提下，允许正式、无占用的独立 QA FAIL 任务经可信开发 CLI、当前明确聊天授权与新 actor/Session 接管至「修复中」。严格检查 STOP、活动测试资源、原独测 FAIL 事件、原开发身份和原/新 worktree 核验，防止旧开发冒领、证据重用或跳过新一轮独测。历史 FAIL、原会话及原工作区不删除。

## 开发三轮真实结果

| 轮次 | 命令 / 检查内容 | 实际结果 |
| --- | --- | --- |
| R1 主路径与局部负向 | `node --test tests/takeover.test.mjs` | 4/4 PASS，退出码 0 |
| R2 兼容和权限边界 | `node --test tests/taskctl-takeover.test.mjs tests/delivery-takeover.test.mjs` | 15/15 PASS，退出码 0 |
| R3 整仓回归 | `npm.cmd test` | 60 个测试文件、0 失败，退出码 0 |
| 附加静态检查 | `npm.cmd run check`; `git diff --check` | 均 PASS，退出码 0 |

原「测试失败待修复」任务未被本候选直接修改，也未启动正式服务或合入主线。

## BUG 修复三问

1. **问题解决没有？** 开发候选中经真实 HTTP 测试已解决；正式运行版尚未合并，不能宣称线上/本地主程序已修复。
2. **下次会不会复现？** 新增原话授权和 QA FAIL 接管的回归断言，旧接管兼容测试也通过；未来不会绝对保证，最终取决于唯一独测及受控发布回归。
3. **后续流程正常吗？** 候选中的接管后任务进入「修复中」、历史 QA FAIL 保留且必须重新独测；原 P1 任务仍待本门禁正式发布后重新接手、三轮自测和独测，不能宣称已完整闭环。

## 交接边界

这份材料是开发阶段自测证据，不是独立测试 PASS、正式 claim、总控交付或关单证明。须按项目现行规则补齐合法任务登记/认领、唯一独测 PASS、总控受控合并/回归/关单；不能直接覆盖历史状态或绕过门禁。
