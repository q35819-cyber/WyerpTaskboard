# WTB-P0-ONBOARD-TEMPLATE-ROLE-DRIFT-20261105-T1｜开发三轮自测与受限范围

## 真实任务依据
- 本卡独立 P0 修复“新项目流程模板源中的旧根角色依赖和原开发者合并关单职责漂移”，旧 QA FAIL 证据由原 P1 保留；不重开已完成/失败任务。
- 正式 claim `evt_36f43b267e294ac28910e547`、代码变更 `evt_5132feef5b76ca1f06861451`、manifest 原候选检查 `evt_317067701c17ad333818b27b`。
- 开发 actor `wtb-dev-role-drift-20261105-27d92cc0`、Session `wc_sess_27d92cc0c86d411cb09b289458675039`；独立 worktree 基于 `origin/main 9a13bf0381114f373f27aae542c47c4ab39425bb`。保留主目录其它AI未提交内容。
- 本报告只是**开发自测**，不等于独测 PASS、主线合并或运行版恢复。

## Ponytail full 与最小实现
- 实际读取当前 `.agents/skills/ponytail/SKILL.md`（full）、统一流程入口、开发入口、任务计划、现有模板源与下游关联。
- 唯一修改范围：`templates/webcodex-v1/AGENTS.md`、`templates/webcodex-v1/WORKFLOW.md` 和新增 `tests/template-role-consistency.test.mjs`；无新依赖，无 manifest/复制函数/其他项目代码修改。
- 模板 AGENTS 源声明唯一 `流程文档/00_统一入口.md` 与 `流程文档/<角色>/00_角色入口.md`，不要求 manifest 未复制的旧根 `开发AI.md`、`总控AI.md`、`独立测试AI.md`。
- 模板 WORKFLOW 将独测 PASS 后的待交付认领、远端 main 合并、回归、部署和关单指定给 **总控 AI**，不再赋权原开发者。保留 STOP、硬前置、单开发单任务与独立 QA 校验。

## 三轮实际自测
- **R1 源规则正向**：`node --test tests/template-role-consistency.test.mjs`，**4/4 PASS，exit 0**；验证唯一角色入口、总控交付及旧根文件非依赖。
- **R2 负向注入**：`node --test --test-name-pattern "R2:" tests/template-role-consistency.test.mjs`，**1/1 PASS，exit 0**。主动加入旧开发者合并/仅原 Session 认领/旧根职责文本时检查确实拒绝。
- **额外兼容**：`node --test tests/software-project-template.test.mjs tests/project-onboarding.test.mjs`，**7/7 PASS，exit 0**；保留原技术栈识别和模板配置契约。
- **R3 整仓**：`npm.cmd test`，job `43a09653-74ed-41fa-b827-1d1039b605c9`，**59 个测试文件、0 失败、exit 0**，277262ms；验证记录 `data/runtime/validation/npm-test.json` state=passed。
- `npm.cmd run check`，job `e45e0998-d142-4fbe-bd3b-ee0f51e8a631`，exit 0；`git diff --check` exit 0。

## 真实 manifest 检查与待闭环依赖
- 当前正式 main 尚无 `templates/software-project-v1/manifest.json`，原因是原 P1 `WTB-P1-ONBOARD-FLOW-TEMPLATE-20261104-T1` 仍以候选提交 `dd45cb3625c24fa8cf18c7192cfca98d69b93a64` 等待独测/合并。
- 已独立执行 `git cat-file -t dd45cb3625c24fa8cf18c7192cfca98d69b93a64` 和 `git show dd45cb3625c24fa8cf18c7192cfca98d69b93a64:templates/software-project-v1/manifest.json`，**均 exit 0**。确认为真实七文件清单，包含 AGENTS、WORKFLOW、三角色入口及 Ponytail，不包含旧根角色文件。
- 新测试在 manifest 尚未正式合入当前主线时明确输出未集成诊断，不假报已经完成端到端模板复制验证。
- 另外，`templates/webcodex-v1/流程文档/开发/00_角色入口.md` 当前仍含旧 D09_MERGE_MAIN→D13_NEXT 步骤；本卡明确不允许改该路径，已消息 `wc_msg_b14337e8879546dcbf6865f81885db8a` 告知总控须查既有授权任务或另立最小 P0，不能在本卡顺手扩大范围。

## BUG 三问
1. **解决了吗？** 本卡授权范围内的旧 AGENTS/WORKFLOW 模板文字冲突已由正负测试证实修正；当前尚非已发布主线，不能称整个项目接入流程修好。
2. **同一问题会复现吗？** 已加旧合并责任/旧根入口负向回归；正式 QA 与总控受控发布后必须在合并后的 manifest 和真实目标项目复验。
3. **后续流程正常吗？** 当前开发三轮 PASS；关联 P1 manifest 交付及旧模板开发角色入口 D09 漂移还未闭环，须由总控派相应最小 BUG 并发布，不能宣称全流程正常。

## 责任边界
- 本候选须交唯一独测 AI 从冻结 Git SHA 独立三轮复核；PASS 后由总控 AI 串行合并 main、执行主线和运行版回归、正式关单。
- 禁止重写旧 QA FAIL、手工状态、root dirty 成果，禁止自行变更已完成任务或越权复制其他业务规则。
