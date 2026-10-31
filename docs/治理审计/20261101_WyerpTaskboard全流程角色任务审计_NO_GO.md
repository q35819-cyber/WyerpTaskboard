# WyerpTaskboard 全流程、任务与角色核验（总控 NO-GO 审计）

日期：2026-11-01
责任角色：总控 AI
审计对象：WyerpTaskboard 现存正式任务、三角色规则、工作流/依赖门禁、WebCodex Runner 执行环境、Git 交付和断点恢复。

## 一、审核结论及效力

**结论：NO-GO（暂不放行新增功能开发与 P1 开工）**。

该结论是总控的审计门禁，不是假装已经由任务看板服务端提供强制 NO-GO API。当前 P0 的正式状态仍是「开发中」，不能用手工改 registry 伪造「HOLD」或「已完成」。已通过 Session 指导现有开发者保全 worktree、停止扩大范围；该指导本身不代表开发者已经收到并执行。必须由总控核验规则冲突修正、开发范围收敛、执行环境可运行、必读材料齐全，再发布 GO。

**绝不**清理原 P0 worktree、删除原成果、停止 DSH/MediaFlow 持续运行的服务、重复创建相同测试 Job、伪造开发/独测 PASS 或绕过远端 SHA 门禁。

## 二、已检查的权威材料

- README.md（产品入口和运行说明）
- docs/产品需求/00_WyerpTaskboard核心产品需求.md（三常设角色、任务编号入口、自动适配、自动 Git 交付的产品基线）
- docs/governance/开发AI工作规范.md、测试AI工作规范.md
- docs/流程标准/开发独测Git合并闭环.md
- templates/webcodex-v1/AGENTS.md、WORKFLOW.md、DEV_PROMPT.md、TEST_PROMPT.md
- data/taskboard/task-registry.md；四个任务的 data/taskboard/plans/ 计划和 P0 最新断点
- server/candidate-evaluator.mjs、server/http-server.mjs、server/task-store.mjs（只读抽查关键门禁）
- WebCodex runtime_status、list_jobs 和 P0 工作区 Job 观察；不将队列状态当作测试通过。

**重要缺口**：当前项目根目录的 AGENTS.md 读取返回不存在；实际发现的 AGENTS.md 位于 templates/webcodex-v1/AGENTS.md。新窗口若只按「先读根目录 AGENTS.md」而无回退入口会阻断，需由总控明确根目录规则入口或受控引用，不能声称根目录文件已读取。

## 三、角色核验（有规则，但未统一落实）

| 常设角色 | 现有规则 | 必须负责 | 当前缺口 |
|---|---|---|---|
| 总控 AI | 产品级基线和 WORKFLOW.md 有描述 | 用户需求/拆解/唯一正式任务创建与分配/依赖/验收范围/超时恢复/GO-NO-GO/独测安排 | 缺独立且完整的总控执行规范和提示词入口；服务端 createTask 默认 actorType=developer_ai，缺可靠的受信任总控创建授权门禁 |
| 开发 AI | 开发AI工作规范 + DEV_PROMPT.md 已存在 | 正式认领、隔离开发、分阶段自测、固定候选 SHA、交独测；独测 PASS 后执行受控 Git 交付 | 允许开发范围扩展且 Job 反复排队；没有强制阶段断点/运行前容量自检 |
| 独立测试 AI | 测试AI工作规范 + TEST_PROMPT.md 已存在 | 不同 actor-id 和 Session、独立取得 SHA、复测、PASS/FAIL 正式事件 | 开发最终自测未过时不得提前放行独测；测试环境不可用必须报告 BLOCKED，不能误报代码 FAIL |

只有三个常设角色。需求规划归总控；Git 合并归原开发或经用户明确授权接管的开发；总复测是独测阶段，不新增第四角色。

## 四、正式任务盘点和执行顺序

