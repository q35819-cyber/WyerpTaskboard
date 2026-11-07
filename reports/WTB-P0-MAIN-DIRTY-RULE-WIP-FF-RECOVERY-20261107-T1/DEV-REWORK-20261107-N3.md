# WTB-P0-MAIN-DIRTY-RULE-WIP-FF-RECOVERY-20261107-T1｜接管返修开发报告

## 任务身份与保全
- 真实任务：`WTB-P0-MAIN-DIRTY-RULE-WIP-FF-RECOVERY-20261107-T1`，P0 BUG，正式领取 `evt_aa498e67a350e44d1b939ba0`，本开发 actor `wtb-dev-20261107-self-repair-takeover-n3`，业务 Session `wc_sess_825033eadb04469ab2c6ee5910162622`。
- 旧开发原始独立保全候选 `616dd02e567ab79149737b2de44e6ce9e6a3ca15`；本轮新隔离worktree `wyerptaskboard-87e5ccbf-8bc7-4fca-8eca-f8a840dd8aa3`、分支 `fix/wtb-p0-main-dirty-rule-recovery-20261107-n3`，以 `origin/main` 为基线无冲突 rebase，候选代码SHA `dfee7c2e336844d37e8b7abe6f0dff3d4a34fe85`，重写前旧候选原SHA永久保留。未执行reset/stash/checkout-force/clean/主目录merge。
- 冻结 manifest `D:/项目/.wtb-controlled-delivery/.preserved-main-rule-wip-20261107-n1/manifest.json` 的SHA256为 `da245cdd96b9b0d631f83509d2cd473259d7a57314d184f7611f8958e117c3d4`；实时核对主目录原有两份脏规则分别保持 `fd1f7c992010823fe30dae6caf02dbe20cc6151b42c650fd9f807c8284ec3a1e` 和 `1eeecf3231e38cd7f7efa9071202183c7134351f791d0390e8e038de2c0ebc04`，与manifest字节一致，其他AI工作区未改。
- 写入范围仅原开发已完成的两份权威规则和对应模板镜像及现有 `tests/software-project-template.test.mjs`；本轮未新增第三方依赖、新API、新系统状态、主目录写入或额外生产代码。
- Ponytail full：复用原Git rebase、原模板同步、原规则测试和sha256；无需新造规则融合器、后台进程、复制原仓库。
- 规则文件：`流程文档/06_全任务依赖审计与阻断优先调度规范.md`、`流程文档/总控/C03_DISPATCH_正式派工.md`；同名模板镜像相同。原用户认可的完整阻断链P0和已发布普通待准备自动准入/例外派工内容均保留。

## 真实三轮开发验证
1. **R1正向内容与模板**：`node --test tests/software-project-template.test.mjs`，4/4 PASS exit 0。验证原WIP新增阻断链和新main自动准备规则同在。
2. **R2保全和拒绝路径**：Node只读脚本针对原manifest与主目录SHA、模板文件镜像、冲突标记、原WIP新增行、Git无脏改及 `git diff --check origin/main...HEAD` 做11项核对全部 PASS exit0；另在纯内存中模拟字节篡改/镜像不一致/冲突标记，6/6均正确拒绝，**总计17项PASS**。原脏文件未写，未知owner不操作。
3. **R3整仓真实FAIL**：`node scripts/run-tests.mjs` 实际作业 `191b1e64-d903-4b48-a52b-df0eee26821c`，**62测试文件，failedFiles=1，退出码1，durationMs=341985**。失败工件为 `data/runtime/validation/npm-test.json`，唯一失败 `tests/multiproject-lifecycle.test.mjs` 首例 `three managed projects share the same workflow without cross-task state or history`；该文件第24行 `app.server.listen(0,"127.0.0.1")` 偶发选中 Node `fetch` 禁止端口，在第29行抛出 `TypeError: fetch failed` / `cause: Error: bad port`。该测试文件独立重跑 **3/3 PASS exit0**，证明有偶发性，但不能抵消整仓FAIL。源规则与模板专项均正常，该测试设施修复超出本任务唯一授权写入范围，需要总控去重后新增独立最小P0（或依法授权现有同根因未完成任务），目标只修 `tests/multiproject-lifecycle.test.mjs` 的随机端口可靠重试/监听资源释放，之后完整R3及唯一QA。

## 真实步骤门禁和外部依赖
- 旧开发D07曾因旧测试运行器30秒超时记录BLOCK，并按总控恢复动作 `evt_df16e3fd93867d567ab101ac` 回到待开发。新正式claim成功后，尝试以新actor/Session记录D01却真实被 `CHECKPOINT_STEP_ORDER` 拒绝（旧轮次D07 BLOCK游标），未写假PASS。
- 关联独立根因 `WTB-P0-REWORK-REQUEUE-D01-STEP-ORDER-20261107-T1` 已独测PASS、远端main合并，但该根因本身因主目录未安全同步仍处于阻断：本任务协调的就是这条主目录同步链。不可拿主分支已push冒称软件运行版升级，或靠倒填断点“解锁”。
- 当前任务**正式开发中**，D01新轮次门禁FAIL保留；R3更有独立测试夹具 `ERR_UNSAFE_PORT` FAIL。必须分别修复新D01可信重入和新多项目随机端口根因并得到真正R3 PASS后才能正规交唯一独测。开发候选SHA和专项PASS不等于正式D08、QA或总控完成。

## BUG三问（仅开发候选）
1. 是否解决？已在独立候选中**完整保全原主目录规则及新发布规则**，专项两轮PASS；R3因其它测试夹具偶发 `bad port` FAIL，运行主目录仍未安全同步，不能称整体修复。
2. 会不会复现？原WIP SHA与模板同步有可重复检查，ff-only安全和独测门禁未完成，真实主目录冲突尚可能再次阻断。
3. 后续流程正常？候选开发 R1/R2 PASS，**R3 FAIL**；正式D01受原历史旧游标阻挡。独测、总控C04-C07和主目录运行版升级未完成。已有正式关联任务 `WTB-P0-REWORK-REQUEUE-D01-STEP-ORDER-20261107-T1` 因主目录C05阻断尚未完成，源任务 `WTB-P0-READY-AUTO-FLOW-NO-DISPATCH-20261106-T1`。新增外部根因 `tests/multiproject-lifecycle.test.mjs` 安全随机端口测试夹具当前无专门未完成P0编号，须总控正式创建/派工而非假造任务编号。
