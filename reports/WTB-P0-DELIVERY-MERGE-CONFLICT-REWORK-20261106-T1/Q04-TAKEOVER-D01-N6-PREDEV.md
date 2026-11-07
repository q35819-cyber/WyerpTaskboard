# Q04 后授权接管 D01 步骤门禁修复 — N6 独立预开发证据

> **仅 WIP 预开发；未正式认领新 P0，未交独测，未合并 main，未发布。**

## 来源及准确根因
- 来源业务：`WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261106-T1`，开发 N5 合法接管事件 `evt_286d798c2498d7f154301d31`。
- 旧独测 Q04 已结束，开发游标 null；上游真实 `controller_rework_requeue` 后新开发 claim，再经用户授权正式 takeover，`D01_CLAIM` 抛 `CHECKPOINT_STEP_ORDER`。
- `WTB-P0-LEGACY-D09-REBLOCK-AFTER-AUTO-UNBLOCK-20261106-T1` 只修旧 D09 游标，不是现代 Q04 接管的直接硬前置，不应混为同一缺陷。
- 原业务卡有原合法 owner 和独立候选 `2a464edae65c3428d438a94a2713282f9c2a67cb`，当前处于开发问题暂停状态，不得复用先前 QA PASS。

## 修复范围
- `server/task-step-checkpoint.mjs`：只允许前轮真实 Q04 PASS、D08/独测 PASS、正式总控回流重新入队、前任开发正式 claim、用户授权新会话 takeover 的特定链重启 D01；仍校验授权来源、原会话、suspicion、STOP、硬依赖，旧 QA 记录保留，旧 Session 拒绝。
- `tests/task-step-checkpoint.test.mjs`：新增有效 Q04 接管和负向路径（无 Q04、无授权、假原会话、无正式回流、STOP）测试。
- 此修改**超出原业务卡登记的 writeTargets**，需要总控按最小独立 P0 BUG 正式创建/授权后，方可由合法开发纳入流程。当前隔离工作区仅用于复用代码和验证，严禁直接 main 合并。

## 实测（Windows WebCodex Runner）
- R1: `node --test --test-name-pattern="modern Q04" tests/task-step-checkpoint.test.mjs`，2/2 PASS，exit 0。
- R2: `node --test tests/task-step-checkpoint.test.mjs`，47 项中 46 PASS、1 FAIL，exit 1；唯一失败为 `portable flow paths stay relative and published template matches canonical steps`，报 `out-of-sync portable template: 00_流程与重大更新日志.md`。
- 已对未修改主线相同独立断言实测，主线亦 exit 1、同一报错，确认原有模板不一致，而非本补丁引入。未越范围修改共享规则/模板。
- R3: `node --test tests/delivery-lifecycle.test.mjs tests/task-store.test.mjs tests/delivery-takeover.test.mjs`，44/44 PASS，exit 0。
- `node --check server/task-step-checkpoint.mjs` 与 `node --check tests/task-step-checkpoint.test.mjs`，exit 0。
- **不可称整仓 PASS**；QA/实际生产 D01 复测都未执行。

## BUG 三问
1. 问题解决没有？隔离代码新增场景测试 PASS；正式程序**尚未修复**。
2. 是否会再出现？授权、旧 Session、STOP 等负向样例拒绝；实际发布后的重现风险尚需独测和真实接管场景验证。
3. 后续流程正常吗？相关 44 项回归通过，但完整步骤测试被既存模板失败挡住，正式 D01/独测/总控交付尚未恢复。

## 下一合法动作
总控对现代 Q04 完成后合法 takeover 重开 D01 的缺口去重并给出**正式独立最小 P0 BUG 任务与写范围**；开发从本 WIP 候选合法领取、三轮自测；唯一独测固定 SHA；总控真实合并/部署并复测原业务卡。另由既有模板同步责任任务处理独立基线失败，不得伪造 PASS。
