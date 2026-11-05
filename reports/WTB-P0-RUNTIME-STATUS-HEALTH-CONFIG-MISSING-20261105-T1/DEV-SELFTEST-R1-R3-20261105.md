# WTB-P0-RUNTIME-STATUS-HEALTH-CONFIG-MISSING-20261105-T1｜开发 R1–R3 自测报告

## 任务和身份

- 原因：正式运行的 `GET /api/runtime/status` 因缺少 `config/chatgpt-health.json` 返回 HTTP500；非核心健康监控配置导致整体状态接口失效。
- actor: `wtb-dev-runtime-health-20261105-27d92cc0`
- 正式开发 Session: `wc_sess_27d92cc0c86d411cb09b289458675039`
- claim: `evt_4525ec7939b3003685b97085`；代码变更事件：`evt_50158994ee3f87a8315deee4`。
- 原独立 worktree 基线 `origin/main`: `9a13bf0381114f373f27aae542c47c4ab39425bb`，保护主目录及其它开发未提交成果。
- 本报告为**开发自测**，不代表独立测试或正式发布。

## Ponytail full / 最小代码和调用关系

- 已读项目 `.agents/skills/ponytail/SKILL.md`（full）、AGENTS/WORKFLOW、唯一开发入口和本 P0 任务计划。
- 原 HTTP GET 路由位于 `server/http-server.mjs`，调用 `TaskboardRuntimeStatus.snapshot()`；原异常源头是 `ChatgptHealthMonitor.init()` 读取不存在的健康配置。
- 仅修改 `server/runtime-status.mjs` 和 `tests/runtime-status.test.mjs`，不更改旧健康监控、HTTP 路由、配置、服务启动逻辑，不新增依赖。
- 仅对 `ENOENT` **且异常路径明确等于** `config/chatgpt-health.json` 的情况返回 `{version:1,state:"not_configured",healthy:false,checked_at:null}`；损坏 JSON、非法版本或其他读取错误仍抛出，不假报 healthy；不自动创建缺失配置。
- 最终代码与测试 diff：2 个文件，67 insertions、1 deletion；只扩充原测试，复用既有 HTTP server 与 fixture，不另造平台。

## 三轮真实验证

- **R1 正向**：`node --test tests/runtime-status.test.mjs`，exit **0**，**8/8 PASS**。包含真实临时 HTTP 服务 `GET /api/runtime/status=200`、`GET /healthz=200`、`chatgpt_health.state=not_configured`、`healthy=false`，并且配置文件保持不存在。原正常配置与其它运行统计测试未退化。
- **R2 负向**：`node --test --test-name-pattern "R2:|R1/R2:" tests/runtime-status.test.mjs`，exit **0**，**2/2 PASS**。配置损坏时真实 HTTP500；JSON 语法损坏和不支持的版本仍抛异常，原文件未被覆盖。
- **R3 整仓兼容**：`npm.cmd test`，job `efd39daa-9a4e-4873-8756-72f8c7db2e1f`，exit **0**，**58 个测试文件，0 失败**，duration 248089 ms；`data/runtime/validation/npm-test.json` `state=passed`。
- `npm.cmd run check`，job `d6f9bd73-9acf-439f-a3b8-766d8b68ff66`，exit **0**；`git diff --check` exit **0**。
- 代码候选 SHA 在本次提交推送及正式事件中固定；开发自测命令均针对上述代码，报告本身不改变运行代码。

## BUG 三问及后续责任

1. **问题解决了吗？** 当前独立候选源码及真实 HTTP 测试已证实“缺健康配置导致整个运行状态500”被修复；**主线部署未完成，正式生产接口尚不能称修复成功**。
2. **会不会再复现？** 已补缺配置正向与坏配置负向真实 HTTP 回归；同样条件合并后仍需总控重新验证运行服务，以防环境/部署版本差异。
3. **后续流程正常吗？** 开发自测与原服务兼容均 PASS；**必须由唯一独测独立验证冻结候选，独测 PASS 后由总控串行合并、部署、真实运行版 HTTP 复测及正式关闭**。关联本任务未完成独测/发布时不得宣称全闭环。

**排除范围**：不自动生成 `chatgpt-health.json`、不唤醒/启动健康监控、不改其它P0与旧已完成任务、不清理任何其他 AI 工作区。
