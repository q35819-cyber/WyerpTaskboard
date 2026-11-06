# WTB-P0-BLOCK-READY-NO-MANUAL-DISPATCH-20261106-T1｜隔离预开发三轮实测

> 2026-11-07｜开发 AI｜当前仅隔离候选。真实任务在本次核验时为「阻断」、无占用、无STOP；用户本轮明确命令“强制做”。尚无正式 D01 claim、独立测试 PASS 或总控主线交付，不得将本报告当作上述事件。

## 最小功能
- 基线：远端 origin/main `e4e154f93210321665b8cde7a57530c1e1157b4c`；独立受控 worktree，不改共享主目录。
- `server/task-store.mjs`：对原已合法开发认领的 D01/D09/verified developer 阻断，复用可信原始 `controller_dispatch`（发生在原claim之前）作为恢复授权；仍允许旧的真实后续派工。恢复前继续校验真实QA及main发布、Git祖先、STOP、硬依赖、消息、占用和失败事件。自动解阻保留 `authorizationEventId`，拒绝传入伪造值。
- `tests/task-auto-unblock.test.mjs`：模拟原授权后不重复派工的D01、D09、developer block，验证原子单次auto_unblock、待开发、真实新claim和D01至D02门禁；沿用现有无授权、假记录、STOP、未交付等负向回归。
- Ponytail full：实际读取 `.agents/skills/ponytail/SKILL.md`，检查 `TaskStore`、`CandidateEvaluator`、`TaskStepCheckpoint` 调用方与既有测试。无新增依赖、角色、调度器或新状态机。

## 实际验证（均针对同一最终源码）
| 轮次 | 命令/范围 | 结果 |
| --- | --- | --- |
| R1 正向 | `node --test tests/task-auto-unblock.test.mjs`，Job `12cc4037-cf4b-4107-964b-9df42f817cbf` | exit=0；22/22 PASS |
| R2 反向 | `node --test --test-name-pattern "D09 recovery denies\|D01 block never\|STOP\|unknown proof\|developer block recovery rejects\|without declared write targets" tests/task-auto-unblock.test.mjs`，Job `712f1ab0-2bb4-4f0c-b473-386034ff1b58` | exit=0；6/6 PASS |
| D01 专测 | `node --test --test-name-pattern "original formal D01 dispatch" tests/task-auto-unblock.test.mjs` | exit=0；1/1 PASS，实际claim与D01至D02 |
| R3 整仓 | `node scripts/run-tests.mjs`，Job `442e819c-907d-42a2-b7f1-6ccc09317fba` | exit=0；62文件，failedFiles=0，durationMs=314425 |
| 静态校验 | `npm.cmd run check` | PASS，exit=0 |
| 变更校验 | `git diff --check` | exit=0；仅两处源码文件 |

最终源码 SHA256：`server/task-store.mjs` = `5134c76982f2626e24c2ce2da1add106ca1f20e33aea83f4f75d941c77ad4ecb`；`tests/task-auto-unblock.test.mjs` = `4cfacaaa23167a25417cb2c355e096f584b8d88ee6b9fdc1b6800071537f6222`。

## BUG 三问（仅本候选阶段）
1. **解决没有？** 此候选的“已有可信派工但不能无重复派工自动解阻”路径已通过R1/R2/R3；真实主目录尚未部署，生产效果未确认。
2. **会不会再发生？** 已用旧未授权/伪造/未发布/STOP反例保护拒绝，原授权正向+D01真准入通过；不能保证所有历史非标准事件都可恢复。
3. **后续流程正常？** 隔离夹具的待开发→claim→D01→D02路径已实际PASS；真实任务仍阻断，正式claim、唯一独测、main部署与受影响任务解阻尚未运行，整体流程不能宣称完成。

## 后续合法动作
原任务 `WTB-P0-BLOCK-READY-NO-MANUAL-DISPATCH-20261106-T1` 需总控校验并恢复本开发的合法正式准入，再按当前源码和固定候选 SHA 走正式D01及独测；PASS后由总控C04-C07发布并用真实卡片复核自动状态流转。关联 `WTB-P0-READY-AUTO-FLOW-NO-DISPATCH-20261106-T1`（普通待准备自动流转）及 `WTB-P0-LEGACY-D09-REBLOCK-AFTER-AUTO-UNBLOCK-20261106-T1`（旧D09游标）各有独立范围，本文未修改其任务或假报完成。
