# WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1｜R4 最小修复开发三轮自测 2026-11-02

## 目标与裁决
- 核心交付：仅传任务编号，跨项目定位唯一任务并输出主计划、状态/角色、断点/关联安全路径、历史和下一动作；复用原有HTTP及三角色工作流。
- 正式最新总控裁决：evt_1101ff3ae9100951c4d0bf10；只对既有R4真实FAIL“API Key: ...”“OpenAI API Key: ...”最小修复。其它推测格式、新安全平台、新架构、全仓模拟器不得作为本任务新FAIL门槛。
- 原独测R4 FAIL：evt_0d5adfed518fe661884e18c1，QA报告reports/WTB-P1-DELIVERY-TASK-RECOVERY-20261031-T1/QA-MINIMAL-20261102.md SHA256=89cd918ef4eba78e69b14c4a3708f9a754b6adf1c81cf100838b828ebe22618d，旧远端候选9458dde6f8c450722e1ed7af46424b4a9a7b0b98。
- 同一原开发actor wtb-dev-p1-recovery-20261101-59558da5；原Session wc_sess_59558da53899414cb784e68bfbecb624。R4重新认领事件evt_f10faf28f7186327cde94b80，新test-start事件evt_32964351598c9e5c8d5f7887。

## Ponytail full：原代码复用与精确变更
- 已实际读取Ponytail Skill、WORKFLOW.md、开发AI.md及最新正式计划；检查唯一输出边界contextOutput()的调用方taskContext()/原有taskctl context及tests/taskctl.test.mjs；不增加其它入口。
- cli/taskctl.mjs：仅在原有contextOutput正则中把api[_-]?key扩展为(?:openai[ ]+)?api[ _-]?key，可遮蔽独测复现的两种带空格API Key写法；原JSON/下划线/中划线写法不改变。
- tests/taskctl.test.mjs：现有真实本机HTTP服务+真实CLI执行的context用例新增2个虚构标记“API Key: SYNTH_SPACE_KEY_08”“OpenAI API Key: SYNTH_OPENAI_SPACE_09”与两项不可回显断言；同时确认普通任务正文与历史仍可读取。
- 与前一候选差异：仅2文件+6/-3行（1行生产代码改写，其余为测试标记与断言）。新增依赖、模块、权限、状态、网络接口、数据库：均为0。
- 旧27文件实现未混入分支，历史远端归档archive/wtb-p1-old-pre-redesign-20261102 SHA=4f24caefbcac1e706d11d0e3ced0d58b9c18155b；其它未跟踪缓存和tests/evidence均未删除/提交。

## 同一源码下三轮真实测试（PASS）
1. 功能与现有CLI兼容：node --test tests/taskctl.test.mjs；25/25 PASS、0 FAIL、exit=0；真实Job 3fe01770-358e-49d2-b299-9c3b4ac14ef9 completed。
2. 语法、HTTP、跨项目注册回归：npm.cmd run check exit=0；node --test tests/http-server.test.mjs tests/project-registry.test.mjs 50/50 PASS、0 FAIL、exit=0。
3. 独测R4缺陷及核心负向：node --test --test-name-pattern="taskctl context" tests/taskctl.test.mjs；3/3选中用例PASS、0 FAIL、exit=0；其它非匹配用例未执行（已由第一轮覆盖）。验证两个新标记、原7类合成标记均未回显，普通正文及越界、缺失/重复编号行为正确。

git diff --check exit=0；变更严格在原分支feat/wtb-p1-minimal-id-context-20261102。当前源文件SHA256：cli/taskctl.mjs=36519f3a9793ce9d8472afe35914363177ff0bb602046451be4e54f76676fde2；tests/taskctl.test.mjs=18bee22ded16d20ba6cb09722ac8005515c97e55dea0b16fb78dd184e10c6045。

## 下一步与风险
- 本报告与两份源文件提交到同一候选分支、推送远端后再核对候选SHA、报告Git blob SHA256；正式开发test-result PASS、原子handoff到唯一独测AI；未获独测PASS前禁止合入main/关闭。
- 遗留限制：脱敏仅覆盖任务正式验收内的已知格式，并非全格式隐私扫描器；新安全需求必须经总控裁定。本报告只声明开发自测，不代表独测结果。
