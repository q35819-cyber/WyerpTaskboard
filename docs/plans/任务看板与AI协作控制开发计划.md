# 任务看板与AI协作控制开发计划

> WyerpTaskboard 本地权威副本
> 本计划现迁入任务看板独立目录，作为WyerpTaskboard自身主计划；erp-x20中的旧副本只保留历史溯源。


> 建立日期：2026-09-28  
> 任务编号：**WTB-WAKE-001**（历史来源：B-10 / B-10-AUTO）  
> 历史功能编号：**F-022**  
> 当前定位：**独立本地项目治理服务 / `track=infrastructure` / 第一阶段 P0；P0表示基础设施轨道内最高优先级，不高于产品主线 `track=product` 的P0，也不是公网业务硬门禁。**  
> 独立安装目录：**`D:\WyerpTaskboard`**（不得放入 `D:\跨境电商\erp-x20`、`erp/` 或其它ERP业务源码目录）。  
> 独立监听：**`127.0.0.1:47831`**，默认访问 `http://127.0.0.1:47831`；端口可配置，但不得复用ERP `8765`。  
> 当前状态：**`WTB-WAKE-001` 超时断点续跑批次开发完成：WyerpTaskboard软件0.6.13、Chat Wake扩展0.6.15。除既有processing_delayed与MCP恢复外，本轮补齐`execution_error`常驻恢复和执行中断点持久化：异常持续1.5秒后二次确认，优先当前会话“重试”，无重试入口再发“继续”；active candidate持久化到Chrome local storage，Service Worker重启后恢复同一task/detection并继续，不再因后台回收丢失执行上下文。正式/healthz=0.6.13，manifest/expected/runtime=0.6.15，dispatcher/UI heartbeat fresh；定向34/34、check与完整32文件回归均0失败。仍需独立真人制造一次0.6.15后的真实超时，确认原task/detection续跑。用户硬约束不变：只允许普通聊天模式，禁止ChatGPT Work。**  
> 当前数据源：**仅 `D:\WyerpTaskboard\待办任务总清单.md`（自管理模式）**；外部项目接入暂时停用。  
> 补充证据源：各项目的 `任务执行与资源占用台账.md`、`任务进度断点/<任务ID>.md`、`测试报告/<任务ID>/`。  
> 重要边界：本看板管理“AI开发/修改/测试/独测/用户审阅”协作任务，**自身进程、端口、配置、日志和事件数据全部独立于ERP**；ERP重启/停止/迁移不得影响看板可用性。

## 1. 用户目标

用户需要通过**独立任务看板服务**直接看到任务执行状况，不再依赖反复询问AI。当前阶段先启用**自管理模式**：只管理 WyerpTaskboard 自身，暂不接外部项目；多项目接入能力保留但不启用。

第一版必须支持：

1. 通过项目配置的 **adapter + workflowProfile** 读取该项目任务注册表中的任务、优先级、状态、角色、当前负责人、依赖和计划入口；
2. 状态、优先级、角色、合法流转和看板列由项目 `workflowProfile` 定义；`erp-x20` 第一版使用 `wyerp-ai-flow-v1`，其中才包含待开发、开发中、待独测、独测中、待复测、复测中、待用户验收、阻断、HOLD、完成及P0/P1/P2；核心服务不得把这套ERP语义硬编码成所有项目的唯一模型；
3. **任何开发AI发生实际修改后必须回写；任何测试、独测、复测发生后也必须回写；**
4. 用户可以填写审阅意见；
5. 用户可以明确“通过 / 打回 / 暂停”；
6. 被打回任务重新进入可认领队列，后续开发AI或独立测试AI按状态认领；
7. 用户可以调整任务优先级；
8. 用户可以停止或重新启动任务；
9. 执行中的任务必须展示**会话窗口名称**，并保留技术会话/尝试ID，便于快速定位；
10. 支持筛选、排序、状态分组和快速查看计划/断点/报告；
11. 页面刷新后状态不丢失；
12. 页面与AI并发更新不能互相覆盖。

### 1.1 2026-09-28 用户追加的第一版可用性要求

以下属于B-10正式需求，不作为聊天临时意见处理：

1. **任务必须绑定主计划文档。** 任务注册表必须有独立、机器可读的“主计划”字段；看板不得再从“目标位置/报告路径”猜计划。一个任务允许关联一个或多个计划，但必须明确第一主计划。
2. **主界面保持横向进度排班，不按计划拆成多个大块。** 用户首先要一眼看到任务当前处于哪个进度列；主计划作为任务卡标签、筛选条件和详情入口显示，不能破坏横向进度视图。
3. **计划必须可以从任务看板直接打开核对。** 为避免任意文件读取，页面只能按 `projectId + taskId + planIndex` 打开该任务已经登记的计划，服务端从任务注册表反查相对路径并做项目root真实路径校验；不提供任意绝对路径读取接口。
4. **看板每个状态列一页最多显示3个任务。** 超过3个时在该列内部独立分页，显示“上一页 / 第N页·共M页 / 下一页”；筛选或计划切换后页码必须自动收敛到有效范围。
5. **用户可见区域除ID/必要产品名与技术标识外必须中文。** track、状态、按钮、事件类型、健康状态、空态、提示、弹窗标题等不得裸露 `product / infrastructure / source_unavailable / HOLD / LOCAL PROJECT / INDEPENDENT PROJECT GOVERNANCE` 等英文。底层事件码、workflowProfile、adapter等若确需展示，必须明确标成“ID/内部标识”，不能当用户文案。
6. **用户反馈必须先分类再落档。** 现有需求未按计划实现、回归后失效或已有规则被违反，归“BUG/缺陷”，写入对应专项计划的当前边界并在 `报错记录.md` 留问题/根因/修复/验证；用户新增能力或改变既定行为，归“新需求”，写入对应专项开发计划；证据不足归测试报告/断点，业务规则需要重新决定归对应计划的决策章节。不得因为最方便就随便找一个文档追加。
7. **用户留言不是唯一持久化位置。** 看板event保存原话和审阅历史；凡留言实质改变需求、发现缺陷或形成长期规则，执行AI还必须同步到上述对应权威文档，并在事件中记录落档位置。
8. **用户留言区放在“历史事件”前，而不是任务详情最顶部。** 每条 `user_review` 以红色问题卡显示；AI通过 `user_message_reply` 显式绑定原留言，并在问题卡内直接展示回复，同时提供“定位历史回复/定位原问题”。`user_accept`、`user_reject` 是审阅决策，不得再伪装成普通“用户留言”；通过应显示状态变化，打回应显示打回后的目标状态。
9. **新增“需求入口”。** 用户可以在看板直接提交新需求；需求先进入独立“待AI拆解”队列。合规AI读取后需要判断现有模块/计划：已有模块则把需求和拆解任务写入现有专项计划；没有对应模块则先建立新的专项开发计划，再写入拆解任务；所有正式任务最终进入项目任务总清单并填写“主计划”字段，看板轮询后自动读取。AI对需求存在问题时可直接在需求线程回复用户。第一版属于 cooperative AI intake：没有正在运行/被调度的合规AI时只保证需求可靠排队，不得宣传为后台Runner已实现无人值守LLM自动拆解。
10. **用户留言/新需求是当前任务最高优先级治理输入。** 每完成一个小功能、进入空闲、继续下一轮写入或开始测试前，都必须先读取 guard；发现未读用户留言或待拆新需求时，先处理/回复并回写确认，再继续原任务。一个AI的已读/回复不能代替独立测试AI自己的读取。

### 1.2 B-10 用户需求与问题追踪表

> 本表用于把聊天/看板中的长期有效输入落到权威计划，不以events替代正式文档。状态“已实现”仅表示开发方代码/文档已落地，不代表独测或用户验收通过。

