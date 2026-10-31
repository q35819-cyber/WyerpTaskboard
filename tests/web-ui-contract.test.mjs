import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const root = "D:\\WyerpTaskboard";

test("web UI merges developer pending and claimable states into one board column", async () => {
  const index = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const app = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.doesNotMatch(index, /id="developerCandidatePanel"/);
  assert.doesNotMatch(index, /id="developerCandidateList"/);
  assert.ok(app.includes("function developerCandidateFor(task)"));
  assert.ok(app.includes('["待开发","待准备"].includes(task.status)&&task.plannedRole==="开发AI"'));
  assert.ok(app.includes('candidate?.eligible===true?"待认领":"待处理"'));
  assert.doesNotMatch(app, /column.id==="claimable"/);
  assert.ok(app.includes("developerCandidates"));
  assert.match(app,/tasksForColumn\(state\.filtered,column\.statuses\)/);
  assert.match(app,/paginateColumn\(tasks,state\.columnPages\[key\],PAGE_SIZE\)/);
});

test("web UI persists the selected project so refresh does not silently switch away from ERP", async () => {
  const app = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.match(app,/PROJECT_SELECTION_KEY="wyerp-taskboard:selected-project"/);
  assert.match(app,/resolveProjectId\(state\.projects,state\.projectId,readSavedProjectId\(\)\)/);
  assert.match(app,/localStorage\.setItem\(PROJECT_SELECTION_KEY,projectId\)/);
  assert.match(app,/switchProject\(els\.projectSelect\.value\)/);
  assert.match(app,/state\.projectEpoch\+\+/);
});

