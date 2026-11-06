# WTB-P1-BOARD-DEPENDENCY-LONG-ID-LAYOUT-20261106-T1｜开发自测与交接证据（候选）

## 权限、主线、范围
- 用户已提出UI验收BUG：多级前置路径中长编号撑乱排版。正式总控派工 evt_d8ee02dfcbbe92f14c8c5b6d，正式preclaim evt_5636e79f6d877a03b3d4a2f8，claim evt_0c16deffb1f94b229ef98d08。
- 开发actor wtb-dev-dependency-long-id-20261106-n1，Session wc_sess_f84557a927c54864ada9999cd2cd1958。独立worktree wyerptaskboard-b812d859，分支 fix/WTB-P1-DEPENDENCY-LONG-ID-LAYOUT-20261106-N1，基线origin/main 355137f33ff7401d6c47e30a1659988aa43e829a，脏主线不动。
- 仅修改 web/app.js、web/index.html、web/styles.css、tests/board-static-assets.test.mjs；不修改已有已完成多级任务、API、依赖解析、状态机及其它开发成果。Ponytail full最小变更。

## 功能
- #taskDialog 标题区域设可收缩容器；编号独占一行、CSS nowrap+ellipsis；标题单独一行并正常折行；关闭按钮至少40px，不受编号撑宽影响。
- 访问路径以列排列，每个ID独占一行，超长只视觉省略；纵向可滚，最大175px，窄屏140px；返回上级按钮独行，至少40px。卡片前置链接列排并分开计数，任务卡编号超长视觉省略。
- 所有完整编号仍留在textContent/title、按钮aria-label和ref.id/openTask参数中；不执行字符串切断，保留原多级返回、分支、环路保护和项目epoch时效。

## 三轮真实验证
- R1：在 **worktree当前工作目录**执行 node --test tests/board-static-assets.test.mjs；10/10 PASS exit0。新增结构检查覆盖标题ID独行、overflow ellipsis、垂直路径滚动、窄屏样式及按钮最小40px。
- R2：同一次专项实际检查10/10 PASS，包含完整ID的按钮文本、title、aria-label、真实click传完整ID、4层以上路径、返回分支/项目切换/环路和原BUG角标。第一次测试误从主线cwd读取web失败，后来用真实worktree cwd修正并重跑PASS。
- R3：默认整仓脚本在隔离worktree cwd运行，Job 62b799e1-3d8e-41ef-84aa-b9b9febe18fc，**61个测试文件、failedFiles=0、退出码0、durationMs=330474，PASS**。实际从本隔离worktree cwd运行，不是主仓。
- Headless Chrome真实布局：通过独立临时profile加载实际CSS并设置等效320px视口的292px弹窗；浏览器测得dialog 292px、header scrollWidth 292px、dialog scrollWidth 292px，无水平溢出；长ID scrollWidth 528px > clientWidth 214px，确实视觉省略；路径scrollHeight > clientHeight，返回按钮41px、关闭按钮40px。Chrome headless最小窗口实际500px，故以292px弹窗进行等效检查；仍需独测和用户真实移动端UI验收。

## BUG三问（开发候选阶段）
1. 解决了吗？CSS/DOM候选已按唯一目标完成，专项测试PASS；整仓R3已PASS，仍需独测及总控部署。
2. 会复现吗？已加入超长ID与逐级导航回归，并使用CSS ellipsis而非真字符串截断；但移动端真机和未知浏览器需后续UI验收。
3. 后续正常吗？原任务已交QA，当前任务 D01-D06真实PASS；R3已PASS，唯一独测与总控合并后才能确认部署正常。

## 交接
- R3已零失败；报告和候选SHA固定、远端验证后执行D07、test_result、D08正式交唯一独测。开发不得代独测、合main或关单。
