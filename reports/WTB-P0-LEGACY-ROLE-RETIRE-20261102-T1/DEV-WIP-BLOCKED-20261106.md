# WTB-P0-LEGACY-ROLE-RETIRE-20261102-T1｜开发候选保全与真实 BLOCK

## 任务身份与边界

- track：`infrastructure`，本卡是**普通基础建设任务**，不是 BUG 修复任务。用户已明确本开发负责正常任务，BUG 交其他开发。
- 正式开发 claim：`evt_ecb2bfcf523396ebfb84a79b`，actor：`wtb-dev-legacy-role-retire-20261106-27d92cc0`，Session：`wc_sess_27d92cc0c86d411cb09b289458675039`。
- 源主线与本候选基线：`21b4aba17a6946502a635aa02a8bbb2e98c15cee`。使用独立 Git worktree，不对主目录执行 reset、stash、覆盖、删除或 git add；原主目录的未提交 r1 规则改动和其他 AI 文件全部保留。
- 已读最新 `流程文档/00_流程与重大更新日志.md`、统一入口、开发角色入口、任务主计划及 `.agents/skills/ponytail/SKILL.md`（full），遵循最小必要迁移。
- 原主目录 19 个已跟踪旧角色清理 WIP 由 Git 差异逐项校验后进入隔离 worktree，**19/19 个文件的规范化 git hash-object 与原主目录一致**。其中 7 项旧活动文件仅在本候选删除；另额外最小更新一项现有过期断言测试 `tests/chatgpt-mcp-executor.test.mjs`，不改执行器。
- 源计划记录的旧规则备份及原历史保留；此次不改动任何原始备份、事件或其他项目业务数据。操作记录 `data/logs/changes/2026-11-06.jsonl` 共 20 项，分别保存原 SHA256 与候选 SHA256，临时测试 fixture 均已清理。

## 真正完成的最小目标

- 根 `AGENTS.md`/`WORKFLOW.md`/`README.md` 与模板提示词只将 `流程文档/00_统一入口.md` 及三个新角色目录作为权威；职责明确开发自测交唯一独测、独测 PASS 总控负责受控合并/回归/清理/关单。
- 旧根目录三角色文件、模板三角色文件和重复的旧 Git 合并流程文档从**候选**移除；`docs/governance/` 三个兼容指针改为指向新的角色入口。
- `tests/software-project-template.test.mjs` 已检查旧六角色文件不存在、新角色版本匹配、相对路径可迁移、Node/Python 样例本仓运行。过期的 `tests/chatgpt-mcp-executor.test.mjs` 单一旧职责正文断言已改为验证新角色入口文件，执行器业务代码完全未动。

## 三角度真实验证（不能把整仓 PASS 冒充全部验收）

1. **正向**：`node --test tests/software-project-template.test.mjs tests/chatgpt-mcp-executor.test.mjs`，修后 **15/15 PASS、exit 0**。
2. **负向**：`node --test --test-name-pattern "retired root role manuals|machine-specific installation paths|role governance docs referenced by wake prompt" tests/software-project-template.test.mjs tests/chatgpt-mcp-executor.test.mjs`，**3/3 PASS、exit 0**。根/模板旧角色文件不得存在，活动入口无机器专用安装路径，唤醒治理引用指向最新角色文件。
3. **整仓回归**：首次 `npm.cmd test` job `9fc817c8-7792-4b33-8a51-fc590f4d124c` **60 文件/1 FAIL，exit 1**：旧测试错误要求已退役开发职责正文包含 `delivery-failed`；保持失败历史，按当前规则修正该测试后重新执行。最终 `npm.cmd test` job `7c329c38-21a7-4e6d-842b-fbb269eb6426` **60 文件、0 失败、exit 0**，`data/runtime/validation/npm-test.json` state=passed / duration 259626ms。`npm.cmd run check` 和 `git diff --check` **exit 0**。
4. **额外真实迁移负向发现（未修，非本任务范围）**：复制全部 `templates/webcodex-v1` 到新目录且旧角色文件保持缺席后，Python 样例 `python -m unittest discover -s tests` **exit 0**，Node 样例原申报质量命令 `node --test tests` **exit 1（MODULE_NOT_FOUND：复制后目录中的 tests 被当作单个模块）**。原源码目录中相同 Node 测试正常。该质量命令可移植性需要独立最小任务验证/修复，不能以本仓 PASS 代替新目录真实 PASS。原任务没有授权修改样例配置或运行器，因此本开发不扩大范围。

## 正式门禁 BLOCK 及恢复责任

- 虽已由系统 `auto_unblock evt_005077773a4107ec27428d56` 后合法新 `claim evt_ecb2bfcf523396ebfb84a79b` 进入「开发中」，**当前唯一 checkpoint 的 developer cursor 仍为旧 `D09_MERGE_MAIN`，SHA `a266ceb75321d65b770470bec14406fa67a6b6367701d38801a573f8e59a8c99`**。实际 `node cli/stepctl.mjs record ... --step D01_CLAIM --event-id evt_ecb2... --expected-sha256 ...` **exit 1 / CHECKPOINT_STEP_ORDER**，并非自测 PASS。
- 用户已指令本开发只做普通任务，BUG 由其他 AI 修；本开发已把真实 D09→D01 复发错误交总控 `wc_msg_32c7ed4bf86e45da89701e5997d5a9c9`，请依据旧任务 `WTB-P0-LEGACY-D09-REENTRY-BUG-20261105-T1` 和 `WTB-P0-BLOCKED-D09-AUTO-RECOVERY-20261105-T1` 的已发布源码独立定位合法新轮次条件，**不得人工篡改旧断点/事件或伪造 D01 PASS**。
- 另一关联：原任务 registry 的 writeTargets 未列出旧重复流程文档、模板 README/CONTRACT 与直接受影响的 `tests/chatgpt-mcp-executor.test.mjs`，而任务计划要求消除旧活动引用并修正必要测试。总控/独测应在本次候选合并前按真实任务计划核定这三个最小关联范围，不应将必要测试返修当成任意扩大需求。
- 本候选虽然源码和现有整仓测试通过，但**D01 正式步骤及迁移 Node 质量命令仍 BLOCK**，**不得提交开发 test-result PASS、独测 handoff、合并 main、部署或正式关单**。候选固定 Git 提交 SHA 与远端核验将写入正式任务事件，之后由其他 BUG 开发修前置，合法重新打开 D01 再重新核验本候选。

## 下一责任角色

- 总控：登记这两项真正 BLOCK，指派另外的 BUG 开发修补并在当前原任务记录可信自动解阻条件；保护本候选/原 WIP，不要求用户操作 Git。
- 正常开发：本任务受阻材料冻结后释放当前占用，继续领取不属于 bugfix 的下一个合法独立任务；本卡解阻时再合法恢复未完步骤。
- 唯一独测：只有本卡 D01→D08 正规完成并重新验证后才独立验候选；随后总控负责 main 串行交付。
