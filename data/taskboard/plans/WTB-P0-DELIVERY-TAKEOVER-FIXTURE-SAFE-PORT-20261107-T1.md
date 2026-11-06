# WTB-P0-DELIVERY-TAKEOVER-FIXTURE-SAFE-PORT-20261107-T1｜独测失败的随机禁止端口夹具最小修复

> 开发预备计划，**尚未由正式总控创建/派工**；源任务不得擅自扩权或覆盖其已独测失败候选。

## 根因与证明
来自已存在的 `WTB-P0-TAKEOVER-BLOCK-AUTO-RECOVERY-20261106-T1` 唯一独测 FAIL 事件 `evt_620d079a2fadefceb6b0cca4`。独测 R1/R2 PASS，但 R3 两次整仓失败，均因 `tests/delivery-takeover.test.mjs` 直接监听随机端口0，命中 Node fetch 禁止端口产生 `ERR_UNSAFE_PORT/bad port`。该问题属于测试夹具基础设施，而非原自动解阻业务源码，必须独立 BUG 修复，不能重开已完成的其它安全端口任务。

## 最小功能
只允许修改 `tests/delivery-takeover.test.mjs`：随机端口监听后主动 HTTP probe，仅 `error.cause.message === "bad port"` 时有界重试最多10次，每次重试先关闭旧socket；其它网络错误立即失败；为所有成功/失败路径注册测试清理回调。禁止修改 `server/`、`scripts/run-tests.mjs`、原待修任务已冻结SHA、main及其他AI工作区。

## 验收
R1：新定向假bad port后重试成功，可通过真实fetch；R2：非bad port只请求一次并失败、10次bad port后失败、监听及时释放；R3：原文件14项及整仓61文件0失败、npm run check和diff --check通过。首次失败证据保留，独测重新在隔离clean SHA验证，唯一总控负责后续合并。生产BUG任务需正式派工与合法D01–D09，开发WIP不等于已交独测/合main。

## 相关任务
- 原QA失败：`WTB-P0-TAKEOVER-BLOCK-AUTO-RECOVERY-20261106-T1`
- 已完成独立端口修复（不得改）：`WTB-P0-HTTP-FIXTURE-SAFE-PORT-20261104-T1`、`WTB-P0-TASKCTL-FIXTURE-SAFE-PORT-20261104-T1`