| 正式任务 ID | 实际登记状态 | 任务目标与边界 | 下一责任方/准入 |
|---|---|---|---|
| WTB-P0-USER-ACCEPTANCE-SYSTEM-GATES-20261031-T1 | 开发中；原开发 Session wc_sess_9FK3DxzsPok2V38M | 只以浏览器免登录安全来源验证、acceptanceScope、系统技术验收与用户 UI/业务验收、对应回归为 P0 交付核心；禁止在此项目上继续扩建 P1 通用引擎 | **先暂停扩围**，审核结束后原开发 AI 在原 worktree 做差异复核、最终自测和独测交接 |
| WTB-P0-DELIVERY-TAKEOVER-20261031-T1 | HOLD | 用户授权的待交付异常接管、原/新身份与事件证据完整保留、独测门禁不绕过 | P0 完成 + 治理 GO 后由总控派开发 |
| WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1 | HOLD | 任务编号跨项目检索完整上下文；总控创建、分配；断点和新窗口恢复 | 两个 P0 完成并验收通过后由总控派开发 |
| WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1 | HOLD | 自动识别 Node/Python/.NET、统一状态机与适配器、结构化依赖、自动 Git 交付和故障恢复 | 先完成 P0、任务编号与依赖门禁设计核验，再拆小批次由总控逐个派开发；不得一把梭单独实现所有模块 |

第五阶段「真实项目完整验收」仅被写入 P1 的验收条款，**没有独立正式任务 ID**。不能称第五个任务已创建；应先由总控完成验收计划，再通过正式 taskctl create 建立记录并核验 TASK_NOT_FOUND → 已存在的变化。

任务 ID 是唯一执行入口。下一窗口只能据看板真实任务 ID 读取计划、断点、当前角色/状态、Git 现场和验证证据，不能自创任务。

## 五、需要先修正的流程冲突

1. **P0 / P1 边界混杂**：P0 的原计划第 43—53 行还写了通用模板、项目 onboarding、自检和两个技术栈示例；而 P1-UNIVERSAL 亦负责相同能力。此重叠是范围不断膨胀的客观风险。P0 已做的示例文件要保全，不能擅删；审查后明确哪些属于本轮最低接口契约，哪些改为 P1 后续候选，不让 P0 无限扩围。
2. **CSRF 文档冲突**：README.md 仍写动态 CSRF 校验，但 P0 正式计划第 17—28 行要求无登录浏览器不使用 CSRF Token，改用 Origin + Sec-Fetch-Site 同源约束。必须由总控统一表述，开发和独测只验证同一规范。
3. **交付接管冲突**：WORKFLOW.md 规定用户明确要求可异常接管，但开发规范/交付闭环限定待交付只能由原 actor/Session 执行；现有 claim 代码也这么限制。应由 WTB-P0-DELIVERY-TAKEOVER 单独修复状态机和安全门禁；本轮不能通过修改文档冒充功能实现。
4. **总控创建门禁尚未落实**：server/task-store.mjs 的 createTask 默认 actorType=developer_ai，且尚未强制验证只有受信任总控才有正式创建权；必须在任务编号入口任务实现可信身份门禁。不能只信 body.actorType。
5. **依赖字段误用**：server/candidate-evaluator.mjs 通过 readDependencies 中「<ID>完成」的文字解析任务依赖；它本应是只读文件依赖。还缺独立的结构化 dependsOn，以及认领/状态推进同等校验。不能把候选扫描的阻断误称为完整服务端门禁。
6. **入口与窗口治理**：开发/独测提示词存在，但总控执行规范、根目录 AGENTS.md 入口、窗口最新身份、自动阶段断点仍不齐全。
7. **Git 交付自动化尚未实现**：文档要求原开发合并、推送和远端核验，但「看板能自主触发、执行和恢复 Git 交付」未通过自动执行器与隔离远端端到端验证。不得把规范写过当作已实现。
8. **执行队列治理不完整**：开发 Job 多次排队和停止，导致检查是否实际运行缺少硬性准入与去重。应在自动适配/调度实现任务中新增 Job 生命周期状态及资源隔离验收。

## 六、关于「4 个并发槽位」的事实与推论边界

一次最新实时查询得到：runtime_status 的 job_concurrency.limit=4、running=4、queued=49；list_jobs(status=running) 显示 4 个运行中的 detached Job（DSH 3 个、MediaFlow 1 个）。P0 对应最新 npm run check / npm test / HTTP 专项 Job 均为 agent_queued，尚未开始，没有本轮退出码。

这证明**查询时刻**并发槽位占满与队列被阻，不能证明全天每一分钟均占满，更不能证明全部一天的延误都是这 4 个槽位造成。是否 persistent detached Job 不应长期消耗普通验证并发槽位，需要进一步核对 Runner 的实际调度配置/实现（目前只读数据不足以断言是错误配置或产品缺陷）。不能擅杀 DSH/MediaFlow 服务。根本改进应包含任务类型的长期运行资源隔离、每任务 Job 去重、队列时长可视化、阻断自动告警、超过阈值由总控排查，而非无止境堆积相同命令。

