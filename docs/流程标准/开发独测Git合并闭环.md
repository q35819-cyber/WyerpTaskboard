# 开发、独测与 Git 合并闭环（唯一标准）

## 固定流程

`待开发 → 开发中 → 待独测 → 独测中`

- 独测 FAIL：`测试失败待修复 → 修复中 → 待复测 → 复测中`，退回原开发负责人；修复后必须重新独测。
- 独测 PASS 且要求代码合并：`待交付 → 交付中 → 已完成`。独测结果必须通过 `--commit-sha` 和 `--branch` 把 PASS 绑定到实际测试的唯一候选提交。
- 独测 PASS 且无需代码交付：只有明确标记为 `user_ui_business` 的任务进入待用户验收；未显式标记的任务默认 `system` 并自动完成。为兼容旧任务，已处于`待用户验收`或历史测试事件明确记录`user_acceptance`的任务保留用户验收范围；不得再按 product/bugfix/infrastructure track 推断验收范围。
- 不允许跳过自测、独测、正式认领或 Git 交付门禁。

## 责任边界

1. **开发 AI**：领取、实现、自测、提交候选 SHA；独测 PASS 后仍由原开发 AI 负责合并、推送、合并后回归和最终关闭。
2. **独立测试 AI**：独立领取，从测试起点复测；test-result 必须沿用正式 claim 时相同的 actor-id 和 Session；PASS 必须绑定唯一候选 commit SHA、分支、报告和交付动作；FAIL 退回原开发。
3. **总控**：分配下一步、检查阻断原因和超时恢复；不代替开发或独测，不新增常设集成角色。
4. 用户不负责手工对版本、挑提交或催促代码合并。

## 独测 PASS 的固定提交方式

代码合并任务的独测 PASS 必须由原测试 Session 提交，示例：

```powershell
node cli/taskctl.mjs test-result --project <项目ID> --task <任务ID> --result pass --report <独测报告路径> --actor-type test_ai --actor-id <正式claim时的actor-id> --session-id <正式claim时的Session> --delivery-mode required --delivery-actions candidate_merge --commit-sha <本轮实测候选SHA> --branch <本轮实测分支>
```


## 唯一交付命令

开发 AI 在`交付中`阶段完成以下事项：

1. 合并独测 PASS 绑定的候选 SHA 到 origin 默认分支。
2. 推送远端。
3. 切换到 origin 默认分支，确认本地 HEAD 与远端默认分支 SHA 完全一致。
4. 在合并后的版本上执行项目回归。
5. 写一份项目内回归报告，至少包含：

```text
结论：PASS
候选SHA：<独测通过的 commit SHA>
main SHA：<合并后远端默认分支 SHA>
```

随后执行：

```powershell
node cli/taskctl.mjs complete --project <项目ID> --task <任务ID> --actor-id <原开发actor-id> --session-id <原开发Session> --report <合并后回归报告路径> --note "已合并推送并完成合并后回归"
```

服务端会自动核验：

- 当前任务仍处于`交付中`，且调用者的actor-id和Session都与最初开发交接、正式交付认领一致。
- 最新独立测试结果为 PASS，交付动作包含`candidate_merge`，且绑定候选 SHA。
- 独测 PASS 后没有代码变更或新的测试结果使其失效。
- 当前本地分支是 origin 默认分支，本地 HEAD 与远端 SHA 完全一致。
- 独测候选 SHA 确实是远端默认分支的祖先。
- 合并后回归报告存在于项目目录内，含明确 PASS、候选 SHA、main SHA，并记录 SHA256；工作区除本次新报告外必须干净，报告不能复用旧的已提交文件。

全部通过后，服务端一次性把任务置为`已完成`、释放负责人和 Session，并记录完整交付证据。任一条件不满足，任务保持`交付中`并返回明确阻断原因，不允许伪造完成。交付完成必须由原开发actor-id和原Session执行；`待交付`候选同时携带原开发actor-id/Session，其他开发AI不得代领。

## 交付失败记录与恢复

- `待交付`只能由原开发actor-id和原Session正式认领；看板拒绝其他开发AI认领，自动候选也必须携带这两个身份字段。
- merge、push、remote_sync、regression、report或verification步骤失败时，原开发AI必须调用：

```powershell
node cli/taskctl.mjs delivery-failed --project <项目ID> --task <任务ID> --actor-id <原开发actor-id> --session-id <原开发Session> --failure-stage push --failure-code <错误码> --note "失败原因" --next-action "明确下一步"
```

- `taskctl complete`的服务端核验失败会自动追加`delivery_attempt_failed`事件；不需要开发AI再手工重复登记。
- 失败登记不得改变`交付中`状态或释放负责人/Session；看板详情必须显示失败阶段、错误码、原因和下一动作，由原开发AI继续处理。
- 重新尝试时仍由原开发AI执行；修复候选代码会使旧独测PASS失效，必须回到自测和独测流程。

## 禁止事项

- 不设置独立集成开发角色；不把合并责任转交给总控或用户。
- 不允许通过普通 PATCH/transition 直接关闭交付任务。仅 taskctl complete 完成 Git 远端核验与合并后回归后，系统才按 acceptanceScope 自动选择待用户验收或已完成。
- 不允许独测 PASS 后继续修改代码而复用旧 PASS；代码变化必须重新独测。
- 不允许只凭本地 commit、PR 已创建、任务状态或口头报告宣称已合并。
- 不允许在没有远端 SHA 和合并后回归证据时关闭任务。
- 不允许长期停留在`交付中`；失败必须显示阻断原因并由原开发负责人继续处理。

## 流程验收

必须覆盖：正常开发→独测 PASS→原开发身份认领交付→候选合并→远端核验→合并后回归→自动关闭并释放占用；独测 FAIL 回流；错误开发身份/Session认领被拒绝；交付失败原因持久化且负责人不释放；complete核验失败自动登记阻断；PASS 后代码变化失效；候选未合并拒绝关闭；远端 SHA 不一致拒绝关闭；缺失/伪造回归报告拒绝关闭；普通状态修改绕过门禁拒绝。
