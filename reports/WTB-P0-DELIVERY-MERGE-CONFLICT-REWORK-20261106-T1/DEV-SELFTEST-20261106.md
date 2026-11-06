# WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261106-T1｜开发自测与断点证据（候选，未独测）

## 正式权限
- 总控派工：evt_ed5d3c4eb6c5c0848e906680；预认领：evt_58f2db1305c5cd4d2abcf52e；正式claim：evt_9ba0156965528740e08b59dc。开发 actor wtb-dev-merge-conflict-rework-20261106-n1，Session wc_sess_28b7790cb05f4782be71adf498969be3。
- 主线/远端基线 d8c9c7d5d1a7d676f17acb6c51e70172f70ae6ba；主仓106个其它AI改动保留；独立工作区 wyerptaskboard-8e6b97ff，分支 fix/WTB-P0-DELIVERY-MERGE-CONFLICT-REWORK-20261106-N1。
- 开发步骤 D01–D06 由真实历史/代码/命令依序登记PASS。遵循Ponytail full，未修改原P1业务卡 web/app.js 或已完成任务。

## 目标与最小改动
- 正式总控已claim「交付中」并写 delivery_attempt_failed (failureStage=merge, candidateSha与QAPASS一致) 后，使用 taskctl delivery-rework 指定真实Git候选SHA、远端mainSHA；服务端在项目锁下同时验证本人Session、STOP、真正最新独测PASS、原开发身份、远端SHA与git merge-tree冲突，原子退为「待开发」释放总控占用。
- 旧PASS以 metadata.invalidatesTestEvidence=true 标为不可复用；事件保留原独测PASS及冲突证据。仅原开发actor用新Session可领取，不可用旧Session。新开发三轮自测与独测必须生成新的提交SHA后才交总控。
- 修改 server/task-store.mjs、server/http-server.mjs、server/workflows/wyerp-ai-flow-v1.mjs、cli/taskctl.mjs、tests/delivery-lifecycle.test.mjs，均属任务授权范围。没有新状态、后台服务、UI或新角色。

## 三轮真实验证
- R1：真实Git临时仓库构造add/add冲突，controller回开发、原测试PASS失效及 HTTP 正式API，合计2/2 PASS。R1 HTTP作业真实node --test --test-name-pattern "R1 controller HTTP endpoint" tests/delivery-lifecycle.test.mjs 1/1 exit0；混合R1/R2作业13d8c1dd有核心R1 PASS。
- R2：无合并失败登记、冒名、坏候选SHA、过期mainSHA、无冲突、STOP、旧QA失效、错项目、并发旧revision，4/4 PASS；混合真实作业13d8c1dd-3ba3-451d-817f-511bcbac6d7c exit0 5/5。
- 5个授权文件 node --check 5/5 PASS、git diff --check退出0（单项可重复核验）。
- R3：node D:/项目/.webcodex-managed-worktrees/wyerptaskboard-8e6b97ff-1faa-4df7-938c-2d1c48787df5/scripts/run-tests.mjs，Job 8de33a4f-db06-49e4-b961-bfb9f992632e，**整仓61个文件、failedFiles=0、退出码0、durationMs329283；R3默认套件PASS，但真实现代断点D01集成测试FAIL，D07必须BLOCK**。

## 已发现的上游流程缺口（必须合法解决）
- 当前任务 writeTargets 不包含 server/task-step-checkpoint.mjs；现有 modern role-steps-v2 的 D01 重入判断只处理正式QA FAIL的「修复中」和少数legacy恢复情形，没有「交付冲突返开发」eventType的开启新attempt条件。已经通过独立临时fixture实测：modern role-steps-v2旧D09_NEXT、正式总控派工和真实新开发claim evt_b8154b826a32b72f5b3fe276之后，D01记录**确实返回 CHECKPOINT_STEP_ORDER**，不是推测。**不能把状态机单位测试PASS当作完整D01–Q03业务闭环**。
- 需总控扩充原未完成任务授权写目标，或创建最小P0关联任务改 checkpoint 门禁（以真实交付冲突返修事件、原QA PASS、旧新claim身份/Session为证据开启新attempt），并进行真实断点恢复集成测试。不能直接编辑不在writeTargets的模块或虚造QA FAIL事件。
- D07已按真实结果登记**BLOCK**，正式SHA256断点6ed39e4150ce17fc837d7ba93fe9df499b8ac474558f802c7a067bc842646932；D08未执行，不交独测。必须由总控授权新增server/task-step-checkpoint.mjs写入范围或独立派P0最小修根因，完成真实现代D01新轮次测试及整仓复测后才能继续交接。

## BUG三问（阶段性）
1. 解决了吗？当前五授权文件的受控冲突退开发接口已在R1/R2通过，端到端新轮次断点仍有风险，不能称全面解决。
2. 还会复现吗？真实冲突/伪证据/STOP/错误SHA已加负向测试；若未修checkpoint门禁仍可能合法返开发后卡D01。
3. 后续流程正常吗？开发任务D07正式BLOCK，R3默认整仓61/61 PASS但现代新轮次D01实际失败；唯一独测/总控合并/实际业务卡返工尚未完成，必须关联步骤门禁最小任务。

## 正式退出与保全要求
- 不要将此五文件候选计为已交QA的PASS；应保存WIP到原任务隔离分支，保持 main 和旧业务卡不动。
- 当前拒绝扩大授权到server/task-step-checkpoint.mjs，只留真实代码及复现，等待总控合法扩范围或新关联任务交付。