### 2026-11-01 用户纠正及重新核实

- 用户明确说明 DSH 和 MediaFlow 软件都没有启动。此前总控称“两项长期服务正在运行”缺少 Windows 系统进程证据，属于错误归因；必须纠正，不能再把任务拖延归责于这两个应用。
- WebCodex 再次显示 4 条 `run_detached_process` 记录为 running，且活动字段是 `runner_execution/process_running`。这只能证明 **WebCodex 的任务登记/监督层认为进程仍运行**，不是用户应用实际已启动的证据。
- 四条 Job 的观察输出为空，原执行命令/对应 PID 未从保留的操作追踪获得（trace capture off）。因此还不能在“孤儿 Job、后台子进程仍存活、执行器生命周期回收缺陷”之间下结论。
- 下一步必须由总控核验 Windows 的 PID/进程命令行与 Job 绑定关系；若 PID 已退出但仍记 running，按真实执行器机制恢复/回收这些失效任务记录。若后台仍存在，则先核实用途和依赖再决定安全停止，不能因应用窗口关闭就直接 kill。
- 此前总控重复排队测试 Job 和未及时治理阻断同样是已证实的流程管理问题，不能用并发数字来替代原因分析。


## 七、唯一正确的统一状态机与放行门禁

`总控规划/创建 → 检查依赖与身份 → 开发认领 → 分阶段实现/自测 → 绑定最终 SHA 的自测 PASS → 待独测 → 不同 Session 独测 → FAIL 回同一开发修复并重新自测/独测；PASS → 交付 → Git 同步/合并/远端 SHA 核验/合并后回归 → system 自动关闭 或 user_ui_business 等待用户 UI/业务验收`。

- 开发开始：任务真实存在、计划完整、角色匹配、未完成依赖为零、写范围和测试命令明确、独立 worktree 安全、Runner 测试可用且没有同命令重复活动 Job。
- 开发批次结束：记录阶段断点及 Git diff，及时执行定向自测。
- 自测/独测 PASS：必须有真实命令、退出码、测试数量、报告 SHA256、精确 commit SHA；旧 SHA PASS 不可复用。
- 独测 FAIL：原子退回原开发，记录问题、复现路径和下一动作；环境未执行或排队属于 BLOCKED，不是测试 FAIL。
- 交付：原开发负责、服务端核验候选 SHA 和远端 SHA、合并后回归、失败事件保留；异常接管须用户授权，不得冒用身份。
- P0 或后续任务任一关键材料缺失、规则冲突未解决、依赖未完成，均不得发布 GO。

## 八、剩余 NO-GO 项与下一步

- [ ] 根目录 `AGENTS.md`、`WORKFLOW.md` 与 `总控AI.md`、`开发AI.md`、`独立测试AI.md` 三角色入口已补齐，详细规则集中在 docs/governance 和 templates/webcodex-v1。**服务端可信总控身份/角色自动判定和权限门禁尚未通过验证**，因此本项不能全部打勾。
- [x] 已统一 README 与 P0 的**目标** CSRF/Origin 规则，明确修复未通过独测前不能声称已部署；已将 P0 限定为安全/验收+最小接入契约，生产级自动探测与自动调度归 P1，原 worktree 修改保持原样。仍须由开发/独测按新边界实际验证。
- [ ] 核对 Runner 并发调度的真实规则，制定不会影响 DSH/MediaFlow 的容量/队列恢复方案；避免以队列等待冒充开发测试。
- [ ] 对所有正式任务补齐清晰阶段目标、依赖、责任角色、验证/失败回流、断点路径和唯一下一动作；明确第五阶段缺少正式 ID。
- [ ] 由总控确认 GO/NO-GO 决定；流程未过关前不派发新的开发代码工作；P0 当前窗口只保全既有成果与事实核验。
- [ ] 对修正后的流程作一次**从创建→认领→自测→独测→交付→关闭**的隔离项目全流程验证，不允许只凭文档宣布流程已通过。

**此文件是审核发现与准入条件，不是测试 PASS 报告，不代表现有功能已修复。**

## 九、本轮审计中已完成的文档治理（不等于 GO）