| 编号 | 用户要求 / 问题 | 分类 | 当前状态 | 对应任务/权威位置 | 关键文件 / 溯源 |
| --- | --- | --- | --- | --- | --- |
| B10-UR-01 | 看板独立于ERP项目、独立端口，ERP与看板互相重启不影响 | 架构需求 | 已实现，待独测 | B-10 / 本计划 §2、§3、R3/R7 | `D:\WyerpTaskboard\server\service-control.mjs`；`tests/service-independence.test.mjs`；`tests/service-control.test.mjs` |
| B10-UR-02 | 多项目不能只做路径映射，要有adapter/workflowProfile/registryFormatVersion和track | 架构需求 | 已实现，待独测 | B-10 / 本计划 R1 | `server/project-registry.mjs`；`server/adapters/markdown-task-registry-v1.mjs`；`server/workflows/wyerp-ai-flow-v1.mjs` |
| B10-UR-03 | 每次修改、测试、独测都必须回写状态/事件，会话窗口可定位 | 核心需求 | 已实现，待独测 | B-10 / R5 | `cli/taskctl.mjs`；`server/http-server.mjs`；`AI协作与任务流转规范.md` |
| B10-UR-04 | 用户可留言、通过/打回、改优先级、停止/恢复任务 | 核心需求 | 已实现，待独测 | B-10 / R6 | `web/app.js`；`server/http-server.mjs`；`server/task-store.mjs` |
| B10-UR-05 | 疑似失联不能按时间直接接管；能恢复原session先恢复，异常接管需显式授权 | 治理规则 | 已实现，待独测 | B-10 / §9.2.1 | `server/takeover.mjs`；`tests/takeover.test.mjs`；`tests/taskctl-takeover.test.mjs` |
| B10-UR-06 | 看板要能填写本机项目路径添加项目；健康状态不能误报source_unavailable | 功能+BUG | 已修复，待独测 | B-10 / CP-006；`报错记录.md` | `server/project-registry.mjs`；`web/index.html`；`web/app.js` |
| B10-UR-07 | 任务文案要说清负责什么；无需用户操作时不要占最外层空间 | 交互需求 | 已实现，待独测 | B-10 / §1.1 | `server/task-store.mjs` presentation；`web/app.js` taskCard/openTask |
| B10-UR-08 | 用户留言红色显示，且用户留言/新需求是当前任务最高优先级 | 治理+交互 | 已实现，待独测 | B-10 / §1.1、协作规范 | `web/styles.css`；`cli/taskctl.mjs` guard/ack-user；`server/task-store.mjs` |
| B10-UR-09 | 用户问题下面要关联AI回复，并能快速定位AI回复/原问题 | 交互需求 | 已实现，待独测 | B-10 / §1.1 | `server/task-store.mjs` userMessageState；`server/http-server.mjs` reply-user-message；`web/app.js` |
| B10-UR-10 | “通过认可/打回”不能显示成普通用户留言，要能看出状态是否回写 | BUG | 已修复，待独测 | B-10 / §1.1；`报错记录.md` | `web/app.js` history；`tests/http-server.test.mjs` user_accept |
| B10-UR-11 | 任务必须绑定主计划，用户遇到问题能直接打开计划核对 | 原计划漏实现BUG | 已修复，待独测 | B-10 / §1.1；`报错记录.md` | `待办任务总清单.md`主计划列；`server/task-store.mjs`；`web/app.js` |
| B10-UR-12 | 主界面保持直接横向排班；每列最多3项，超出列内分页 | 交互需求 | 已实现，待独测 | B-10 / §1.1 | `web/app.js` renderBoard/PAGE_SIZE；`tests/web-ui-contract.test.mjs` |
| B10-UR-13 | 用户使用区域除ID/必要技术标识外必须中文 | 既有规范BUG | 已修复，待独测 | B-10 / §1.1；`页面布局与交互规范.md`；`报错记录.md` | `web/index.html`；`web/app.js`；`tests/web-ui-contract.test.mjs` |
| B10-UR-14 | 用户反馈要先判断新需求/BUG/证据/决策，再写正确文档，不能读过就算 | 治理规则 | 已实现为长期规则 | B-10 / §1.1；`AI协作与任务流转规范.md` §6.1.1 | `AGENTS.md`；开发/测试AI规范；`报错记录.md` |
| B10-UR-15 | 新增需求入口；已有模块写现有计划，无模块建新计划，正式任务自动被看板读取 | 新需求 | **协作式实现**；待独测 | B-10 / §1.1 第9项 | `server/requirement-store.mjs`；`server/http-server.mjs`；`cli/taskctl.mjs`；`web/app.js` |
| B10-UR-16 | 拆解任务必须明确关键文件/溯源文件，方便排查和纠偏 | 新需求 | 已实现，待独测 | B-10 / 任务注册表v1 | `待办任务总清单.md`关键文件/溯源列；`server/adapters/markdown-task-registry-v1.mjs`；`server/requirement-store.mjs` |
| B10-UR-17 | 用户对话中的需求/BUG/规则，已完成和未完成都要落正式文档 | 治理规则 | 已落本追踪表；后续持续维护 | B-10 / 本表 | 本计划；`报错记录.md`；任务断点/测试报告 |
| B10-UR-18 | 计划、任务断点、测试报告能从详情直接打开核对 | 原计划需求 | 已实现，待独测 | B-10 / R4 | `server/task-store.mjs` readTaskPlan/readTaskDocument；`web/app.js` openPlan/openDocument |
| B10-UR-19 | AI应有release，任务移交后清理负责人/会话占用 | 原计划需求 | 已实现，待独测 | B-10 / R5 | `cli/taskctl.mjs` release；`server/http-server.mjs` /release；`tests/taskctl.test.mjs` |
| B10-UR-20 | 提供桌面/开始菜单快捷方式，同时不能影响ERP服务 | 原计划需求 | 已实现脚本，待独测 | B-10 / R4 | `scripts/install-shortcuts.ps1`；`scripts/remove-shortcuts.ps1`；`tests/shortcut.test.mjs` |
| B10-UR-21 | 完成任务不要淹没当前排班，要能筛选进行中/全部/已完成已取消 | 原计划需求 | 已实现，待独测 | B-10 / R4、参考模型 | `web/index.html` archiveFilter；`web/app.js` applyFilters |
| B10-UR-22 | “自动拆解”不能虚假宣传：无AI运行时可靠排队，有合规AI时优先拆解 | 能力边界 | 协作式实现；Runner无人值守不在第一版 | B-10 / §1.1 第9项、§9.2.1 | `server/requirement-store.mjs`；`cli/taskctl.mjs` preflight；Runner/WebCodex为未来hard enforcement依赖 |
| B10-UR-23 | 独立test_ai读取并确认用户留言后仍应能合法认领；开发AI与测试AI的已读scope必须隔离且各自可完成确认 | 独测发现BUG | **已修复，待复测（BUG-B10-001）**：`ack-user`未显式传actor-type时现按任务阶段自动推导test_ai；help公开actor-type；开发方测试已验证ack→同scope guard→claim成功 | B-10 / R5、§10.3、§17；`报错记录.md`；`测试报告/B-10/20260929-022510-独测-TEST-B10-001.md` | `D:\WyerpTaskboard\cli\taskctl.mjs`；`D:\WyerpTaskboard\tests\taskctl.test.mjs`；`D:\WyerpTaskboard\server\http-server.mjs` |
| B10-UR-24 | 用户留言区每页只显示3条；超过3条分页；留言正文字号按“输入审阅意见”文本框调整 | 新增交互需求/用户最新口径 | **已实现，待复测**：最新口径为16px，取代此前“与历史事件12px一致”的字号要求 | B-10 / §1.1 用户留言区 | `D:\WyerpTaskboard\web\app.js`；`D:\WyerpTaskboard\web\styles.css`；`D:\WyerpTaskboard\tests\web-ui-contract.test.mjs` |
| B10-UR-25 | 本机每10分钟扫描全部项目任务；检测结果必须被ChatGPT识别，满足条件时由ChatGPT复核后自动认领；后续在存在受支持触发通道时实现“检测到即可触发ChatGPT”，不得把本机日志冒充AI认领或虚假宣传已能唤醒当前聊天 | 新需求 / 自动化治理 | **L1/L2已实现并完成非浏览器独测；调度语义由B10-UR-27继续收口** | B-10-AUTO / 本计划 §10.4、R8 | `D:\WyerpTaskboard\cli\task-scan.mjs`；`server\scan-store.mjs`；`server\candidate-evaluator.mjs`；`scripts\install-task-scan-schedule.ps1`；`scripts\remove-task-scan-schedule.ps1`；`data\runtime\task-scan\` |
| B10-UR-26 | 待测试阶段允许用户直接打回：待独测/待复测无需先由测试AI认领；按打回原因进入缺陷修复/待准备/待确认/HOLD，并同步计划角色 | 新增流程需求 | **已实现，待复测** | B-10 / workflowProfile用户审阅 | `D:\WyerpTaskboard\server\workflows\wyerp-ai-flow-v1.mjs`；`D:\WyerpTaskboard\server\http-server.mjs`；`D:\WyerpTaskboard\tests\http-server.test.mjs` |
| B10-UR-27 | 测试任务结束后同一独立测试角色立即继续扫描并认领下一项可执行测试任务；若当前没有可执行测试任务但仍存在未闭环开发任务，则本机保留10分钟巡检；若测试与开发任务都不存在，则停止周期巡检并进入空闲休眠，后续由任务/需求/状态写入、服务启动或手动扫描重新唤醒一次检查；测试AI不得因此切换身份认领开发任务 | 用户最新业务决策 / 自适应巡检 | **已实现，待独测**：`test_chain / developer_watch / idle_suspended / re-arm`已接通；受控写入与服务启动可立即one-shot，只有developer_watch保留10分钟完整扫描，idle/test_chain的scheduled均不周期读取项目registry；最终组合48/48通过，正式test_chain与re-arm即时调度已做真实验证。 | B-10-AUTO / §10.4.4、§10.4.7、R8 | 目标：`task-scanner.mjs`、`scan-store.mjs`、Windows调度脚本、taskctl/UI写入后的re-arm标记与对应测试 |
| B10-UR-28 | 开发候选/待认领展示必须区分阶段；开发AI正式认领只允许待开发/测试失败待修复，待准备只能无副作用准备；关联文件必须区分只读依赖与计划写文件/最小写文件组 | 多AI协作治理 | **已实现，待独测**：注册表adapter支持“只读依赖/计划写文件”；ERP真实机器注册表23条任务已完成列迁移，待准备任务不猜写范围，只有当前范围明确的B-10/B-10-AUTO登记写文件；候选输出两类字段并执行写冲突门禁；任务详情独立展示两类文件。live B-10详情返回真实readDependencies/writeTargets，专项15/15通过。 | B-10 / 候选生成与任务详情 | `待办任务总清单.md`；`D:\WyerpTaskboard\server\adapters\markdown-task-registry-v1.mjs`；`server\candidate-evaluator.mjs`；`web\index.html`；`web\app.js`；对应测试 |
| B10-UR-29 | 开发“待认领”候选一次最多展示3项；异常/阻断/暂停信息优先可见，但多次失败且仍处阻断的任务不得进入可认领候选；候选进入前必须排除与开发中任务计划写文件冲突的任务 | 新需求 / 调度治理 | **已实现，待独测**：写文件冲突/缺写文件组门禁、最多3条展示和异常任务排除均已实现；live发现旧registry revision候选会残留并与新候选重复，已补 `scan-store` 最新成功扫描对同任务旧候选标 `superseded`、本次不再检测的任务标 `not_detected_in_latest_scan`，扫描失败不误清历史候选。专项10/10通过，live活动候选18条、developerCandidates 6条、重复taskId=0。 | B-10 / B-10-AUTO候选规则 | `D:\WyerpTaskboard\server\candidate-evaluator.mjs`；`server\scan-store.mjs`；`server\http-server.mjs`；`web\index.html`；`web\app.js`；`web\styles.css`；对应测试 |
| B10-UR-30 | 用户新增项目路径时先校验项目是否满足看板适配格式；不满足要明确提示并进入“请求自动适配”流程，适配完成后才正常展示 | 新需求 / 项目接入 | **已实现，待独测**：不兼容项目保留路径并登记 `adaptation_required`；页面显示“自动适配当前项目”，由本机管理员确认后执行；适配保留原任务清单原文，只追加机器注册区、创建必要目录/治理计划，成功后清除待适配状态并恢复healthy。端到端6/6、联合32/32、全量19文件0失败通过。 | B-10 / 项目添加与adapter | `D:\WyerpTaskboard\server\project-registry.mjs`；`server\http-server.mjs`；`web\index.html`；`web\app.js`；对应测试 |
| B10-UR-31 | 对已经完成但没有写专项计划/主计划的功能，任务看板应生成最高优先级的“补计划/补治理文档”任务，不允许静默忽略 | 新需求 / 文档治理 | **已实现，待独测**：自动适配时创建 `BOARD-PLAN-AUDIT-001`（infrastructure/P0/待开发/开发AI），并生成 `任务看板适配与计划补全计划.md`；要求审计“已实现功能→主/专项计划→关键文件”，已有模块优先补入原计划，无模块再建专项计划，且只补治理文档不擅改业务实现状态。端到端及全量回归通过。 | B-10 / 项目接入健康检查 | `D:\WyerpTaskboard\server\project-registry.mjs`；新项目 `任务看板适配与计划补全计划.md` / `待办任务总清单.md` |
| B10-UR-32 | 已经实现的用户留言/需求必须回写“已实现/部分实现”，并明确列出实际包含的功能、验证证据与尚未完成部分，方便后续核实；不得长期保留“待开发/处理中”造成状态失真 | 用户最新治理要求 | **已纳入治理规则并从本轮开始执行**：UR28～30已按实际完成范围回写，未完成部分继续保留；后续每个小功能完成时同步追踪表、断点和看板回复 | B-10 / 用户需求追踪与交付记录 | 本计划；`任务进度断点/B-10.md`；taskboard `user_message_reply` / `code_change` / `test_result` |
| B10-UR-33 | 测试AI自行产生的临时服务/进程/端口/夹具在测试失败或阻断后不要立即清掉，先保留给开发AI查看/复现；但必须安全登记并在开发确认后清理，存在冲突/孤儿/凭据/外部写风险时先留证再立即清理 | 用户最新治理要求 / 测试现场生命周期 | **已实现，待独测**：taskctl新增 `resource-preserve/resource-observe/resource-clean`；保留事件登记资源ID、类型、定位、用途、创建者/session、接手者、清理条件/期限、证据与安全状态；开发可登记已查看/已复现/不再需要，清理后闭环；任务详情API/UI展示活动临时资源、陈旧提醒和安全清理提醒，但不会自动误杀进程。专项20/20、check及live接口/命令验证通过。 | B-10 / 测试资源移交与清理 | `D:\WyerpTaskboard\server\task-store.mjs`；`server\http-server.mjs`；`cli\taskctl.mjs`；`web\index.html`；`web\app.js`；`web\styles.css`；对应测试 |
| B10-UR-34 | 为整个Wyerp任务看板提供即时唤醒，但**只允许普通聊天模式执行，禁止ChatGPT Work执行任务**；任何桥只传最小候选引用，绝不自动上传其它项目源码、文档、测试报告正文、用户留言正文、日志全文或凭据 | 用户最新治理要求 / 即时唤醒 / chat-only | **0.6.15开发完成，待独立核心复测**：保留SSE、角色路由、lease/ACK、长回复持续重试、`dispatcher_epoch`、UI heartbeat、read-before-act与同会话恢复；过期扩展可自reload并向已有ChatGPT tab重注入；0.6.15新增active candidate执行中断点持久化和Service Worker重启恢复，超时/执行错误不得静默丢失原任务。正式claim前仍必须WebCodex recheck/guard/资源/角色核对；GitHub→Work保持停用。 | WTB-WAKE-001 / L3全看板聊天触发 | `browser-extension/chat-wake/background.js`；`browser-extension/chat-wake/content.js`；`browser-extension/chat-wake/manifest.json`；`config/chat-browser-wake.json`；`tests/chat-browser-wake.test.mjs`；`tests/version-contract.test.mjs`；`报错记录.md`；本计划 §10.4.8、R8 |
| B10-UR-35 | 独立测试真实长回复时，ChatGPT 已显示系统“进一步处理”状态并持续十多秒，但扩展没有在3秒确认后执行同会话“停止→继续” | BUG / 现有缺陷 / P0 | **BUG-WTB-WAKE-001-011-01 已在扩展0.6.12修复，待独立复测**：根因是 `uiExecutionState()` 仅扫描 alert/aria-live/error 语义节点，真实 processing banner 未进入这些节点，随后被停止按钮降级成普通 `generating`；修复后在当前最后一轮 assistant turn 内识别 status/secondary/processing/图标提示的小型状态块，并增加真实DOM行为夹具证明能判为 `processing_delayed`，同时证明普通正文提到相同文案仍保持 `generating`。 | WTB-WAKE-001 / T04/T10/T08 受影响范围 | `browser-extension/chat-wake/content.js`；`tests/chat-browser-wake.test.mjs`；`任务进度断点/WTB-WAKE-001.md`；`测试报告/WTB-WAKE-001/20260929-0.6.12-processing-delayed-开发修复.md` |
| B10-UR-36 | 项目核心功能必须先自测：GPT异常不仅要识别，还要能通过页面/MCP/看板恢复；任务变为可执行后正常stable路径应在10秒内完成自动扫描并被正确角色接到；核心自测不通先修，不能先整理成通过式测试需求 | 用户最新核心验收要求 / P0 | **BUG-WTB-WAKE-001-CORE-02 已开发修复，待独立现场**：真实re-arm→candidate三次约2.52～2.80秒；健康监控新增具体reason、MCP安全恢复、candidate stall re-arm和post-check；正常generating禁止误刷新；扩展0.6.14支持无刷新重载恢复。当前正式runtime/heartbeat/health已恢复正常。尚未冒充通过的是stable页面T0 eligible→T4 ACK<=10秒，必须独立现场计时。 | WTB-WAKE-001 / 项目级核心测试P0-A/P0-B | `docs/项目级核心功能测试需求.md`；`server/chatgpt-health-monitor.mjs`；`browser-extension/chat-wake/background.js`；`tests/chatgpt-health-monitor.test.mjs`；`测试报告/WTB-WAKE-001/20260929-0.6.14-核心恢复与自动接任务-开发修复.md` |
| B10-UR-37 | ChatGPT执行中发生超时/报错或Manifest V3 Service Worker被回收时，必须有执行中断点；不得只报错后丢任务。恢复后必须继续同一task/detection，并记录恢复动作和结果 | 用户现场缺陷 / P0 | **BUG-WTB-WAKE-001-CORE-03 已在软件0.6.13/扩展0.6.15修复，待独立真人复测**：新增`retry_or_continue`页面恢复；active candidate持久化到`wyerpExecutionCheckpoints`，Service Worker整体重启后恢复同一task/detection；成功role session bound或tab关闭后才清理。行为测试覆盖真实execution_error重试与worker重启续跑；定向34/34、完整32文件0失败。 | WTB-WAKE-001 / 项目级核心测试P0-A | `browser-extension/chat-wake/content.js`；`browser-extension/chat-wake/background.js`；`server/chat-browser-wake.mjs`；`tests/chat-browser-wake.test.mjs`；`测试报告/WTB-WAKE-001/20260929-0.6.15-超时断点续跑-开发修复.md` |
| B10-UR-38 | 自动化当前状态必须在全局可见，不能只靠浏览器页面；普通桌面、普通应用和浏览器均可查看，允许最小化到Windows通知区域/系统托盘 | 新需求 / 全局可观测性 | **启动与只读展示现场通过，GPT审批行为待复测**：正式0.6.29；总控制台由独立Windows任务按需常驻，topmost/拖动/托盘/启动暂停/无人值守/审批UI均已显示；NO-OP审批入口已移除，审批框明确为“待确认 ChatGPT 操作”；PowerShell Parser守卫、401与summary超时修复均在位；全量36文件0失败/package_version=0.6.29 | WTB-SENTINEL-001 / `docs/plans/全局状态哨兵与人工接管开发计划.md` | `scripts/global-status-overlay.ps1`；`server/automation-control.mjs`；`server/windows-mcp-client.mjs`；`server/chatgpt-health-monitor.mjs`；`测试报告/WTB-SENTINEL-001/20260930-0.6.29-ChatGPT专属授权范围修复-开发验证.md` |
| B10-UR-39 | 全局哨兵必须识别人工鼠标/键盘操作；检测到人工操作后自动化立即暂停，且不能自动恢复，只能用户手动恢复 | 新需求 / 人工接管硬门禁 | **Hook启动现场正常，行为待复测**：控制台已显示InputHook OK；低级WH_KEYBOARD_LL/WH_MOUSE_LL读取LLKHF/LLMHF_INJECTED；non-injected触发USER_TAKEOVER；Windows-MCP获准动作创建短时input lease；未知injected fail-closed；控制台自身按钮有短时排除窗。下一步由用户在运行态移动鼠标/按键验证即时接管 | WTB-SENTINEL-001 / 人工接管状态机 | `server/automation-control.mjs`；`scripts/global-status-overlay.ps1`；`server/windows-mcp-client.mjs`；对应测试 |
| B10-UR-40 | AI协助第一守则：先检查前提/逻辑/缺失信息；不迎合、区分事实与推测；关键数字核实来源；有异议给依据和替代方案；提醒变量/成本/风险；复杂需求先拆分和写计划 | 治理规则 | **已落权威治理文档**；后续所有开发/测试角色开工前必读 | 项目治理 | `docs/governance/AI协助第一守则.md`；`AGENTS.md`；开发/测试AI规范 |
| B10-UR-41 | 当前生产测试阶段异常处理宁可慢：系统先自动诊断并说明判断/依据/建议动作；**只有实际改变ChatGPT页面/会话状态的动作需要用户授权**；代码、文档、测试、服务、截图、诊断、普通MCP不授权。刷新不是普通恢复动作，只能在明确异常且浏览器自身恢复耗尽后作为最后手段。用户必须随时能暂停，禁止无限刷新 | P0生产测试安全规则 | **0.6.30已按用户口径固化**：Windows MCP仅approvalScope=chatgpt审批；stale/候选卡住/composer missing只诊断不刷新；execution_error/processing_delayed/generating_stalled先走浏览器retry/continue，只有recovery.status=exhausted且证据新鲜才允许提出刷新授权。全量36文件0失败/package_version=0.6.30。Chat Wake、健康与扫描自动链当前继续安全停用 | WTB-WAKE-001 / WTB-SENTINEL-001 | `server/chatgpt-health-monitor.mjs`；`server/windows-mcp-client.mjs`；`browser-extension/chat-wake/content.js`；`scripts/global-status-overlay.ps1`；`测试报告/WTB-SENTINEL-001/20260930-0.6.30-GPT刷新最后手段-开发验证.md` |
| B10-UR-42 | ChatGPT出现 `ChatGPT stream recovery polling timed out` 时必须被明确识别为执行异常并进入受控恢复；同时用户聊天正文里出现同一句不能误报 | 用户现场缺陷 / P0 | **扩展0.6.24已修复，待真人复测**：新增顶层toast/notification/open/dialog系统错误面识别，排除conversation/message/composer/code；明确覆盖stream recovery polling timeout并归类`execution_error`，沿用`retry_or_continue`与总控审批。新增正反行为测试，chat-browser-wake 22/22；完整36文件0失败。Chat Wake仍关闭，浏览器实际0.6.24未核实 | WTB-WAKE-001 / GPT异常识别与恢复 | `browser-extension/chat-wake/content.js`；`tests/chat-browser-wake.test.mjs`；`browser-extension/chat-wake/manifest.json`；`config/chat-browser-wake.json`；`报错记录.md` CORE-06；`测试报告/WTB-WAKE-001/20260930-0.6.24-stream-recovery-timeout-开发修复.md` |
| B10-UR-43 | 所有会改变GPT状态的操作统一由Windows MCP执行；浏览器扩展和截图仅监控/取证，不得直接点击、输入、发送、导航、恢复或刷新 | 用户确认 / P0执行器硬边界 | **扩展侧硬边界已在0.6.34落地，服务端控制决策继续收口**：content/background不再访问`/mcp-action`，扩展启动只保留版本握手、状态识别、UI heartbeat、只读探针/取证；不再启动SSE候选控制链或扩展内异常恢复。所有GPT状态改变继续统一由`ChatgptMcpExecutor → Windows MCP`执行。历史dispatcher/恢复代码只作为迁移遗留，不得作为当前扩展职责真值；后续继续将候选发送/恢复触发决策彻底迁到服务端统一控制器。 | WTB-WAKE-001 / WTB-SENTINEL-001 | `server/chatgpt-mcp-executor.mjs`；`server/windows-mcp-client.mjs`；`server/http-server.mjs`；`browser-extension/chat-wake/background.js`；`browser-extension/chat-wake/content.js`；`tests/chat-browser-wake.test.mjs` |
| B10-UR-44 | 人工键鼠接管只暂停交互自动化，不得停止已在运行的代码/测试/后台任务；接管时自动取消无人值守；GPT动作必须有单trace流程日志且同动作不得重复授权 | 用户确认 / P0接管与审计硬边界 | **0.6.33已实现并进入正式服务，待现场行为复测**：`USER_TAKEOVER`改为`interactive_input_only`且`unattended=false`；后台工程任务保留；新增`in_flight_action`防重复审批、`events.jsonl`全链路事件、`platform_safety`分类及60秒安全阻止重试抑制；控制台新增`Flow:`显示。定向12/12+8/8+5/5，全量38文件0失败/188759ms/package_version=0.6.33 | WTB-SENTINEL-001 | `server/automation-control.mjs`；`server/chatgpt-mcp-executor.mjs`；`scripts/global-status-overlay.ps1`；`data/runtime/automation-control/events.jsonl`；`测试报告/WTB-SENTINEL-001/20260930-0.6.33-人工接管作用域与流程日志-开发验证.md` |
| B10-UR-45 | 所有关键异常必须有持久化日志，并提供统一总日志串联服务、扫描、Chat Wake、MCP、总控、健康监控、事务和测试 | 用户确认 / P0可观测性硬边界 | **0.6.34已实现、全量通过并部署正式服务**：按天`data/runtime/system-events/YYYY-MM-DD.jsonl`统一总日志；专项日志继续保留；service/HTTP/task-scan/Chat Wake扩展与服务端/Windows MCP/GPT MCP/health/overlay/事务/CLI/validation均接总日志；扩展上传失败有chrome.storage fallback；API `/api/runtime/events`和Runtime Status最近异常摘要已提供；生产源码未标注静默catch守卫已加入。logging-coverage 4/4、system-event-log 3/3、service-control 9/9、全量40文件0失败/224260ms/package_version=0.6.34；正式日志文件已现场生成 | WTB-SENTINEL-001 / WTB-WAKE-001 | `docs/governance/日志与异常审计规范.md`；`docs/plans/统一运行日志与异常审计开发计划.md`；`server/system-event-log.mjs`；`tests/logging-coverage.test.mjs`；`测试报告/WTB-SENTINEL-001/20260930-0.6.34-统一运行日志与异常审计-开发验证.md` |
| B10-UR-46 | 任务看板默认必须显示全部任务，不得默认只显示“进行中任务”；用户仍可主动切换进行中/全部/已完成已取消 | 用户最新交互需求 | 待实现 | WTB-WAKE-001 / 看板默认筛选 | `web/index.html`；`web/app.js`；`tests/web-ui-contract.test.mjs`；`docs/governance/页面布局与交互规范.md` |
| B10-UR-47 | 看板列压缩：待开发与待测试合并为同一列；开发中/修复中/交付中与独测中/复测中合并为同一“执行中”列；待交付与待用户验收合并为同一列；必须保留完成列可见 | 用户最新交互需求 | 待实现 | WTB-WAKE-001 / workflow看板布局 | `server/workflows/wyerp-ai-flow-v1.mjs`；`web/app.js`；`tests/http-server.test.mjs`；`tests/web-ui-contract.test.mjs`；`docs/governance/页面布局与交互规范.md` |
| B10-UR-48 | 中国软件的总控制台与用户界面必须中文化且保证文字可读；总控制台优先整合服务控制/全局自动化控制，避免两个可见控制台占用桌面 | 用户最新交互需求 / P0可观测性 | 待实现 | WTB-SENTINEL-001 | `docs/plans/全局状态哨兵与人工接管开发计划.md`；`scripts/global-status-overlay.ps1`；`cli/service.mjs`；`tests/global-status-overlay.test.mjs` |
| B10-UR-49 | 独测/复测通过后不得一律把任务重新交给开发AI。先判定是否存在独测后才需执行的真实交付动作：有动作才进入待交付；无动作且需人工确认则直接待用户验收；只有用户明确授权的低风险任务才可技术通过后自动闭环。待交付阶段禁止继续开发新功能或制造空交付 | 用户最新治理决策 / 交付状态机 | **0.6.53 开发完成，待独测**：workflow 支持三种通过去向；真实交付动作采用白名单且不能为空；空待交付不再生成开发候选；用户可在任务详情授权/撤销低风险自动闭环；交付中代码或显式语义变更会使旧测试证据失效并回待复测。npm run check PASS，定向核心 65/65、UI 12/12、全量 43 文件 0 失败。正式 47831 服务本轮未切换，运行版本待独测后按真实交付必要性处理 | WTB-DELIVERY-001 / 独测后交付必要性判定 | server/workflows/wyerp-ai-flow-v1.mjs；server/candidate-evaluator.mjs；server/task-store.mjs；server/http-server.mjs；cli/taskctl.mjs；web/index.html；web/app.js；tests/http-server.test.mjs；tests/task-scan.test.mjs；tests/taskctl.test.mjs；tests/unattended-core.test.mjs；tests/web-ui-contract.test.mjs |
| B10-UR-50 | 开发/测试/审计执行中发现新的独立真实问题时，不能只汇报，必须立即关联现有问题任务或创建独立问题任务；但该规则只适用于违反既有需求/计划/验收/安全边界的问题。AI自行提出的优化、功能建议、产品创意、新需求候选不得进入任务注册表，统一写入独立 `AI优化建议与候选需求池.md`，由用户后续集中查看；只有用户明确采纳或既有批准计划已包含后才能转正式任务 | 用户2026-10-06治理确认 / P0任务闭环边界 | **WTB-NEW-ISSUE-TASK-001 开发完成，待独测**：已补总协作、开发AI、测试AI规则并新增独立候选需求池，形成“问题强制落任务 / AI建议只进候选池 / 用户采纳后才转正式任务”的三段边界；npm run check PASS，治理合同 12/12 PASS | WTB-NEW-ISSUE-TASK-001 | AI优化建议与候选需求池.md；docs/governance/AI协作与任务流转规范.md；docs/governance/开发AI工作规范.md；docs/governance/测试AI工作规范.md |



## 2. 与ERP及现有任务中心的边界

当前 `erp/pages/task-center.html`、`erp/assets/task-center.js` 和 `统一任务中心开发计划.md` 继续只负责ERP业务异步任务，例如同步、Worker、父子批次和失败原因。

B-10是**独立项目治理服务**，负责A-01开发/独测、B-09邮箱登录、DOC文档任务、独立测试退回、用户验收和AI当前执行会话等协作状态。

硬边界：

- B-10代码不得放入 `erp-x20`；
- B-10不得注册到ERP `server.js`、`start.ps1`、`/api/*`、`sidebar.js` 或ERP数据库迁移；
- ERP启动/停止/重启不启动、停止或重启B-10；
- B-10启动/停止/升级不启动、停止或重启ERP；
- 不得把B-10状态塞进 `/api/sync-tasks`；
- 不得用ERP业务任务“成功”代替开发任务“独测通过”；
- 第一版不依赖ERP登录、Cookie、CSRF或system.admin权限。

ERP后续如需要，可以只增加一个**外部链接**打开 `http://127.0.0.1:47831`，但该链接不是B-10运行依赖，也不属于第一版硬要求。

## 3. 独立部署、认证与端口边界

### 3.1 独立目录和进程

默认安装/源码根：

`D:\WyerpTaskboard`

建议结构：

- `server/`：独立Node服务；
- `web/`：独立前端；
- `cli/`：AI/本机命令行客户端；
- `config/projects.json`：被管理项目白名单；
- `data/events/`：事件日志；
- `data/logs/`：服务日志；
- `data/runtime/`：PID/端口/运行态；
- `tests/`：独立测试。

不得把B-10的 `node_modules`、日志、PID、缓存、事件库或配置写入 `erp-x20`。

### 3.2 独立端口

默认：

- Host：`127.0.0.1`
- Port：`47831`
- URL：`http://127.0.0.1:47831`

2026-09-28规划时检查 `47823 / 47831 / 47832 / 8765` 未发现监听占用；**这只是规划时快照，开发/启动时仍必须重新检测端口冲突。**

端口规则：

- 不复用ERP `8765`；
- 不默认复用参考项目dashi的 `47823`；
- 端口冲突时启动失败并给出明确提示，不静默改端口造成书签/CLI失配；
- 允许通过独立环境变量或配置修改端口。

### 3.3 独立启动与存活

B-10必须有自己的 `start/stop/status`，最终可选择Windows计划任务或独立服务方式自启动。

#### 3.3.1 start / stop / status 严格进程身份

B-10自身启停沿用严格身份识别原则，**端口占用或PID文件都只能作为线索，不能作为kill充分条件**：

1. `status` 读取runtime PID/instance metadata后，再核对 `47831` 实际监听PID；
2. 确认目标进程可执行文件为预期Node运行时；
3. Windows上使用可靠argv解析（实现时优先 `CommandLineToArgvW` 或等价方法），不得用简单字符串contains判断；
4. 确认实际入口脚本位于 `D:\WyerpTaskboard\server\` 的预期启动入口，并核对B-10自己的instance/startup参数；
5. PID文件过期、PID复用、入口不匹配、argv不匹配时一律拒绝kill并报告“身份不匹配”；
6. 端口被其它Node或非Node占用时只报告冲突，不终止未知进程；
7. `stop` 只允许终止通过完整身份校验的B-10实例。

最低负向测试必须包含：**其它Node占47831、非Node占47831、过期PID文件指向其它进程**，三者全部不得误杀。

验收必须证明：

1. 看板运行时重启ERP，B-10页面/API/CLI不中断；
2. ERP运行时重启B-10，ERP业务服务不中断；
3. ERP启动失败时仍能打开看板查看/审阅任务；
4. B-10启动失败不影响ERP启动。

### 3.4 第一版认证

第一版默认只绑定loopback，不开放LAN/公网。

建议独立认证：

- 首次启动生成本机管理密钥/管理员凭据；
- 浏览器建立独立SameSite会话；
- 写操作继续做CSRF/Origin/Host校验；
- 严格拒绝非loopback Host/Origin；
- 不复用ERP账号密码、Session或Cookie；
- 如未来需要LAN/公网访问，另立安全任务增加TLS和独立多用户认证，不借ERP公网入口转发。

API不得接受任意文件路径，不得变成通用文件读取/写入接口。

## 4. 主数据源设计

### 4.1 权威状态源

每个被管理项目自己的 `待办任务总清单.md` 继续作为**该项目任务阶段、优先级和当前执行归属的唯一主源**。B-10自身只保存项目映射、事件、审阅和运行元数据，不建立第二套当前任务真值。

B-10实施时给当前任务表增加机器边界：

```text
<!-- PROJECT_TASK_REGISTRY_START v1 -->
| 任务ID | ... |
...
<!-- PROJECT_TASK_REGISTRY_END -->
```

解析器只允许读写这一段，不通过模糊正则整篇覆盖Markdown。

### 4.1.1 多项目映射

B-10自己的 `config/projects.json` 只登记白名单项目，例如：

```json
{
  "projects": [
    {
      "id": "erp-x20",
      "name": "网研ERP",
      "root": "D:\\跨境电商\\erp-x20",
      "adapter": "markdown-task-registry-v1",
      "registryFormatVersion": 1,
      "workflowProfile": "wyerp-ai-flow-v1",
      "taskRegistry": "待办任务总清单.md",
      "resourceLedger": "任务执行与资源占用台账.md",
      "checkpointDir": "任务进度断点",
      "reportDir": "测试报告"
    }
  ]
}
```

`projects.json` 是整个多项目文件访问边界，必须采用受限Windows ACL，仅允许B-10运行账号/管理员修改。项目加载时固定一次root的规范化真实路径；每次访问子路径时再次做真实路径校验，并显式拒绝通过junction、symlink、mount point或其它reparse-point逃逸项目root。页面和API只能传 `projectId + taskId`，不能传任意绝对路径。

### 4.1.2 Adapter / Workflow Profile

“多项目”不能只等于多路径。B-10核心层只认识规范化任务对象，不硬编码某个项目的Markdown格式或ERP状态机：

- **adapter**：负责定位、解析、revision/SHA计算和安全写回任务注册表；例如 `markdown-task-registry-v1`；
- **registryFormatVersion**：标识注册表机器格式版本，用于迁移/兼容检查；
- **workflowProfile**：定义该项目的状态集合、优先级集合、角色、合法流转、用户审阅语义、完成条件、看板列映射和默认排序；例如 `wyerp-ai-flow-v1`；
- **核心服务**：只调用adapter/profile接口，不写死 `待独测/P0/开发AI` 等ERP专用词。

第一版允许只交付 **`markdown-task-registry-v1 + wyerp-ai-flow-v1`** 这一组真正可写适配器/profile；其它项目若没有兼容adapter/profile，可以登记但必须显示“工作流/格式不支持”，不得假装可写。后续要支持 `backlog → doing → review → done` 等其它流程时新增profile，不修改核心看板状态机。

#### 4.1.2.1 Adapter 写权限边界

Adapter 的“可写”只表示**可以受控写任务治理数据**，不代表任务看板获得项目目录的通用编辑权。第一版必须实行路径/字段白名单：

- 允许：任务注册表治理字段、资源台账、看板自身事件/transaction 数据；
- 默认禁止：业务计划正文、README/必读/报错记录、源码、测试代码、数据库、业务配置、凭据、真实业务数据、项目测试报告正文、项目任务断点正文；
- 需要修改默认禁止范围时，不由看板服务代写，而是创建/关联正式项目任务，由项目开发AI/测试AI在目标项目工作区中执行；
- 未来若增加某类专用写回能力，必须单独定义 schema、目标路径白名单、权限、审计事件、并发/SHA保护和用户授权边界，不能把“项目root可访问”解释成“任意文件可写”。

看板 `data/` 中的快照、事件和缓存只用于显示/审计，不得成为项目业务内容的第二套真值。

### 4.1.3 Track 调度维度

规范化任务对象增加 `track`。第一版至少支持：

- `product`：产品/业务主线；
- `infrastructure`：协作、开发工具、治理基础设施。

优先级只在track内表达紧急度。默认机器调度/推荐顺序必须满足：

- `product/P0` 保持业务关键路径优先；
- `infrastructure/P0` 是基础设施轨道最高优先级，但**不自动压过 product/P0**；
- B-10自身登记为 `infrastructure/P0`；
- 基础设施任务可在资源空闲、不会占用产品关键资源时并行；
- 自动领取不得只按P值做一个全局排序。

其它项目可由workflow profile定义更多track或自己的track排序策略。

### 4.1.4 项目源健康与故障隔离

每个project独立维护source health，不允许一个项目目录故障拖垮整个看板：

- 启动/刷新时分别检测项目root、taskRegistry、adapter/profile兼容性和写权限；
- 项目目录临时不存在、磁盘离线、权限拒绝、registry损坏或adapter不兼容时，该项目显示明确健康状态，例如 `source_unavailable / read_only_blocked / format_unsupported / transaction_inconsistent`；
- 失败项目不得让服务进程崩溃，也不得阻塞其它健康项目的读取、审阅和写入；
- 对不可访问项目不得用旧缓存冒充“当前状态”，历史事件仍可只读查看并明确标注数据源离线；
- 恢复访问后先重新校验root真实路径、registry SHA/revision和未完成transaction journal，再恢复写能力。

### 4.2 当前任务注册表建议字段

至少包含：

- 任务ID；
- 父任务/长期功能ID；
- track；
- 产品阶段（若该profile定义）；
- 优先级（取值由workflowProfile定义；`wyerp-ai-flow-v1` 为 P0/P1/P2）；
- 当前阶段/状态（取值由workflowProfile定义）；
- 计划角色（取值由workflowProfile定义）；
- 当前负责人；
- **会话窗口名称**；
- **技术会话/尝试ID**；
- 最近更新时间；
- 准备条件/边界；
- 主计划；
- 断点；
- 最新报告。

执行中状态没有会话窗口名称时，页面显示“会话名称缺失”，不得用模型名称代替。

### 4.3 会话窗口名称

当前工具可以稳定保存 `wc_sess_*` 等技术ID，但不保证能自动读取ChatGPT UI真实窗口标题。

第一版：

- AI认领时显式传 `sessionWindowName`；
- 同时保存 `sessionId`；
- 无法自动获取真实标题时，填写用户可识别的人类名称，系统管理员可修正；
- 页面提供一键复制“窗口名称 + session ID”；
- 不伪造“已自动定位ChatGPT窗口”能力；
- 后续平台若提供安全线程跳转，再增加“打开会话”。

## 5. 辅助事件日志

用户审阅意见、控制请求和历史操作不塞进Markdown表格。

建议新增：

`D:\WyerpTaskboard\data\events\<projectId>.jsonl`

它只保存事件历史，**不成为任务当前状态主源**。

字段至少包括：

- event_id；
- operation_id / idempotency_key；
- task_id；
- event_type；
- timestamp（含时区）；
- actor_type：user / developer_ai / test_ai / system；
- actor_id；
- session_window_name；
- session_id / attempt_id；
- old_status / new_status；
- old_priority / new_priority；
- review_revision；
- note；
- changed_paths；
- report_path；
- test_result；
- task_registry_sha_before / after。

事件至少包括：claim、release、code_change、doc_change、test_start、test_result、status_change、priority_change、user_review、user_accept、user_reject、stop_request、stop_acknowledged、resume、blocked、handoff。

日志append-only，页面不得删除历史审阅记录。

### 5.1 事件日志保留、备份与损坏恢复

事件日志虽然不是“当前任务状态真值”，但用户为什么通过/打回、停止/恢复、历史测试结论都属于重要治理数据，不能按临时日志处理：

- 事件文件按日期/大小滚动，阈值配置化；
- 已封存segment只读，不原地改写；
- segment保留校验信息/manifest，启动时发现截断或损坏必须隔离并告警；
- 定期备份事件segment、`projects.json` 和transaction journal；
- 提供只读重放/校验工具，能够从最后一个完整事件边界恢复；
- 单个项目事件日志损坏不得拖垮整个服务，该项目进入“事件历史异常/写入阻断或降级只读”，其它项目继续正常工作。

## 6. 独立Web界面

页面代码位于 `D:\WyerpTaskboard\web\`，由B-10自己的 `47831` 服务提供，不写入ERP `pages/`、`assets/` 或侧边栏。

访问方式：

- 浏览器：`http://127.0.0.1:47831`；
- 可在完成后创建桌面/开始菜单快捷方式；
- ERP内如未来增加“打开任务看板”入口，只允许是外链，不承载看板逻辑。

页面顶部汇总项由当前项目 `workflowProfile` 提供；`wyerp-ai-flow-v1` 可以显示P0/P1未完成、执行中、待独测/待复测、测试失败待修复、待用户验收、阻断/HOLD、已完成，其它profile使用自己的优先级/状态语义。

### 6.1 双视图

**看板视图**：列定义由workflowProfile提供。 `wyerp-ai-flow-v1` 的用户界面按“减少横向占用、保留完成列”的原则采用以下**显示层合并**，底层任务状态与合法流转保持独立，不因合列而改写状态机：

1. **待处理 / 待认领**：合并为同一显示列，只覆盖等待中的开发任务和普通待处理任务。`待确认`直接显示为待处理；底层为 `待准备` 或 `待开发` 且 `plannedRole=开发AI` 的任务读取最新 task-scan `developerCandidates`：`eligible=true` 且无 blockers 时在卡片上标记“待认领”，否则标记“待处理”。此合并仅发生在显示层，不新增或改写底层任务状态；
2. **待执行**：只保留测试AI的 `待独测 / 待复测`；测试AI不进入待认领逻辑；
3. **执行中**：`开发中`、`修复中`、`独测中`、`复测中`、`交付中`；
4. **待交付 / 待用户**：`待交付`、`待用户验收`；两者只在看板展示上同列，任务详情仍必须明确真实状态，只有 `待用户验收` 才代表需要用户最终验收；
5. **失败 / 阻断 / 暂停**：`测试失败待修复`、`阻断`、`HOLD`；
6. **完成**：`已完成`、`已取消`。

看板顺序固定为：**待处理/待认领 → 待执行 → 执行中 → 待交付/待用户 → 失败/阻断/暂停 → 完成**。不得再为待认领新增独立列、独立整行或独立候选区域。

**动态资格规则**：合并列中的“待认领”只是实时显示标签。每次 task-scan 都必须重新计算开发候选 eligibility 和 blockers；如果文件/资源冲突或其它门禁使任务从 `eligible=true` 变成 `eligible=false`，同一列内必须立即从“待认领”降为“待处理”。冲突解除并重新扫描后，满足全部门禁才恢复“待认领”。Web 不得缓存旧 eligibility 覆盖最新扫描真值。

不得为了节省列数把 `待交付` 与 `待用户验收`、开发与测试阶段在数据层合并；候选调度、角色门禁、详情文案、事件日志仍按真实状态判断。

### 6.1.0 任务先于实现的治理门禁

- 正式开发/修复任务必须先存在于项目任务注册表，随后才可能成为开发候选；不存在稳定任务ID的需求不得直接进入代码修改阶段。
- 新增任务统一走 adapter 结构化创建：CLI 使用 `taskctl create`，HTTP 使用项目 tasks create API，底层由 `appendRegistryTaskText` 按当前表头字段索引序列化并在写入前后复解析。**禁止 AI、脚本或项目适配逻辑手工拼接 Markdown 机器表整行**；正文中的普通 `|` 必须由 adapter 自动转义，源注册表已经存在列数不一致时必须拒绝继续写入并保留原文件。
- 开发AI第一次改业务代码/测试代码/可执行脚本前，必须完成：任务登记 → 用户可见任务汇报 → 最新占用/guard复核 → 正式claim。候选 eligibility 不能替代claim。
- 该规则不仅约束自动执行，也约束人工CLI/手工会话：**禁止通过手工工具绕过“先建任务后开发”。**
- 发现先写后领时，必须保留真实时序并登记治理纠正事件；不得倒填认领时间。紧急安全止损只允许最小停止/隔离，不授权继续开发。
- 被管理项目的“必读文档”由看板任务关联字段提供路径入口，执行AI按关联去项目目录读原文；**不是项目文档反过来依赖看板，也不是把项目正文迁进看板。**

### 6.1.1 AI自动执行顺序

开发AI只在当前任务 guard、用户留言、资源、写入范围、模型/推理强度等门禁均通过时认领，并按以下**队列层级**选择任务：

1. `待交付`；
2. `测试失败待修复 / 阻断` 中可合法恢复或修复的开发任务；
3. `待开发` 等待执行任务；
4. 其它已经进入 `待认领` 派生显示、且 `eligible_role=developer_ai` 的任务，包括测试证据/固定版本不足回流的 `待准备 + 开发AI` 任务。

任一更高层级存在合法可执行任务时，不向后选择。层级内部再按 P0→P1→P2、项目现有 track 排序和首次检测时间排序。

测试AI当前只消费 `待独测 / 待复测`，分别进入 `独测中 / 复测中`；不得把 `待开发`、`测试失败待修复`、`待交付`、`阻断` 等开发态任务分配给测试AI。

**列表视图**：任务ID、标题、track、阶段（若有）、profile优先级、profile状态、负责人、会话窗口、最近更新、计划、最新报告、操作。

不猜任务百分比；只有AI显式回写完成子项/总子项时才显示计数。

### 6.2 筛选

支持项目、track、workflowProfile定义的优先级/状态/角色、负责人、停止请求、未读用户意见、用户审阅状态及任务ID/标题搜索；`erp-x20` 下具体显示P0/P1/P2和现行AI协作状态。

任务归档筛选的**默认值必须是“全部任务”**，页面首次打开、刷新和恢复已有登录会话时都不得默认为“进行中”。用户主动切换为“进行中/已完成”后只影响本次用户筛选状态，不允许代码更新把默认值悄悄改回。Web UI契约测试必须固定验证默认选项为“全部任务”。

## 7. 用户审阅

任务详情提供“我的审阅意见”。

用户可以：

- 只留言；
- 通过；
- 打回；
- 暂停；
- 调优先级；
- 启动/恢复。

### 7.1 通过

- `待用户验收 → 已完成`：用户点击“通过”作为明确验收；
- 其它阶段只能记录“认可当前进度”，不能跳过独测/复测/交付直接完成。

### 7.2 打回

用户打回时选择原因：

- 原需求范围内缺陷 → `测试失败待修复`；
- 证据/材料/固定版本不全 → `待准备`；
- 需求或规则需要重新决定 → `待确认`；
- 暂不继续 → `HOLD`。

评论、原因、原状态、目标状态、时间写事件日志。被打回任务重新进入合法AI认领队列。

### 7.3 项目移除 / 退出管理

用户可将“已做完”或“决定不再做”的被管理项目从 WyerpTaskboard 当前项目列表中移除。该动作只移除任务看板的项目注册/管理关系，**不得删除被管理项目目录、源码、任务文档或业务数据**。

验收边界：

- 项目列表和项目管理区域提供明确中文“移除项目”入口；
- 必须二次确认，并明确提示“只从看板移除，不删除磁盘文件”；
- 当前正在执行、存在未释放资源/活动 Session、或仍有进行中任务的项目不得静默移除，应说明具体阻断原因；
- 移除成功后更新项目注册真值，刷新列表后不再出现；重新添加同一路径时按现有项目适配/注册规则处理；
- 该能力独立任务：`WTB-PROJECT-001`。

### 7.4 AI回复角色标识

任务详情中的AI回复必须明确显示真实角色名，至少区分 **开发AI** 与 **测试AI**，不得统一显示模糊的“AI回复”。角色来源使用事件的 `actorType`，显示层映射为中文角色名；回复正文不要求执行AI重复手工写前缀，但历史缺少角色字段时可显示“AI回复（历史）”。独立任务：`WTB-REPLY-001`。

## 8. 用户调整优先级

用户可调整P0/P1/P2。

要求：

- 修改 `待办任务总清单.md` 权威注册表；
- append `priority_change`；
- 记录旧值/新值；
- 执行中任务降级不自动强停；
- 若同时点停止，走停止流程；
- 产品阶段与优先级分开管理。

## 9. 启动 / 停止语义

### 9.1 停止空闲任务

无执行者时立即转 `HOLD`，保存停止前状态和原因，AI不得继续自动认领。

### 9.2 停止执行中任务

独立看板服务不能假装能强杀ChatGPT/WebCodex会话。

正确流程：

1. 写 `stop_request`；
2. 看板显示“停止请求中”；
3. 当前AI每次实际修改/测试前执行guard；
4. AI发现请求后停止新写入/测试；
5. 保存断点；
6. 释放文件/浏览器/数据库等资源；
7. 回写 `stop_acknowledged`；
8. 权威状态转 `HOLD`。

只有AI确认后页面才显示“已停止”。

### 9.2.1 Cooperative enforcement 边界

第一阶段的 `taskctl guard` / stop协议属于**协作式强门禁（cooperative enforcement）**，不是不可绕过的物理硬锁：

- 合规AI必须在写文件、启动测试、领取/释放资源前调用guard；
- 用户发出stop后，看板可以立即记录请求并阻止新的合规认领，但如果某个AI绕过 `taskctl` 直接调用WebCodex写工具、Shell重定向或直接启动测试，B-10本身无法从旁物理拦截；
- 因此在Runner/WebCodex没有把lease/guard接入所有写入和测试入口前，文档、UI、报告只能宣称“协作门禁/停止请求已生效”，不得宣称“不可绕过硬停止”；
- 真正hard enforcement只有在Runner/WebCodex层统一校验有效lease/guard并拒绝绕过写入/测试后才能升级表述；
- 本边界与任务看板写入层的SHA/锁并发保护是两件事，不能互相替代。

### 9.3 重新启动

“启动”表示恢复为合法可领取状态，不等于ERP自动创建ChatGPT会话。真正AI认领后才进入开发中/独测中/复测中。

## 10. AI领取与强制回写协议

独立项目内建议提供共用核心库和CLI，例如：

- `D:\WyerpTaskboard\server\task-store.mjs`
- `D:\WyerpTaskboard\cli\taskctl.mjs`
- 可选Windows包装：`D:\WyerpTaskboard\taskctl.cmd`

ERP项目内不新增任务看板CLI实现。AI从任意被管理项目工作时调用独立 `taskctl`，并通过 `projectId + taskId` 定位任务。

计划命令形态包括claim、guard、changed、test-start、test-result、release；具体参数实现时固定，当前不得写成已经存在。

### 10.1 每次修改回写

每个成功的逻辑写操作/事务后，至少写一条 `code_change` 或 `doc_change`。多文件原子编辑可一条事件列全部路径。失败且未改变文件不冒充修改。

### 10.2 每次测试回写

冒烟、专项测试、独测、复测、回归都必须：

- 开始前 `test_start`；
- 结束后 `test_result`；
- 独测/复测带唯一报告路径；
- 失败按中央状态流转；
- 未测试/阻断不得写通过。

独立测试AI也使用同一写回层，不再只写报告而不更新总清单。

### 10.2.1 审计结果必须转成任务注册表

计划审计、历史功能盘点、已实现功能补档和遗留缺口清查属于正式任务来源，不允许只在计划文档中留下“未完成 / 待复核 / 以后做”文字。执行审计的AI必须在本轮结束前逐项完成以下动作：

- 先查项目任务注册表是否已有相同范围任务，已有则关联并按当前证据更新阶段/边界，禁止重复造任务；
- 未实现或实现不完整的范围生成开发任务；
- 已实现但从未形成可信独测证据的范围生成`待独测`任务；
- 曾验证过但后续代码/依赖/接口/结构变化使旧证据失效，或属于缺陷修复后的再次验证，生成`待复测`任务；
- 仅缺真实接口、真实账号、额度、浏览器或固定版本等测试前置时，生成计划角色为测试AI的`待准备`任务，而不是把缺口埋在计划正文；
- 用户明确暂缓的可选增强登记`HOLD`；确属重复/不在范围且已有完整覆盖证据时才可标`无需任务`。

审计输出表必须包含`处置结论 + 关联任务ID + 判定依据`。除`无需任务`外，没有任务ID的发现项视为未完成闭环，原审计任务不得进入待独测/待交付。看板后端第一阶段**不解析自然语言计划并自动创造任务**；任务生成由执行审计的合规AI完成，任务真值仍唯一写入被管理项目的任务注册表。

### 10.2.2 用户留言回复状态必须在主页可见

- 正式任务：`WTB-REPLY-STAMP-001`。
- 当**最新一条用户留言**已经存在至少一条 `user_message_reply` 时，主页任务卡必须显示醒目的“已回复”印章；该印章是回复状态真值，不是普通装饰。
- 用户后续新增了更晚的留言且尚未收到AI回复时，旧回复不得让新留言继续显示“已回复”。
- 点击任务卡后，详情仍展示具体回复正文、回复时间和真实角色名；主页印章只做“一眼可见”的摘要提示。
- 第一版只允许使用现有任务事件派生状态，不新增第二套回复数据库或前端本地真值。
- 本任务只属于任务面板可用性；禁止扩展到监控、Chat Wake、全局哨兵或自动恢复链。

### 10.3 独立性保护

认领独测/复测时检查状态、test角色及历史核心实现者/修复者。同一实际执行者不能换窗口名或session ID冒充独测。

### 10.4 本机10分钟自动巡检、候选队列与ChatGPT触发桥接（B-10-AUTO）

#### 10.4.1 任务定位与优先级

- 正式子任务：**B-10-AUTO**，父任务/功能：B-10 / F-022。
- 轨道：`infrastructure`。
- 优先级：**P0，用户明确指定为当前 infrastructure 轨道最高优先级子任务**。
- P0仍遵守项目既有track规则：不把基础设施任务伪装成`product`，不强抢已被其它任务合法持有的文件、浏览器、测试服务或执行会话。
- B-10主体复测与B-10-AUTO分开留证；二者可以在文件资源不冲突时并行，但不得互相覆盖状态或测试结论。

#### 10.6.2 目标

本子任务把“ChatGPT自动任务最低只能每小时运行一次”的时间粒度限制移到本机侧解决：

1. Windows本机采用自适应巡检：测试任务结束立即one-shot；无测试候选但仍有开发任务时进入 `developer_watch` 每 **10分钟**巡检；测试/开发任务均无时进入 `idle_suspended`；
2. 每次实际巡检扫描B-10白名单中的全部项目，而不是只检查B-10；
3. 只产生“可认领候选/阻断原因”证据，不直接冒充开发AI、测试AI或用户修改任务阶段；
4. 候选结果必须持久化到B-10自己的数据目录，并包含足够快照信息，让后续ChatGPT确认“这是哪一次检测、基于哪个任务版本得出的结论”；
5. ChatGPT运行时先读取候选队列，再重新核对项目Markdown正式真值、用户留言、stop/HOLD、当前负责人、文件/浏览器/测试资源、活动Job、独立性和固定版本；条件仍成立才正式claim；
6. 在没有受支持的ChatGPT事件触发通道前，保留现有每小时ChatGPT自动任务/手动消费作为兜底；`developer_watch` 的本机10分钟巡检不得宣称已经能立即唤醒当前ChatGPT聊天，`idle_suspended` 时也不得宣称仍在周期扫描；
7. 后续若发现并验证受支持的插件/连接器/事件入口，可增加“检测到候选 → 触发一次ChatGPT执行”的桥接，但触发器只负责唤醒，不跳过ChatGPT复核/认领门禁。

#### 10.4.3 权威状态与ChatGPT认可合同

本机巡检结果是**候选证据源**，不是第二套任务真值。

权威顺序固定：

1. 被管理项目任务注册表（erp-x20当前为`待办任务总清单.md`）决定当前阶段、优先级、计划角色和当前负责人；
2. `任务执行与资源占用台账.md`、断点、测试/开发报告、B-10事件用于补充资源、版本和过程证据；
3. 本机巡检队列只记录“在某个快照上看起来已满足/不满足认领条件”；
4. ChatGPT不得因为队列写了`eligible=true`就直接认领，必须重新读取正式真值；
5. 正式真值或资源发生变化时，旧候选自动视为stale，不得复用；
6. 本机扫描器**禁止写入current owner、session、开发中/独测中/复测中、test_result或用户验收结果**；这些仍由真实AI/用户通过受控流程产生。

因此，“本机检测到的内容ChatGPT会认”的含义固定为：**ChatGPT把它当作需要优先复核的机器候选证据，并在复核通过后执行正式认领；不会把脚本的一句话直接当成任务已经被AI领取。**

#### 10.4.4 本机10分钟调度

计划增加Windows计划任务：

- 任务名：`WyerpTaskboard-TaskScan（间隔可配置，默认10分钟）`；
- 执行账户：安装B-10且能读取白名单项目的当前Windows用户；运行扫描本身不需要管理员权限；
- 触发：登录/开机后先执行一次one-shot重算调度模式；仅 `developer_watch` 保持每10分钟重复；`idle_suspended` 不执行完整registry巡检，受控任务/需求/状态写入、服务启动或手动scan负责re-arm；
- 并发策略：**不启动新实例**；上一轮未结束时跳过本轮并记录`previous_run_active`；
- 错过计划：系统恢复后允许尽快补跑一次，但仍执行相同去重/并发保护；
- 最长运行时间必须显著小于10分钟；超时记录阻断，不杀未知进程；
- 安装/卸载计划任务必须由独立脚本完成，可重复执行且幂等。

目标文件：

- `D:\WyerpTaskboard\scripts\install-task-scan-schedule.ps1`
- `D:\WyerpTaskboard\scripts\remove-task-scan-schedule.ps1`
- `D:\WyerpTaskboard\scripts\run-task-scan.ps1`
- `D:\WyerpTaskboard\cli\task-scan.mjs`

##### 10.4.4.1 自适应巡检状态机（B10-UR-27）

用户最新决策取代“只要机器开着就永久每10分钟完整扫描”的旧解释。计划任务可以继续作为本机调度载体，但业务状态分为：

1. **test_chain（测试链立即续接）**：独立测试AI完成一项测试、落报告并释放该任务资源后，立即执行一次候选刷新；存在其它可认领的 `test_ai` 任务时，仍按独立性/guard/资源门禁正式claim，不等待下一个10分钟周期。
2. **developer_watch（开发观察态）**：当前没有可认领测试任务，但白名单项目仍存在未闭环的开发角色任务时，本机才保持每10分钟巡检，用于捕获 `待开发`、`测试失败待修复` 以及开发任务释放后重新可认领等变化。这里的“有开发任务”不授权测试AI改身份认领，只表示本机仍值得周期观察。
3. **idle_suspended（空闲休眠态）**：既没有可继续处理的测试任务，也没有未闭环开发任务时，不再每10分钟读取全部项目任务注册表。Windows任务应被禁用、暂停，或仅执行不读取项目真值的常量级idle no-op；UI必须明确显示“当前无测试/开发任务，10分钟巡检已休眠”。
4. **re-arm（重新唤醒检查）**：通过B-10受控写入出现新任务、新需求完成拆解、任务回流 `待开发/测试失败待修复/待独测/待复测`、用户打回、测试结果/开发交付、服务启动或用户/ChatGPT手动执行scan时，先做一次one-shot扫描；若扫描后满足developer_watch再恢复10分钟周期，否则继续idle_suspended。
5. 若存在绕过B-10的直接Markdown外部写入，且没有文件监视器/受支持事件源，则idle_suspended期间不能虚假宣称能即时发现该写入；下次服务启动、手动scan或受控写入触发one-shot时再发现，并在UI/文档中保留此能力边界。

调度状态至少持久化 `scan_mode / reason / armed_at / suspended_at / last_rearm_source`，并与候选本身分开：调度是否活跃不改变任务真值、owner、session或资源权。

#### 10.4.5 扫描范围与候选条件

每轮对每个白名单项目：

1. 读取项目配置、adapter/workflowProfile；
2. 固定本轮registry SHA/revision；
3. 读取任务阶段、优先级、track、计划角色、当前负责人/会话；
4. 对可能进入执行队列的任务再读取最新断点、交付/修复/测试报告和资源台账；
5. 用户未读留言、待拆新需求、stop_request/HOLD、异常接管未闭合、资源归属未知时，候选必须标为blocked；
6. 开发AI候选允许来自 `待交付`、`测试失败待修复`、`待开发`，以及 `plannedRole=开发AI` 的 `待准备`；其中 `待准备` 仅在 writeTargets、资源/文件冲突、用户留言、stop、失联、owner/session 等全部门禁通过时才可claim；
7. test_ai候选只允许来自`待独测`、`待复测`，并标记需要独立性复核；
8. `待准备 + plannedRole=开发AI` 是开发准备收口阶段，合法claim后进入`开发中`；`待准备`但计划角色不是开发AI、`待确认`、HOLD、已完成、已取消不得自动认领；
9. 有当前负责人/活动会话/恢复中Job或无法确认旧副作用停止时，不生成可claim候选；
10. 同级排序继续按中央规则：严重程度/阻断性 → 复测/已有缺陷修复 → 入队时间 → 任务ID；track/产品阶段规则不被本机扫描器改写。

#### 10.4.6 候选数据模型、去重与过期

计划持久目录：

`D:\WyerpTaskboard\data\runtime\task-scan\`

每条候选至少包含：

- `detection_id`
- `detected_at`（含时区）
- `project_id`
- `task_id`
- `track / priority / status / planned_role`
- `registry_revision / registry_sha`
- `resource_ledger_sha`
- `checkpoint/report refs`
- `eligible_role`
- `eligible`
- `blockers[]`
- `reason`
- `source_fingerprint`
- `dedupe_key`
- `expires_at`
- `consumed_at / stale_at`

规则：

- 同一`project + task + status + registry revision + eligible role`只保留一个有效候选；
- 连续扫描只更新最后确认时间，不重复制造候选风暴；
- 默认候选最多保留3个扫描周期（30分钟）作为快速提示，真正claim仍必须重新核对，因此即使未过期也不能跳过复核；
- 项目root/registry不可读、解析失败、revision漂移时只记录扫描异常，不把任务标成可claim；
- scan-store写入使用临时文件+原子替换/append-only事件，不直接写ERP任务注册表。

目标模块：

- `D:\WyerpTaskboard\server\scan-store.mjs`
- `D:\WyerpTaskboard\server\candidate-evaluator.mjs`
- `D:\WyerpTaskboard\data\runtime\task-scan\`

#### 10.4.7 ChatGPT消费与正式认领

合规ChatGPT执行开始时，如果B-10健康且存在未消费候选：

1. 先读取最高优先候选；
2. 重读任务注册表及相关断点/报告/资源；
3. 执行guard，优先处理用户留言、新需求、stop；
4. 校验实际执行者独立性；
5. 校验无活动owner/session/Job和资源冲突；
6. 条件仍成立才用本次真实`actorId + sessionId`执行claim；
7. claim成功后把候选标记`consumed`并记录真实claim事件ID；
8. 条件变化则标记`stale/blocked`，不占资源；
9. 同一候选不得被两个ChatGPT执行器重复claim；未知结果先查询，不生成第二次claim。

任务完成后的连续处理固定为：

10. 测试AI结束当前测试任务后，先完成报告、状态同步和资源释放，再立即刷新候选，不把“本项测试已结束”当作本轮自然停止点；
11. 仍有合规 `test_ai` 候选时，继续按 `recheck → guard → 独立性/资源核对 → claim → mark-consumed` 认领下一项；
12. 没有可认领测试任务但仍存在开发任务时，测试AI**不认领开发任务**，只把本机扫描模式切换/保持为 `developer_watch`，由真实开发AI在其会话中消费开发候选；
13. 测试和开发任务都不存在时进入 `idle_suspended`，不继续制造10分钟空扫描。

职责固定：

- 扫描器：发现、持久化、排序、提示；
- ChatGPT：理解上下文、处理留言/需求、独立性判断、正式认领、执行任务；
- 用户：业务决定、扩大授权、最终验收。

#### 10.4.8 “检测到立即触发ChatGPT”的桥接边界

L3只允许**普通聊天模式**执行。用户明确禁止使用ChatGPT Work执行任务，因此任何会把GitHub/Gmail/Slack事件任务放进Work运行的事件触发路径，都不得作为本项目L3正式实现。

当前状态：

- GitHub Wake Bridge传输层历史真实验证继续保留，但 GitHub→Work 生产路径保持停用；当前即时触发正式路径已切换为本机 SSE + Chrome Chat Wake 扩展；
- 0.6.4 扩展已在普通 ChatGPT 页面完成真人同版本重载验证：保留旧 dispatcher 页面后再次重载扩展，新 dispatcher epoch 成功接管并完成自动发送与 ACK；
- 软件与扩展版本独立管理：看板当前版本来自 `package.json.version`；扩展当前版本来自 `manifest.version`，且 `expected_extension_version` 只需与 manifest 一致。`candidate_ready` 携带 `extension_version / extension_latest_version / taskboard_version`；扩展实际版本必须等于扩展最新版本，但扩展版本与看板版本允许不同。只有扩展自身已升级而浏览器仍加载旧扩展时才拒绝握手；
- `background.js` 在同一 active candidate 未 delivered 时持续重试，不再约50秒后耗尽；0.6.4 另以单调递增 `dispatcher_epoch` 隔离扩展重载前后的 dispatcher 代际，更高 epoch 可立即接管旧 epoch 未过期 lease，旧 epoch 后续 claim/ACK 必须被拒绝；
- 当前L3正式状态为 `enabled_verified`；触发成功只表示普通聊天收到候选，不表示任务已合法 claim。

chat-only正式实现必须满足：

- 外部事件只能负责唤醒普通聊天线程，不在Work/独立API执行器中执行任务；
- 被唤醒的聊天必须继续使用聊天产品能力调用WebCodex，回到本机读取 `project_id / task_id / detection_id / eligible_role`；
- 正式claim前仍执行recheck、Markdown真值、用户留言、stop/HOLD、owner/session、活动/恢复中Job、资源与独立性检查；
- 触发成功只表示“聊天线程被唤醒”，不表示claim成功；
- 重复触发必须幂等；失败不得丢本机候选；
- 允许已加载的 Chrome 扩展通过公开 content-script 能力向用户已登录的普通 ChatGPT 输入并发送 `candidate_ready`；禁止私有 ChatGPT API、OpenAI API另起执行器或Work绕过聊天模式。

只有存在真实版本握手、普通聊天页面证据和 ACK 时才允许显示 `enabled_verified`；当前 0.6.4 已满足触发验证条件，并补齐扩展重载代际接管。正式 claim 仍必须由被唤醒聊天重新执行 WebCodex recheck/guard/资源/角色检查。
#### 10.4.9 故障、降级和恢复

- Windows计划任务不存在/禁用：看板显示“10分钟本机巡检未安装/已停用”，不影响ERP与B-10其它功能；
- B-10服务停止：扫描CLI可以读取独立配置并写B-10本地scan-store；不得写ERP业务状态；服务恢复后再展示候选；
- 项目源不可用：该项目记录source unavailable，本轮不产生可claim候选，其它项目继续；
- scanner崩溃：下轮继续；利用run lock + detection dedupe避免重复；
- candidate-store损坏：隔离损坏文件并重建候选，不修改正式任务真值；
- Chat Wake 扩展/SSE即时入口不可用：不发送GitHub→Work事件；本机候选继续可靠保留，并降级为自适应巡检 + 手动聊天消费；
- ChatGPT自动任务不可用：候选仍可靠排队，用户手动打开ChatGPT后同样可以消费；
- 任一降级都必须在看板/日志中可见，禁止显示“自动认领正常”掩盖触发器失效。

#### 10.4.10 UI与可观测性

看板增加轻量“自动检测”状态，不占主任务卡主要空间。至少显示：

- 本机巡检：已安装/未安装/异常；
- 最近一次扫描时间与耗时；
- 下一次预计扫描；
- 当前候选数量、最高优先候选；
- 候选为何可认领/为何被阻断；
- ChatGPT消费模式：仅聊天模式；每小时/手动兜底 / 聊天事件触发已验证 / chat-only入口不可用；
- 最近一次ChatGPT消费/claim结果；
- “检测到”与“已认领”必须是两个不同状态，禁止混淆。

#### 10.4.11 安全边界

- 仍只扫描`projects.json`白名单项目；
- 项目路径继续做realpath/reparse/junction保护；
- 扫描器只读项目业务源码和任务证据，不读取/输出密码、Cookie、Token、私钥；
- 本机候选队列不允许携带用户凭据；
- 计划任务脚本不得接受任意命令拼接或任意项目绝对路径参数；
- 安装/卸载计划任务之外不要求管理员权限；
- scanner不得kill任何未知Node/PowerShell/浏览器进程。

#### 10.4.12 交付分层

B-10-AUTO按以下层级交付，不允许把前一层完成冒充后一层完成：

1. **L1：10分钟本机巡检**——Windows计划任务稳定执行并生成持久候选；
2. **L2：ChatGPT认可/消费合同**——ChatGPT能读取候选并重新核对后合法claim；现有每小时自动任务作为兜底；
3. **L3：即时事件触发**——只允许普通聊天模式；0.6.4 本机 SSE + Chrome Chat Wake 扩展已完成真人普通聊天 ACK 与同版本重载 `dispatcher_epoch` 接管验证并登记 `enabled_verified`；GitHub→Work路径继续停用；
4. **L4：独立测试与用户验收**——验证重启、断线、重复扫描、并发、stale候选、角色独立性以及页面可读性。

当前 L1/L2/L3 已有 0.6.4 开发证据；下一步由独立 test_ai 复测重启、断线、版本不一致、长回复、同版本扩展重载、重复候选与角色隔离。若未来 Chat Wake 健康检查失效，页面必须立即降级显示“即时唤醒未验证/不可用”，不得沿用历史 ACK 继续显示正常。


## 11. 并发与写入安全

页面和AI共用一个写入层：

1. 读取注册表revision和SHA；
2. 更新必须带expected revision/SHA；
3. 任务ID唯一；
4. 只修改目标任务行/受控字段；
5. 临时文件+原子替换；
6. API和CLI共用同一文件互斥；
7. 版本冲突返回409并重新读取；
8. 前端不能提交整份Markdown；
9. 用户评论append-only；
10. 冲突时不丢用户输入。

这里只保证**任务看板写入层**并发安全，不得宣传为覆盖Shell/所有AI文件写通道的全项目硬锁。

### 11.1 Registry + Event 可恢复事务日志

一次用户/AI写操作往往同时修改项目任务注册表并追加B-10事件日志，两者跨目录，不能假装是单文件原子事务。第一版必须增加：

`D:\WyerpTaskboard\data\runtime\transactions\<operation_id>.json`

所有有副作用的UI/CLI/API操作都要求稳定的 `operation_id` / `idempotency_key`。建议恢复协议：

1. **prepare**：持久化journal，记录projectId/taskId、expected registry SHA/revision、预期新状态/优先级、目标event及其hash；
2. **registry write**：用expected SHA + 临时文件原子替换项目注册表；
3. **event append**：带相同operation_id追加事件并持久化；
4. **commit**：journal标记commit或转入已完成索引；
5. 客户端以同一operation_id重试时，如果已commit直接返回原结果，不重复生成“通过/打回/改优先级”等事件。

服务启动时扫描未commit操作：

- registry未变且event不存在：可安全重试/取消prepare；
- registry已达到journal记录的新SHA但event缺失：根据journal补写同operation_id事件；
- registry与event都已落但commit缺失：补记commit；
- 出现event存在但registry与预期前后SHA都不匹配、外部并发改写等异常状态：**禁止自动猜测覆盖**，将该项目置为“事务一致性异常/写入阻断”，要求人工或恢复工具处理。

这叫**crash-recoverable consistency**，不宣传为跨两个目录的物理原子事务。journal自身需要fsync/可靠落盘策略、损坏检测和定期清理已commit记录。

## 12. 独立服务API草案

这些接口由 `127.0.0.1:47831` 的B-10服务提供，不进入ERP `server.js`：

- `GET /api/projects`
- `GET /api/projects/:projectId/tasks`
- `GET /api/projects/:projectId/tasks/:taskId`
- `PATCH /api/projects/:projectId/tasks/:taskId`
- `POST /api/projects/:projectId/tasks/:taskId/claim`
- `POST /api/projects/:projectId/tasks/:taskId/events`
- `POST /api/projects/:projectId/tasks/:taskId/review`
- `POST /api/projects/:projectId/tasks/:taskId/stop`
- `POST /api/projects/:projectId/tasks/:taskId/resume`
- `GET /api/projects/:projectId/tasks/:taskId/history`

所有写接口要求B-10自己的认证会话、CSRF/Origin/Host校验、body限制、projectId/taskId白名单、expected revision、中文错误、审计和 `Cache-Control: no-store`。

## 13. 实时刷新

参考dashi-taskboard2的实时更新思路。第一版优先SSE或现有轻量事件机制；风险较大时先5秒轮询。断线重连后必须重新读取完整权威状态，不用前端缓存冒充当前状态。

## 14. dashi-taskboard2参考融合

参考目录：

`D:\wangyan-erp-v2\open-source-reference\dashi-taskboard2`

已核对：

- Codex Taskboard；
- **Apache License 2.0**；
- React/Vite + Node + Tauri，另有SQLite/Cloud模式；
- README说明同一HTTP API服务UI和 `taskctl` CLI；
- Skill强调in_progress → 验证 → in_review，只有用户明确接受后才done；
- 有优先级、状态列、拖拽、任务详情、评论、conversation refs、Codex thread绑定、运行进度、乐观版本；
- 多客户端变化可刷新。

### 14.1 借鉴

- 看板+列表；
- 状态列；
- 优先级编辑；
- 任务详情/评论；
- 会话绑定；
- 运行中展示；
- 乐观并发版本；
- UI和CLI共用业务接口；
- 用户明确接受才最终完成；
- 实时刷新；
- actor identity；
- 完成/归档筛选。

### 14.2 不照搬

- React/Tauri；
- CDP注入；
- Cloudflare/D1/R2；
- SQLite作为本项目任务真值；
- dashi自己的7态状态机；
- Git branch/worktree必选。

B-10作为独立服务可以根据实现成本选择原生HTML/JS或轻量前端框架，但**不得要求ERP切换前端技术栈**。ERP继续保持自己的HTML/CSS/JS、权限和业务状态模型；两者只通过项目文件/独立CLI协议发生治理层交互。

若实施时复制Apache-2.0代码或资源，必须履行许可证/版权/修改说明义务；只参考交互/数据模型也在开发报告注明来源。

## 15. 实施阶段

### R1｜Adapter / Workflow Profile / Track + 注册表规范化
先固定核心接口与 `markdown-task-registry-v1`、`wyerp-ai-flow-v1`、`product/infrastructure` track语义；给ERP总清单增加机器边界和规范化字段。第一版可以只支持这一组可写profile，但核心不得硬编码ERP状态机。

### R2｜解析器 + 可恢复写回
实现任务索引、SHA/revision、原子registry替换、events分段日志、operation_id/idempotency、transaction journal/WAL恢复、409冲突、备份/损坏检测和单测。

### R3｜独立服务/API/认证/进程身份
实现 `127.0.0.1:47831` 服务、独立loopback认证、状态/优先级、评论/审阅、stop/resume、history、Origin/CSRF/审计；实现严格start/stop/status身份确认和端口/PID误杀负向保护。

### R4｜独立Web看板
实现首页、项目选择、汇总、看板、列表、筛选、详情、会话、计划/断点/报告、审阅、优先级和启停；提供桌面/开始菜单快捷方式方案。

### R5｜AI CLI与规范接入
claim/guard/change/test/release；开发修改后回写；测试开始/结束回写；会话窗口必填；更新AGENTS、开发/测试规范、中央流转和交付规范。

**B-10验收前仍按现行Markdown手工流程。B-10验收后可以把taskctl/guard升级为合规AI的必经协作流程，但在Runner/WebCodex未统一拦截所有写入/测试入口前，它仍属于cooperative enforcement，不得宣传为不可绕过硬门禁。**

### R6｜用户控制与打回闭环
通过、打回、HOLD、stop request/ack、resume、被打回重新认领、review revision/未读提示。

### R7｜实时刷新、故障隔离与完整验收
SSE/轮询、并发冲突、Edge、权限负向、多会话、ERP/B-10双向独立、单项目源离线/损坏隔离、transaction恢复、事件备份恢复和用户实际验收。

### R8｜本机10分钟巡检与ChatGPT触发桥接（B-10-AUTO / P0）

R8-A实现scan-store/candidate evaluator和可注入时钟的扫描核心；R8-B实现Windows计划任务安装/卸载/状态、不重入及 `test_chain / developer_watch / idle_suspended / re-arm` 自适应调度；R8-C实现ChatGPT候选消费合同、guard/claim复核、测试结束后的连续test_ai认领和每小时/手动兜底；R8-D仅在发现受支持触发能力后实现事件驱动ChatGPT唤醒与幂等；R8-E做独立测试、故障降级、重启恢复和用户页面验收。R8不得修改ERP启动链、不得把候选队列升级为任务阶段真值，测试AI也不得借连续处理切换成开发AI。


## 16. 测试计划

计划新增：

测试全部放在独立目录，例如：

- `D:\WyerpTaskboard\tests\task-store.test.mjs`
- `D:\WyerpTaskboard\tests\api.test.mjs`
- `D:\WyerpTaskboard\tests\service-independence.test.mjs`
- 必要Web/Edge测试；
- 独立项目自己的 `npm test` / `test:taskboard`，不得修改ERP `package.json` 来承载B-10测试。

最低验证包括：adapter/profile加载与不支持profile只读阻断、track排序、解析、未知/重复ID、profile合法/非法流转、用户通过/打回、HOLD/resume、stop request/ack、AI认领、独测独立性、修改/测试回写、报告路径、会话名称、stale revision 409、operation_id幂等、registry已写/event未写崩溃恢复、commit前崩溃恢复、异常不一致写阻断、页面与CLI并发、评论append-only、事件segment滚动/校验/恢复、独立认证、CSRF/Origin/Host、路径注入、项目root realpath、junction/reparse越界、loopback限制、项目白名单、其它Node占47831、非Node占47831、stale PID指向其它进程、筛选、刷新持久、断线恢复、总清单与页面一致，以及**ERP重启不影响B-10、B-10重启不影响ERP**。

B-10-AUTO最低测试还必须覆盖：计划任务安装/卸载/重复安装幂等、计划任务不重入；测试结束立即one-shot扫描并在存在下一项test_ai任务时连续认领；没有测试候选但存在开发任务时进入 `developer_watch` 并保持10分钟周期；测试AI不能因此认领开发任务；测试和开发任务均不存在时进入 `idle_suspended` 且不继续读取全部registry；新任务/需求拆解/状态回流/服务启动/手动scan能re-arm one-shot；re-arm后按结果恢复10分钟或继续休眠；可注入时钟下连续3轮扫描；无可执行任务不产claim候选、`待准备+开发AI`合法门禁通过时可生成developer candidate且claim进入开发中、其它待准备/待确认/HOLD不越级、待开发/测试失败待修复角色映射、待独测/待复测test_ai独立性提示、未读留言/stop/活动owner/Job/资源未知阻断、registry SHA变化使候选stale、候选去重/30分钟过期、项目源离线隔离、candidate-store损坏恢复、B-10服务离线时不写ERP真值、ChatGPT消费前强制重读、两个消费者竞争只允许一个真实claim、触发桥重复事件幂等、触发桥失败回退每小时/手动消费，以及扫描/触发全过程不得暴露密码/Token/Cookie。


## 17. 验收标准

至少满足：

- 在ERP完全停止的情况下，`http://127.0.0.1:47831` 仍可看到当前未收尾任务；
- 页面与总清单一致；
- 执行任务显示会话窗口名称；
- AI修改后页面可见修改事件和状态；
- 测试开始/结束后可见测试事件、结论和报告；
- 独测AI可从待独测/待复测合法认领并回写；
- 用户可改优先级、写意见、通过/打回、启停；
- 被打回任务重新可认领；
- 执行中停止必须AI确认和资源释放后才HOLD；
- 两个写入方并发不静默覆盖；
- 未通过B-10独立认证的访问看不到内部任务/会话；
- ERP `8765` 重启/停止不影响B-10会话和页面；
- B-10服务重启/停止不影响ERP；
- ERP完全不可启动，或 `8765` 被未知进程占用时，B-10仍正常启动/运行/审阅其它任务；
- 任一项目root/registry暂时不可访问时，B-10自身不崩溃，该项目显示“项目源不可用/只读阻断”，其它项目继续正常工作；
- projects.json ACL、realpath与junction/reparse-point越界保护通过负向测试；
- registry/event崩溃窗口可由transaction journal恢复，重复operation_id不产生重复通过/打回/优先级事件；
- 事件日志具备滚动、校验、备份和损坏恢复验证；
- start/stop/status不会误杀占用47831的其它Node、非Node或stale PID指向的其它进程；
- Windows本机存在可检查的`WyerpTaskboard-TaskScan（间隔可配置，默认10分钟）`调度载体；处于 `developer_watch` 时按10分钟周期运行，处于 `idle_suspended` 时不再执行完整registry巡检；重启/重新登录后先one-shot重算应处模式；
- 测试AI完成并释放当前测试任务后立即刷新候选；若存在下一项可认领test_ai任务，不等待10分钟即可继续合法认领；
- 当前无测试候选但仍有开发任务时，10分钟周期继续；测试和开发任务都不存在时周期巡检休眠；
- 新任务/需求拆解/状态回流、服务启动或手动scan能重新触发一次检查，并根据结果恢复 `developer_watch` 或继续 `idle_suspended`；
- 在任务从不可认领变为可认领后，受控写入/re-arm应立即one-shot生成候选；只有缺少受支持事件源的外部直接Markdown写入才允许等到下一次手动/启动检查，且必须明确此边界；
- 没有满足条件的任务时不产生虚假claim；`待准备+plannedRole=开发AI` 仅在全部门禁通过时可认领，其他待准备、`待确认/HOLD/已完成/已取消`不会被扫描器越级认领；
- 本机候选只作为ChatGPT复核入口，不能直接改变任务阶段、负责人、会话、测试结论或用户验收；
- ChatGPT消费候选时会重新读取Markdown正式真值、guard、资源与独立性；候选过期或版本变化时拒绝使用；
- 同一候选被重复扫描、重复触发或多个消费者同时处理时，不产生重复claim；
- test_ai候选仍执行真实独立性检查，扫描器不能通过改actor/session名称绕过；
- Chat Wake 健康检查/真实 ACK 未验证时，页面必须明确显示“即时唤醒未启用/未验证”；0.6.3 已取得普通聊天真实 ACK，独测需复核失效时能正确降级；
- 只有真实触发回执 + ChatGPT实际消费记录都存在时，才允许显示“检测到即可触发ChatGPT”；触发成功仍不等于claim成功；
- Windows计划任务、扫描器、触发桥任一故障都不影响ERP/B-10主体运行，也不得修改未知进程或项目业务状态；
- 用户本人Edge验收通过。

## 18. 第一版不做

不做私有 ChatGPT/Codex API 会话创建、强杀ChatGPT窗口、暴露平台私有数据、自动Git分支、公网多人项目管理SaaS、普通ERP租户协作、附件审阅、甘特图、自动完成时间预测、LLM猜百分比，也不以SQLite/PostgreSQL替换各项目总清单作为状态真值。允许 Chat Wake 浏览器扩展在**普通 ChatGPT**中按角色复用或新建聊天会话；该能力不得切换到Work，也不得绕过模型/推理强度、版本、guard或claim门禁。第一版**不嵌入ERP、不依赖ERP登录、不由ERP启动脚本管理**。

## 19. 实施建议

B-10是 **`track=infrastructure / P0`**，建议尽早并行实施；其中 **B-10-AUTO 由用户明确指定为当前 infrastructure 轨道最高优先级子任务**。P0只表示基础设施轨道内最高优先级，不把B-10-AUTO伪装成`product`，也不得强抢已被合法执行者持有的资源；跨track仍遵守产品阶段与资源规则。

它不是商品/订单/公网业务硬门禁：B-10未完成不阻塞A-01/A-07等业务，但越早完成，用户越少需要跨会话询问。**实施项目必须建立在 `D:\WyerpTaskboard` 或用户后续指定的其它独立根目录，并使用独立端口/进程；禁止回填进erp-x20业务代码。** B-10正式独测和用户验收通过后，可以把“每次修改/测试必须通过独立看板服务回写”设为合规AI的强制协作流程；在Runner/WebCodex未实现不可绕过lease/guard前，仍必须标注为cooperative enforcement，不能宣称物理硬停止/硬写锁。

## AI自动执行设置（v0.6.3）

- 看板顶部提供“AI自动执行设置”按钮，以弹窗方式配置，不占用任务看板正文空间。
- 设置真值文件：`config/ai-execution.json`。
- 当前默认：开发AI=`GPT-5.6 Sol / high`；独立测试AI=`GPT-5.6 Sol / high`；扫描间隔=10分钟；单聊天最大自动请求=20；上下文预警=15；超时自动重试=3；异常统计窗口=10分钟；窗口异常熔断=6；同角色连续换会话熔断=3。
- 扫描间隔保存后仅在分钟数变化时重建 Windows 计划任务 `WyerpTaskboard-TaskScan`；计划任务更新失败时不持久化新的扫描间隔。
- Windows 周期计划任务必须通过 `wscript.exe //B //Nologo` + `scripts/run-hidden.vbs` 无控制台启动；禁止直接以 PowerShell 作为计划任务动作，避免 `-WindowStyle Hidden` 仍出现瞬时闪屏。
- Chat Wake 每条候选开始前读取同一份设置，自动提示携带 `required_model`、`required_reasoning_effort`、动态聊天上限和恢复阈值。
- 当前聊天模型或推理强度不满足设置要求时，AI不得 claim；应提示用户手动切换后再继续。
- 浏览器扩展不会模拟点击 ChatGPT 的模型/推理强度选择器，也不会虚报已切换成功。

## 项目服务一键控制（v0.6.3）

- 看板在当前项目状态下方显示“项目服务”控制行。
- 当前 WyerpTaskboard 项目支持“启动 / 重启”和“一键关闭”。
- “启动 / 重启”在服务运行时执行严格身份校验后的安全重启；未运行时执行启动。
- “一键关闭”只允许关闭严格身份匹配的当前 WyerpTaskboard 正式服务；端口冲突、身份不匹配或身份未知时拒绝操作。
- 重启/关闭由独立、隐藏、延迟启动的 `cli/service.mjs` 控制进程执行，HTTP 先返回 202，再执行自停/重启，避免请求被自身退出截断。
- 状态接口只返回 PID、端口、启动时间和身份校验结果等安全字段，不向网页暴露 instance token。
- WyerpTaskboard 自身完全关闭后，网页后端不存在，因此无法依靠同一网页重新启动；重新启动需使用本机启动入口。为避免额外常驻后台服务，不增加第二个常驻控制进程。
