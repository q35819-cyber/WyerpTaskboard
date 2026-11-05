# WTB-P1-ONBOARD-FLOW-TEMPLATE-20261104-T1｜开发自测 R1–R3

任务状态：开发中；报告为开发自测，不代表独立QA或总控合并。

## 目标和边界

- 单一功能：将已存在的版本化三角色流程模板关联到已注册项目；目标项目存在同名业务规则则不覆盖。
- 不重写项目注册、技术栈识别或自动流程调度；也不编辑旧 `templates/webcodex-v1` 原件。
- 正式 claim：`evt_bd97f19dfb3a968ad3becf0d`；变更登记：`evt_58ee294032dc77aba3f7832b`。
- 开发 actor：`wtb-dev-isolated-parallel-20261105-27d92cc0`；开发 Session：`wc_sess_27d92cc0c86d411cb09b289458675039`。
- 独立 worktree 基线：`fa3a452bfee6ee43d911dfaf1c4c370fcbd9eff3`；主目录其他AI成果保全。

## Ponytail full 与实现

- 真实读取 `.agents/skills/ponytail/SKILL.md`（full）并检查原 `detectProjectStack`、已有 `ProjectRegistry.get` 和 `templates/webcodex-v1` 的三角色源码/入口。
- 复用现存模板，不加第三方依赖，不造新流程或启动守护进程。
- 只新增 `templates/software-project-v1/manifest.json` 指明复用源与七个必需文件；`server/project-onboarding.mjs` 新增 `linkRegisteredProjectWorkflow(registry, projectId)`；扩充原 `tests/project-onboarding.test.mjs` 测试。
- 通过已注册项目的 `get(projectId)` 校验项目，首先读取所有模板源文件；逐层创建安全目标父目录并用既有 `resolveProjectPath` 校验；`fs.copyFile(..., COPYFILE_EXCL)` 仅创建不存在的文件；返回 `created`、`preserved` 与模板版本。重复执行不覆盖旧文件。

## 三轮实际验证

- R1 正向与现存栈识别兼容：`node --test tests/project-onboarding.test.mjs`，最终 **7/7 PASS，退出码0**；含 Node/Python/.NET 和七个模板文件原文可读核验。
- R2 负向与数据保全：`node --test --test-name-pattern R2: tests/project-onboarding.test.mjs`，最终 **4/4 PASS，退出码0**；未知项目拒绝，无本地目录变更；已有 `AGENTS.md` 和 `流程文档/00_统一入口.md` 均保留；第二次执行全部preserved。
- `npm.cmd run check`：**PASS，退出码0**。
- R3 整仓回归：`npm.cmd test`，job `e152babe-fdc1-41ac-8737-ba8c1c131865`；**58个测试文件，0失败，退出码0，247287ms**；`data/runtime/validation/npm-test.json` 最终 `state=passed`。
- `git diff --check`：PASS，退出码0；最终提交 SHA 将在整仓 PASS 后冻结。

## 失败与整改

- 首轮 R1 两项 FAIL，路径安全函数要求目标文件父目录已存在，报 ENOENT；未改路径核心模块，通过先逐层安全新建目录并核对实际路径修复，随后 R1 和 R2 全部重跑通过。

## 下一责任和已知限制

- 开发三轮全部PASS后才提交、推送正式候选分支，释放开发占用并交唯一独测；总控负责受控合并与实例回归。
- 本任务只实现可调用的模板关联入口，并未触发新项目注册时自动调用（注册器不在当前写入授权范围，具体触发流程由总控关联计划裁定）。
- 原始 `templates/webcodex-v1` 的若干旧角色文档与新三角色总控合并规则可能存在版本漂移；本单不越权重写原模板，独测需核对当前版本及总控是否允许直接推广。