- 已新增 `docs/governance/总控AI工作规范.md`，明确总控的任务创建/派发、阶段审核、异常恢复、测试/交付监督职责。
- 已新增 `templates/webcodex-v1/CONTROLLER_PROMPT.md`，使总控、开发、独测三个角色均有明确入口；仍需核对与实际服务端权限/状态机一致。
- 项目根目录 `AGENTS.md`、`WORKFLOW.md` 与三个角色入口现已补齐；详细规范仍使用原有 docs/governance 和 templates/webcodex-v1 文件，不复制规则。服务端强制角色权限门禁依然需要真实测试。
- 当前 P0 开发 Session 已收到高优先级 NO-GO 指导，但该消息不等于服务端技术强制锁定。未取得正式 GO/准入验证前，不允许据此宣称流程已经跑通。
- 本轮已实际修订 README.md 和正式 P0 计划，去除动态 CSRF 的目标规则冲突，并明确 P0/P1 的实现分界；工作区原有示例代码保留。此变更是总控文档治理，不是开发 SHA 绑定的自测 PASS。
- WebCodex runner_config_check 返回 valid=true、restart_required=false，只能说明其**配置在当前校验规则下有效**，不代表长驻 detached 进程占用普通 Job 并发槽位的调度设计已验证合理。资源隔离和去重仍是 NO-GO 项。
- 已按用户要求将三个角色的直接入口放在项目根目录，所有新窗口从根目录 AGENTS.md 和 WORKFLOW.md 进入；不新增第四角色，不变更现有未提交开发代码。

## 十、2026-11-01 旧版 WebCodex 正式异常接管与流程实测

- 用户当前明确要求找不到原开发就异常接管。旧版 WebCodex 0.4.1 的 Runner 实测 running=0、queued=0；为方便 MCP 访问只对旧版重新登记**既有本地路径映射**，不是用户重新授权，不是重建代码仓库、任务或分支。
- 原 P0 worktree 所有 dirty/untracked 成果均保留。总控生成全新的开发 Session `wc_sess_076e08fe72b24a73bdc9024c3f65a9ab`，用唯一任务编号与用户明确授权执行 `taskctl takeover`，原子接管事件 `evt_b28cf65bb69c734886c75bc5`；正式任务仍为 `开发中`，最新开发 actor-id 为 `wyerptaskboard-dev-takeover-20261101-oldwebcodex`。
- 使用同一个 Session 再执行 WebCodex `work_on_project`，实际返回 `continuation=resumed_explicitly`；没有重建分支/丢失未提交文件。接管专项 `node --test tests/takeover.test.mjs tests/taskctl-takeover.test.mjs` 实测 5/5 PASS，说明**开发中任务的用户授权异常接管环节**通过。
- **未过的两道流程门禁**：旧 worktree `work_on_project` 返回 `instructions.status=not_found`（主工作区根目录的角色入口为尚未提交文件，没有自动传播到旧 worktree）；新接管 Session 的 `taskctl guard` 返回 `preclaimReport.valid=false`，必须补齐角色规范读取与正式汇报/准入。不能以接管成功推断整套流程已通过。
- 代码质量诊断 `npm run check` 成功；HTTP 专项 43 测试中 42 PASS、1 FAIL（`tests/http-server.test.mjs:1019` 的 403/409 差异）。这是**开发修复目标**，不是正式独测 FAIL；开发自测、独测、Git 交付及自动闭环尚未验证。
- **审核结论**：只确认异常接管的已测试环节 PASS；整个流程仍 NO-GO。允许当前开发身份**在角色材料和 preclaim 准入补齐之后**仅修此 P0 的既有真实失败，不扩展功能；P1 和其他未完成依赖任务仍 HOLD。当前数据已写入该任务独立断点并登记 `takeover_flow_verified` 事件 `evt_6570dcb7c7446c39c5484ba9`。总控不得假称开发会话消息被执行或已自动产出修复代码。




## 十一、治理基线交付边界（2026-11-01）

此审计文档保留原时间点的 NO-GO 结论与历史事实。`WTB-P0-GOVERNANCE-BASELINE-DELIVERY-20261101-T1` 仅交付公开三角色入口、开发前实际读取/每步骤断点及 Git 交付规范；`docs/产品需求/`、`data/`、`reports/` 不随本候选提交。正式候选必须经开发自测、不同 Session 独测、受控合并及远端回归，完成前本审计仍为 NO-GO；即使本治理任务完成，服务端自动门禁与 P1 通用流程仍需后续独立任务实施和验收。