test("web UI keeps direct progress columns, paginates three cards per column and exposes plan reader", async () => {
  const [html, app, css] = await Promise.all([
    fs.readFile(root + "\\web\\index.html", "utf8"),
    fs.readFile(root + "\\web\\app.js", "utf8"),
    fs.readFile(root + "\\web\\styles.css", "utf8")
  ]);
  assert.match(html, /id="planFilter"/);
  assert.match(html, /id="addRequirementBtn"/);
  assert.match(html, /id="requirementDialog"/);
  assert.match(html, /id="requirementList"/);
  assert.match(html, /id="archiveFilter"/);
  assert.match(html, /<select id="archiveFilter"><option value="all" selected>全部任务<\/option>/);
  assert.match(html, /id="relatedArtifactsText"/);
  assert.match(html, /id="planDialog"/);
  assert.match(html, /id="planNavigator"/);
  assert.match(html, /id="planIndexList"/);
  assert.match(html, /type="module" src="\/app\.js"/);
  assert.match(html, /id="taskPlanList"/);
  assert.match(app, /const PAGE_SIZE=3/);
  assert.match(app, /const USER_MESSAGE_PAGE_SIZE=3/);
  assert.match(app, /className="user-message-pagination"/);
  assert.match(css, /\.user-message-item\{[^}]*font-size:16px/);
  assert.match(app, /els\.boardView\.append\(col\)/);
  assert.match(css, /grid-template-columns:repeat\(6,minmax\(245px,1fr\)\)/);
  assert.match(app, /openPlan\(taskId,planIndex\)/);
  assert.match(app, /buildPlanIndex/);
  assert.match(app, /jumpToPlanLine/);
  assert.match(app, /已定位到第/);
  assert.match(app, /openDocument\(taskId,documentIndex\)/);
  assert.match(app, /function documentButton\(taskId,doc\)/);
  assert.doesNotMatch(app, /function documentButton\(taskId,document\)/);
  assert.match(app, /archive==="active"/);
  assert.match(app, /className="ai-reply"/);
  assert.match(app, /user-accept-event/);
  assert.match(app, /user-reject-event/);
  assert.match(app, /产品业务/);
  assert.match(app, /基础设施/);
  assert.match(app, /最高优先级/);
  assert.match(css, /\.column-pagination/);
  assert.match(css, /\.plan-document-content/);
  assert.match(css, /\.plan-index-item/);
  assert.match(css, /\.plan-line\.task-target/);
  assert.match(app, /startsWith\("当前无需你操作"\)/);
  assert.match(app, /renderRequirements\(\)/);
  assert.match(app, /async function refreshAll\(message=null\)\{[\s\S]{0,220}if\(await loadProjects\(\)===false\)return/);
  assert.match(app, /if\(await loadProject\(\)===false\)return/);
  assert.match(app, /await loadProjectServiceStatus\(\)/);
  assert.match(app, /待AI拆解/);
  assert.match(app, /requirement_create/);
  assert.doesNotMatch(app, /className="plan-group"/);
});

test("task detail exposes explicit low-risk auto-close authorization without merging delivery and user acceptance semantics", async () => {
  const [html, app] = await Promise.all([
    fs.readFile(root + "\\web\\index.html", "utf8"),
    fs.readFile(root + "\\web\\app.js", "utf8")
  ]);
  assert.match(html, /id="autoCloseAuthorizationStatus"/);
  assert.match(html, /id="authorizeAutoCloseBtn"/);
  assert.match(html, /id="revokeAutoCloseBtn"/);
  assert.match(app, /authorize_auto_close/);
  assert.match(app, /revoke_auto_close/);
  assert.match(app, /autoCloseAuthorization\?\.authorized/);
  assert.match(app, /待交付 \/ 待用户/);
});

test("user-facing static labels do not retain known English placeholders", async () => {
  const html = await fs.readFile(root + "\\web\\index.html", "utf8");
  for (const forbidden of [
    "WYERP TASKBOARD",
    "INDEPENDENT PROJECT GOVERNANCE",
    "LOCAL PROJECT",
    "Session与registry revision",
    ">停止 / HOLD<",
    "暂不继续 → HOLD"
  ]) {
    assert.equal(html.includes(forbidden), false, "仍存在用户可见英文：" + forbidden);
  }
  assert.match(html, /独立项目治理/);
  assert.match(html, /停止 \/ 暂停/);
  assert.match(html, /技术会话ID与任务表版本/);
});

test("user message panel is immediately before history area in task detail", async () => {
  const html=await fs.readFile(root+"\\web\\index.html","utf8");
  const messageIndex=html.indexOf('id="userMessagePanel"');
  const historyIndex=html.indexOf('<h3>历史事件</h3>');
  const reviewIndex=html.indexOf('<h3>我的审阅意见</h3>');
  assert.ok(messageIndex>reviewIndex,"用户留言区必须放在审阅区之后");
  assert.ok(messageIndex<historyIndex,"用户留言区必须位于历史事件前");
});

test("AI replies display the actual developer/test role and preserve a historical fallback", async () => {
  const app=await fs.readFile(root+"\\web\\app.js","utf8");
  assert.match(app,/REPLY_ACTOR_LABELS=\{developer_ai:"开发AI回复",test_ai:"测试AI回复"\}/);
  assert.match(app,/if\(!normalized\)return "AI回复（历史）"/);
  assert.match(app,/replyActorLabel\(reply\.actorType\)/);
  assert.doesNotMatch(app,/replyHead\.textContent="AI回复 · "/);
});
test("task cards stamp the latest replied user message as visibly replied", async () => {
  const [app, css] = await Promise.all([
    fs.readFile(root + "\\web\\app.js", "utf8"),
    fs.readFile(root + "\\web\\styles.css", "utf8")
  ]);
  assert.match(app, /latestUserMessage\?\.replied/);
  assert.match(app, /className="reply-stamp"/);
  assert.match(app, /textContent="已回复"/);
  assert.match(css, /\.reply-stamp\{/);
  assert.match(css, /transform:rotate\(-\d+deg\)/);
  assert.match(css, /border:\d+px solid/);
});

test("automatic scan status is visible in Chinese and kept outside task cards", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  const css = await fs.readFile(path.join(root, "web", "styles.css"), "utf8");
  assert.match(html, /id="scanStatus"/);
  assert.match(js, /自动检测：/);
  assert.match(js, /intervalMinutes\+"分钟计划任务已安装"/);
  assert.match(js, /intervalMinutes\+"分钟计划任务已停用"/);
  assert.match(js, /即时唤醒未启用/);
  assert.match(js, /普通聊天浏览器桥待验证；GitHub→Work桥已停用/);
  assert.match(js, /GitHub备用桥异常，普通聊天浏览器桥状态待确认/);
  assert.match(js, /即时触发已验证/);
  assert.match(js, /\/api\/task-scan\/status/);
  assert.match(css, /\.scan-status-line\{/);
});

test("taskboard opens directly without a password login page", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const [html, app] = await Promise.all([
    fs.readFile(path.join(root, "web", "index.html"), "utf8"),
    fs.readFile(path.join(root, "web", "app.js"), "utf8")
  ]);
  assert.doesNotMatch(html, /loginView|loginForm|adminSecret|logoutBtn/);
  assert.match(html, /<main id="appView">/);
  assert.doesNotMatch(app, /showLogin|loginForm|adminSecret|logoutBtn/);
  assert.match(app, /await restoreSession\(\)/);
});

test("web UI displays runtime version from health endpoint", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.doesNotMatch(html, /id="loginVersion"/);
  assert.match(html, /id="appVersion"/);
  assert.match(js, /async function loadAppVersion/);
  assert.match(js, /\/healthz/);
  assert.match(js, /"v"\+\(data\.version/);
});

test("web UI exposes AI execution settings button and dialog", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.match(html, /id="aiSettingsBtn"/);
  assert.match(html, /AI自动执行设置/);
  assert.match(html, /id="developerModel"/);
  assert.match(html, /id="developerReasoning"/);
  assert.match(html, /id="testModel"/);
  assert.match(html, /id="testReasoning"/);
  assert.match(html, /id="scanIntervalMinutes"/);
  assert.match(html, /id="maxRequestsPerChat"/);
  assert.match(html, /id="contextWarningAt"/);
  assert.match(html, /id="timeoutRetryLimit"/);
  assert.match(js, /\/api\/ai-execution\/settings/);
  assert.match(js, /method:"PUT"/);
  assert.match(js, /openAiSettings/);
});

test("web UI exposes project-level start/restart and stop controls", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.match(html, /id="projectService"/);
  assert.match(html, /id="projectStartRestartBtn"/);
  assert.match(html, /id="projectStopServiceBtn"/);
  assert.match(html, /启动 \/ 重启/);
  assert.match(html, /一键关闭/);
  assert.match(js, /startOrRestartProjectService/);
  assert.match(js, /stopProjectService/);
  assert.match(js, /waitForServiceOnline/);
});


test("web UI can remove a managed project without implying disk deletion", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await fs.readFile(path.join(root, "web", "index.html"), "utf8");
  const js = await fs.readFile(path.join(root, "web", "app.js"), "utf8");
  assert.match(html, /id="removeProjectBtn"/);
  assert.match(html, />移除项目</);
  assert.match(js, /async function removeCurrentProject/);
  assert.match(js, /只会解除任务看板管理关系，不会删除磁盘项目文件/);
  assert.match(js, /method:"DELETE"/);
  assert.match(js, /await api\("\/api\/projects\/"\+encodeURIComponent\(projectId\),\{method:"DELETE"/);
  assert.match(js, /switchProject\(null\)/);
});