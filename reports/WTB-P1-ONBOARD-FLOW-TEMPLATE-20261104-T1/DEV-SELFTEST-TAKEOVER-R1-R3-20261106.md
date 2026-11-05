# WTB-P1-ONBOARD-FLOW-TEMPLATE-20261104-T1｜用户授权接管后开发三轮自测

## 身份、来源与最小范围

- 任务原状态：修复中；正式异常接管事件：`evt_5595e8105dac97fd6faac084`，不覆盖原开发 Session 或工作区。
- 本次开发 actor：`wtb-dev-onboard-takeover-20261106-d2`；Session：`wc_sess_82e7a012f11f460682a3ea9c3f2c9551`。
- 新独立分支：`fix/WTB-P1-ONBOARD-FLOW-TEMPLATE-20261106-D2`；基线：`main@21b4aba17a6946502a635aa02a8bbb2e98c15cee`，该基线与启动时的远端 main 一致。
- 原功能提交：`dd45cb3625c24fa8cf18c7192cfca98d69b93a64`，将现有流程关联函数、七文件 manifest 与原有测试安全移植到已包含 P0 角色职责漂移修复的最新 main；原独测 FAIL 和旧报告保留。
- 本轮范围：`server/project-onboarding.mjs`、`tests/project-onboarding.test.mjs`、`templates/software-project-v1/manifest.json`。不新增第二套流程、不改旧三角色模板源、不修改其它项目或原工作区。
- Ponytail：`.agents/skills/ponytail/SKILL.md`，full。

## 开发自测（真实命令与结果）

| 轮次 | 验证 | 实际证据 |
| --- | --- | --- |
| R1 功能 + 权威入口 | `node --test tests/project-onboarding.test.mjs tests/template-role-consistency.test.mjs` | 11/11 PASS，退出码 0；实际复制三角色入口，确认模板源总控负责合并 |
| R2 负向及旧失败防回流 | `node --test --test-name-pattern "R2:|R3:" tests/project-onboarding.test.mjs tests/template-role-consistency.test.mjs` | 7/7 PASS，退出码 0；验证未知注册、重复创建、业务规则不覆盖、过时开发合并职责被拒绝 |
| R3 整仓回归 | `npm.cmd test` | 60 个测试文件，0 失败，退出码 0；Job `fb71e231-58f9-4a2c-bdc8-e94f0302a621`，275678 ms |
| 辅助检查 | `npm.cmd run check`、`git diff --cached --check` | 均退出码 0 |

## 旧独测缺陷、保留历史与门禁

原 QA FAIL：`evt_2dfc4b965cb30f83ae05fd02`，旧候选 `dd45cb3`。旧模板源把合并交还原开发，且引用未复制的旧根职责文件；该根因已由关联 P0 `WTB-P0-ONBOARD-TEMPLATE-ROLE-DRIFT-20261105-T1` 修复并进入上述 main。新候选在当前权威模板上复制，正负测试及整仓均 PASS；仍必须由唯一独测以新候选 SHA 重新测试，不复用旧开发或 QA PASS。

正式 D01 步骤记录试验遇到 `CHECKPOINT_PREDECESSOR_REQUIRED`（要求总控可信派工），旧断点仍为开发 `D09_NEXT`、独测 `Q02_TEST`；此门禁**未通过**，不得把步骤门禁视为 PASS，更不能冒用总控事件。新一轮合法接管、代码变更与自测已分别登记在任务事件历史，正式交接需再次核验服务端结果。

## 修复三问（仅限开发候选）

1. **问题解决没有？** 以最新已发布模板为基础，旧角色职责漂移的相关正负回归通过；源代码候选的行为验证通过，尚非独测或主目录发布。
2. **以后会不会复现？** 已验证现有业务文件不覆盖、旧错误交付角色不能重新进入模板，仍需独测确认和后续发布回归；不可绝对保证不复现。
3. **后续流程正常吗？** 代码路径的三轮自测正常，但 D01 新轮次断点门禁仍报 `CHECKPOINT_PREDECESSOR_REQUIRED`；独测/总控交付未经核验之前不得说流程完全恢复。

旧报告、工作区、原 actor/Session、旧独测 FAIL 保持原样。当前报告仅属于新开发候选证据；最终候选 SHA 以正式提交及任务交接事件的核验结果为准。
