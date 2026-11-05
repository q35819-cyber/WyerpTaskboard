# WTB-P0-QA-TAKEOVER-DELIVERY-EVIDENCE-20261105-T1｜开发自测与证据链

## 身份与唯一范围
- P0 BUG：用户授权的独测 Q2 正式 takeover 通过三轮 QA 后，候选评估与最终交付校验误把合法 PASS 当成无效，因为旧代码只认 `test_ai claim`。
- 开发 actor `wtb-dev-qa-delivery-20261105-27d92cc0`，任务正式 Session `wc_sess_27d92cc0c86d411cb09b289458675039`。
- 正式领取 `evt_a7d40aaa00e9d3ea8b633bee`，首轮 `code_change evt_b400141eff99dd1570f73d92`，复核 revision 加固 `evt_fc637b70d685031a5a2feefd`。
- 实际独立 Git worktree 基于 `origin/main 9a13bf0381114f373f27aae542c47c4ab39425bb`，主工作目录脏文件与其它 AI 工作区均保全。未改 C00 旧状态、旧 QA 报告、事件和关联计划。

## 修复实现（Ponytail full）
- 已读取 `AGENTS.md`、`WORKFLOW.md`、`流程文档/00_统一入口.md`、开发角色入口、`.agents/skills/ponytail/SKILL.md` full 和原任务计划；先搜索原 `deliveryEvidence`、`verifyDeliveryCompletion` 及现有调用，未建立新框架。
- 只改 `server/candidate-evaluator.mjs`、`server/task-store.mjs`、`tests/task-scan.test.mjs`、`tests/http-server.test.mjs`。共用 `latestAuthorizedTestExecution` 判断最新真实 `test_ai claim`，或有正式 `takeover_allowed` 且授权被新 actor/Session 的 `takeover` 消耗、具有真实开发 handoff、候选 SHA/分支/报告绑定的独测 PASS。
- 保留不同开发/独测身份隔离；要求 task-scoped 授权、用户指令来源和被转发身份一致、原测试者 Session 与授权匹配。授权中 `authorizedRegistryRevision` 需与正式授权事件的 `registry_revision_before` 相同，接管 `registry_revision_before` 需与授权事件的 `registry_revision_after` 相同。
- 保留旧 QA 正常 claim 路径、最新 PASS 后代码修改失效、STOP/硬依赖与总控交付权限；不直接合并 main，不做虚构接管。
- 真实 C00 原历史依据：Q1 claim `evt_106dab69c380e9cb415ba92e`、合法授权 `evt_52bebc985921052f1e4e3355`、Q2 takeover `evt_af1a1bec9f0d37c1c166ce10`、Q2 独测 PASS `evt_77c5c3b80caf0cb7290f8eac`，候选 SHA `3ba1282274dbcafc82d787441c4f05bbabcb61db`，未更改原事件。

## 实际测试证据
- **R1 正向与兼容**：`node --test tests/task-scan.test.mjs tests/task-store.test.mjs tests/http-server.test.mjs`，最终 job `9bfdb71d-97ef-484a-ba54-57d94b47d836`，**89/89 PASS，exit 0**。
- **R2 攻击性负向**：`node --test --test-name-pattern "authorized QA takeover" tests/task-scan.test.mjs tests/http-server.test.mjs`，**2/2 PASS，exit 0**。含伪授权、旧 actor/Session、接管授权撤销、候选 SHA 不匹配、PASS 后代码变化、过期 registry revision。真实 HTTP 总控 claim 合法通过，伪 Q2 409 被拒绝。
- **交付完成门禁实测**：临时 HTTP fixture 中，合法 Q2 PASSED、总控 claim 后的 `delivery_complete` 已通过独测独立性校验并到达下一道真实远端 Git 校验；因测试临时项目未配置远端，预期 `DELIVERY_REMOTE_UNAVAILABLE`，未伪称已在临时夹具完成远端合并。
- **旧代码兼容**：常规 claim 交付与候选扫描原测试仍在上述 89 项中 PASS。
- **R3 整仓最终**：`npm.cmd test`，job `008c518b-882d-4617-a729-82b44c478eb8`，**58 个测试文件，0 失败，exit 0，duration 248103ms，data/runtime/validation/npm-test.json state=passed**；初轮代码在修订前的 `ead25d0a-e0fa-4b17-a67c-e7bf068de063` 全仓 58 文件 0 失败，不能用旧结果冒充最终修订。
- `npm.cmd run check`：最终修改后 exit 0。 `git diff --check`：exit 0。
- 代码操作日志 `data/logs/changes/2026-11-05.jsonl` 两轮源文件 SHA256 记录均存在，保留首次变更和后续 revision 绑定补充；待最终 R3 后固定 Git 提交 SHA 及远端一致性。

## BUG 强制修三问与未完成责任
1. **解决了吗？** 在原独立候选源码、候选评估、实际 HTTP 总控认领和交付完成证据门禁测试中，合法 Q2 takeover 证据已能被接受；当前 main/运行版尚未合并，不能宣称生产已修好。
2. **会复现吗？** 已补授权关联、Session、候选 SHA、注册表 revision、撤销和事后修改的正反测试；正式独测与合并后回归必须再验证运行版，以证明该版本部署后不复现。
3. **后续流程正常吗？** 开发测试 PASS 不能代替唯一独测、总控受控 main 合并、远端 SHA 核对、实际交付 close。原 C00 的 `待交付` 记录与事件未手工更改，待本候选独测 PASS 和总控发布后系统重评候选并正常认领。

## 非授权边界
- 原 `WTB-P0-STEP-STARTUP-C00-20261104-T1` 历史、不相干的并行 claim 409 和旧 D09 游标均不在本任务代码范围。
- 本任务不新增状态机、假用户授权、UI 或登录；禁止开发代独测、代总控合并关单。
