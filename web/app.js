import { buildPlanIndex } from "./plan-index.mjs";
import { paginateColumn, resolveProjectId, tasksForColumn } from "./board-state.mjs";
const PROJECT_SELECTION_KEY="wyerp-taskboard:selected-project";
const PAGE_SIZE=3;
const USER_MESSAGE_PAGE_SIZE=3;
const DELIVERY_USER_COLUMN_LABEL="待交付 / 待用户";
const state={
  csrfToken:null,projects:[],projectId:null,workflow:null,snapshot:null,filtered:[],requirements:[],scanStatus:null,projectServiceStatus:null,
  selectedTask:null,selectedTaskProjectId:null,projectEpoch:0,projectLoadEpoch:0,projectsLoadEpoch:0,detailEpoch:0,planEpoch:0,view:"board",columnPages:{},userMessages:[],userMessagePage:1
};
const $=id=>document.getElementById(id);
const els=Object.fromEntries([
  "toast","loginView","appView","loginForm","adminSecret","projectSelect","addRequirementBtn","requirementDialog","requirementForm","requirementText","closeRequirementDialogBtn","reloadRequirementsBtn","requirementList","addProjectBtn","removeProjectBtn","adaptProjectBtn","addProjectDialog",
  "addProjectForm","closeAddProjectBtn","cancelAddProjectBtn","projectRootInput","projectNameInput","projectIdInput",
  "projectRegistryInput","refreshBtn","logoutBtn","aiSettingsBtn","aiSettingsDialog","aiSettingsForm","closeAiSettingsBtn","cancelAiSettingsBtn","developerModel","developerReasoning","testModel","testReasoning","scanIntervalMinutes","maxRequestsPerChat","contextWarningAt","timeoutRetryLimit","anomalyWindowMinutes","anomalyLimit","roleSwitchLimit","loginVersion","appVersion","projectHealth","projectService","projectServiceStatus","projectStartRestartBtn","projectStopServiceBtn","scanStatus","summary","searchInput","planFilter","trackFilter",
  "priorityFilter","statusFilter","archiveFilter","boardViewBtn","listViewBtn","boardView","listView","taskTableBody",
  "planDialog","planDialogTitle","planDialogPath","planNavigator","planLocationStatus","planIndexList","planDocumentContent","closePlanDialogBtn",
  "taskDialog","closeDialogBtn","detailTaskId","detailTitle","userMessagePanel","userMessageCount","userMessageList",
  "taskPlanList","responsibilityText","currentProgressText","userAssistanceText","traceabilityText","readDependenciesText","writeTargetsText","relatedArtifactsText","detailMeta",
  "sessionInfo","testResourceSummary","testResourceList","prioritySelect","savePriorityBtn","stopBtn","resumeBtn","suspectDisconnectBtn","allowTakeoverBtn","autoCloseAuthorizationStatus","authorizeAutoCloseBtn","revokeAutoCloseBtn",
  "revokeTakeoverBtn","reviewNote","commentBtn","acceptBtn","rejectReason","rejectBtn","reloadHistoryBtn","historyList"
].map(id=>[id,$(id)]));

const TRACK_LABELS={product:"产品业务",infrastructure:"基础设施"};
const PRIORITY_LABELS={P0:"最高优先级",P1:"普通优先级",P2:"较低优先级"};
const STATUS_LABELS={HOLD:"暂停"};
const ROLE_LABELS={"开发AI":"开发助手","独立测试AI":"独立测试助手","用户":"用户","—":"—"};
const EVENT_LABELS={
  claim:"认领任务",release:"释放任务",code_change:"代码修改",doc_change:"文档修改",
  test_start:"开始测试",test_result:"测试结果",status_change:"状态变化",priority_change:"优先级变化",
  user_review:"用户留言",user_accept:"用户通过",user_reject:"用户打回",user_message_ack:"已读用户留言",
  user_message_reply:"回复用户留言",user_action_required:"需要用户配合",user_action_cleared:"用户配合已完成",
  stop_request:"停止请求",stop_acknowledged:"停止已确认",resume:"恢复任务",blocked:"任务阻断",
  handoff:"任务移交",task_update:"任务更新",suspected_disconnect:"疑似失联",auto_close_authorized:"自动完成授权",auto_close_revoked:"撤销自动完成授权",
  takeover_allowed:"允许异常接管",takeover_revoked:"撤销接管授权",takeover:"异常接管"
};

function toast(message,error=false){
  els.toast.textContent=message;els.toast.className="toast"+(error?" error":"");els.toast.hidden=false;
  clearTimeout(toast.timer);toast.timer=setTimeout(()=>els.toast.hidden=true,3600);
}
function opId(prefix="web"){return prefix+"."+crypto.randomUUID()}
async function api(url,options={}){
  const opts={credentials:"same-origin",...options,headers:{...(options.headers||{})}};
  if(options.body&&typeof options.body!=="string"){
    opts.headers["Content-Type"]="application/json";opts.body=JSON.stringify(options.body);
  }
  const method=(opts.method||"GET").toUpperCase();
  if(!["GET","HEAD"].includes(method)&&state.csrfToken)opts.headers["X-CSRF-Token"]=state.csrfToken;
  const res=await fetch(url,opts);let data=null;try{data=await res.json()}catch{}
  if(!res.ok){const err=new Error(data?.error?.message||("请求失败（"+res.status+"）"));err.code=data?.error?.code;err.status=res.status;err.details=data?.error?.details||null;throw err}
  return data;
}
async function loadAppVersion(){try{const data=await api("/healthz");const label="v"+(data.version||"—");if(els.loginVersion)els.loginVersion.textContent=label;if(els.appVersion)els.appVersion.textContent=label;state.appVersion=data.version||null;return data.version||null}catch{if(els.loginVersion)els.loginVersion.textContent="v?";if(els.appVersion)els.appVersion.textContent="v?";return null}}
async function restoreSession(){try{const session=await api("/api/auth/session");state.csrfToken=session.csrfToken;return true}catch{return false}}
function formatTime(value){if(!value)return"—";const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleString()}
function trackLabel(value){return TRACK_LABELS[value]||"其它类别"}
function priorityLabel(value){return PRIORITY_LABELS[value]||value||"—"}
function statusLabel(value){return STATUS_LABELS[value]||value||"—"}
function roleLabel(value){return ROLE_LABELS[value]||value||"—"}
function eventLabel(value){return EVENT_LABELS[value]||"系统事件"}
function readSavedProjectId(){try{return localStorage.getItem(PROJECT_SELECTION_KEY)||null}catch{return null}}
function saveProjectId(projectId){try{if(projectId)localStorage.setItem(PROJECT_SELECTION_KEY,projectId);else localStorage.removeItem(PROJECT_SELECTION_KEY)}catch{}}
function taskTitle(task){return task.presentation?.title||task.parent||task.id}
function mainPlan(task){return task.presentation?.mainPlan||task.presentation?.plans?.[0]||null}
function planName(plan){return plan?.name||"未绑定主计划"}
function healthOk(health){return Boolean(health&&(health.ok===true||health.status==="healthy"))}
function healthText(health){
  if(!health)return"状态未知";
  const labels={healthy:"项目源正常",source_unavailable:"项目源不可访问",read_only_blocked:"项目源只读阻断",format_unsupported:"项目格式暂不支持",transaction_inconsistent:"事务一致性异常"};
  const label=labels[health.status]||"项目状态异常";
  const detail=health.error?.message||health.message;
  return label+(detail?" · "+detail:"");
}
function badge(text,cls=""){const span=document.createElement("span");span.className="badge "+cls;span.textContent=text||"—";return span}
function fillSelect(select,values,firstLabel,labeler=value=>value){
  const current=select.value;select.replaceChildren();
  if(firstLabel!==null){const o=document.createElement("option");o.value="";o.textContent=firstLabel;select.append(o)}
  for(const value of values||[]){const o=document.createElement("option");o.value=value;o.textContent=labeler(value);select.append(o)}
  if([...select.options].some(o=>o.value===current))select.value=current;
}
function fillPlanFilter(){
  const seen=new Map();
  for(const task of state.snapshot?.tasks||[]){
    const plan=mainPlan(task);if(plan?.path&&!seen.has(plan.path))seen.set(plan.path,plan.name);
  }
  const current=els.planFilter.value;els.planFilter.replaceChildren();
  const all=document.createElement("option");all.value="";all.textContent="全部计划";els.planFilter.append(all);
  [...seen.entries()].sort((a,b)=>a[1].localeCompare(b[1],"zh-CN")).forEach(([path,name])=>{
    const o=document.createElement("option");o.value=path;o.textContent=name;els.planFilter.append(o);
  });
  if([...els.planFilter.options].some(o=>o.value===current))els.planFilter.value=current;
}
function fillFilters(){
  fillPlanFilter();
  fillSelect(els.trackFilter,state.workflow?.tracks||[],"全部任务类别",trackLabel);
  fillSelect(els.priorityFilter,state.workflow?.priorities||[],"全部优先级",priorityLabel);
  fillSelect(els.statusFilter,state.workflow?.statuses||[],"全部状态",statusLabel);
  fillSelect(els.prioritySelect,state.workflow?.priorities||[],null,priorityLabel);
}
function applyFilters(){
  const q=els.searchInput.value.trim().toLowerCase(),plan=els.planFilter.value,track=els.trackFilter.value,priority=els.priorityFilter.value,status=els.statusFilter.value,archive=els.archiveFilter.value;
  state.filtered=(state.snapshot?.tasks||[]).filter(task=>{
    const closed=["已完成","已取消"].includes(task.status);
    if(archive==="active"&&closed)return false;
    if(archive==="closed"&&!closed)return false;
    if(plan&&mainPlan(task)?.path!==plan)return false;
    if(track&&task.track!==track)return false;
    if(priority&&task.priority!==priority)return false;
    if(status&&task.status!==status)return false;
    if(!q)return true;
    return [
      task.id,task.parent,task.boundary,task.assignee,task.sessionWindowName,task.sessionId,
      ...(task.presentation?.plans||[]).map(p=>p.name),
      task.presentation?.responsibility,task.presentation?.currentProgress,task.presentation?.userAssistance
    ].filter(Boolean).join(" ").toLowerCase().includes(q);
  });
}
function sameProject(projectId,epoch){return state.projectId===projectId&&state.projectEpoch===epoch;}
function selectedTaskScope(){
  const task=state.selectedTask,projectId=state.projectId,epoch=state.projectEpoch;
  return task&&els.taskDialog.open&&state.selectedTaskProjectId===projectId?{task,projectId,epoch,detailEpoch:state.detailEpoch}:null;
}
function sameTask(scope){return !!scope&&sameProject(scope.projectId,scope.epoch)&&state.selectedTask===scope.task&&state.detailEpoch===scope.detailEpoch;}
function clearProjectDetails(){
  state.detailEpoch++;state.planEpoch++;state.selectedTask=null;state.selectedTaskProjectId=null;
  state.userMessages=[];state.userMessagePage=1;
  for(const dialog of [els.taskDialog,els.planDialog,els.requirementDialog,els.addProjectDialog]){
    if(dialog?.open)dialog.close();
  }
  for(const input of [els.reviewNote,els.rejectReason,els.requirementText])if(input)input.value="";
  for(const item of [els.historyList,els.userMessageList,els.taskPlanList,els.testResourceList,els.planDocumentContent,els.planIndexList,els.detailMeta,els.relatedArtifactsText])item?.replaceChildren();
  for(const item of [els.detailTaskId,els.detailTitle,els.responsibilityText,els.currentProgressText,els.userAssistanceText,els.traceabilityText,els.readDependenciesText,els.writeTargetsText,els.sessionInfo,els.planDialogTitle,els.planDialogPath,els.planLocationStatus])if(item)item.textContent="";
  els.planNavigator.hidden=true;
}
function switchProject(nextId){
  if(nextId===state.projectId)return false;
  state.projectEpoch++;state.projectLoadEpoch++;state.projectsLoadEpoch++;
  clearProjectDetails();
  state.projectId=nextId||null;saveProjectId(state.projectId);
  state.workflow=null;state.snapshot={tasks:[]};state.filtered=[];state.requirements=[];
  state.scanStatus=null;state.projectServiceStatus=null;state.columnPages={};
  for(const input of [els.searchInput,els.planFilter,els.trackFilter,els.priorityFilter,els.statusFilter])input.value="";
  if(els.archiveFilter)els.archiveFilter.value="all";
  renderSummary();renderRequirements();render();renderProjectServiceStatus();
  return true;
}

async function loadProjects(){
  const epoch=state.projectEpoch,request=++state.projectsLoadEpoch;
  const data=await api("/api/projects");
  if(epoch!==state.projectEpoch||request!==state.projectsLoadEpoch)return false;
  state.projects=data.projects||[];
  els.projectSelect.replaceChildren(...state.projects.map(p=>{
    const o=document.createElement("option");o.value=p.id;o.textContent=p.name+" · 项目ID："+p.id;return o;
  }));
  const nextId=resolveProjectId(state.projects,state.projectId,readSavedProjectId());
  if(nextId!==state.projectId)switchProject(nextId);
  els.projectSelect.value=state.projectId||"";
  saveProjectId(state.projectId);
  const selected=state.projects.find(p=>p.id===state.projectId);
  if(els.adaptProjectBtn)els.adaptProjectBtn.hidden=selected?.onboardingStatus!=="adaptation_required";
  if(els.removeProjectBtn)els.removeProjectBtn.disabled=!state.projectId;
  return true;
}
async function loadScanStatus(){
  try{state.scanStatus=await api("/api/task-scan/status")}catch{state.scanStatus=null}
}
function developerCandidateFor(task){
  return (state.scanStatus?.developerCandidates||[]).find(item=>item.projectId===state.projectId&&item.taskId===task.id)||null;
}
function boardTasksForColumn(column){
  return tasksForColumn(state.filtered,column.statuses);
}
function renderScanStatus(){
  const data=state.scanStatus;
  if(!data){els.scanStatus.textContent="自动检测：状态读取失败";els.scanStatus.classList.add("bad");return}
  const installed=Boolean(data.scheduler?.installed);
  const schedulerDisabled=String(data.scheduler?.state||"").toLowerCase()==="disabled";
  const intervalMinutes=Number(data.executionSettings?.scan_interval_minutes??data.scheduler?.interval_minutes??10);
  const schedulerIntervalMinutes=Number(data.scheduler?.interval_minutes??intervalMinutes);
  const schedulerOutOfSync=Boolean(installed&&schedulerIntervalMinutes!==intervalMinutes);
  const schedulerLabel=!installed?intervalMinutes+"分钟计划任务未安装":schedulerDisabled?intervalMinutes+"分钟计划任务已停用":schedulerOutOfSync?"设置"+intervalMinutes+"分钟 · 计划任务"+schedulerIntervalMinutes+"分钟（未同步）":intervalMinutes+"分钟计划任务已安装";
  const last=data.scan?.last_scan_at?formatTime(data.scan.last_scan_at):"尚未运行";
  const next=data.nextExpectedAt?formatTime(data.nextExpectedAt):"未知";
  const top=data.highestCandidate?("最高候选："+data.highestCandidate.taskId+"（"+data.highestCandidate.reason+"）"):"当前无候选";
  const consumed=data.lastConsumption?("最近候选认领："+(data.lastConsumption.detection_id||"候选")+" → "+(data.lastConsumption.claim_event_id||"未记录claim事件")):"最近尚无候选认领";
  const trigger=data.scan?.instant_trigger||"disabled_unverified";
  const chatWake=data.scan?.chat_browser_wake;
  const maxRequestsPerChat=Number(data.executionSettings?.max_requests_per_chat??20);
  const wakeAck=chatWake?.last_ack_at?("最近唤醒ACK："+formatTime(chatWake.last_ack_at)):"尚无唤醒ACK";
  const mode=chatWake?.verified?("普通聊天即时唤醒已验证（浏览器扩展，本机SSE，角色隔离，每聊天最多"+maxRequestsPerChat+"次） · "+wakeAck):trigger==="enabled_verified"?"聊天模式即时触发已验证":trigger==="chat_mode_only_unavailable"?"普通聊天浏览器桥待验证；GitHub→Work桥已停用":trigger==="github_bridge_ready_unverified"?"GitHub桥仅为备用传输层，普通聊天浏览器桥待验证":trigger==="github_bridge_error_fallback"?"GitHub备用桥异常，普通聊天浏览器桥状态待确认":"即时唤醒未启用";
  els.scanStatus.textContent="自动检测："+schedulerLabel+" · 最近扫描："+last+" · 下次预计："+next+" · 候选："+String(data.candidateCount||0)+"（可认领 "+String(data.eligibleCount||0)+"） · "+top+" · "+consumed+" · "+mode;
  els.scanStatus.classList.toggle("bad",!installed||schedulerDisabled||schedulerOutOfSync||data.scan?.state==="failed"||trigger==="github_bridge_error_fallback"||Boolean(data.scheduler?.probe_error));
}
function renderProjectServiceStatus(){
  const info=state.projectServiceStatus;
  if(!state.projectId){
    els.projectService.hidden=true;
    return;
  }
  els.projectService.hidden=false;
  if(!info){
    els.projectServiceStatus.textContent="状态检测中";
    els.projectStartRestartBtn.disabled=true;
    els.projectStopServiceBtn.disabled=true;
    return;
  }
  if(info.supported===false){
    els.projectServiceStatus.textContent="当前项目未配置服务控制";
    els.projectStartRestartBtn.disabled=true;
    els.projectStopServiceBtn.disabled=true;
    return;
  }
  const labels={
    running:"运行中",
    stopped:"已关闭",
    stale_instance:"已停止（存在旧实例记录）",
    port_conflict:"端口冲突",
    identity_mismatch:"身份不匹配",
    identity_unknown:"身份未知",
    unreachable:"服务不可访问"
  };
  const detail=[];
  if(info.pid)detail.push("PID "+info.pid);
  if(info.port)detail.push("端口 "+info.port);
  els.projectServiceStatus.textContent=(labels[info.state]||info.state||"状态未知")+(detail.length?" · "+detail.join(" · "):"");
  const unsafe=["port_conflict","identity_mismatch","identity_unknown"].includes(info.state);
  els.projectStartRestartBtn.disabled=unsafe||info.state==="unreachable";
  els.projectStopServiceBtn.disabled=unsafe||info.state!=="running";
}
async function loadProjectServiceStatus(){
  const projectId=state.projectId,epoch=state.projectEpoch;
  if(!projectId){state.projectServiceStatus=null;renderProjectServiceStatus();return}
  let info;
  try{info=await api("/api/projects/"+encodeURIComponent(projectId)+"/service/status");}
  catch(error){info={supported:true,state:"unreachable",message:error.message};}
  if(!sameProject(projectId,epoch))return;
  state.projectServiceStatus=info;renderProjectServiceStatus();
}
async function waitForServiceOnline(timeoutMs=20000){
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline){
    try{
      const response=await fetch("/healthz",{cache:"no-store"});
      if(response.ok)return await response.json();
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  return null;
}
async function startOrRestartProjectService(){
  const projectId=state.projectId,epoch=state.projectEpoch;
  if(!projectId)return;
  els.projectStartRestartBtn.disabled=true;
  els.projectStopServiceBtn.disabled=true;
  try{
    const result=await api("/api/projects/"+encodeURIComponent(projectId)+"/service/start-or-restart",{method:"POST",body:{}});
    if(!sameProject(projectId,epoch))return;
    els.projectServiceStatus.textContent=result.action==="restart"?"正在重启…":"正在启动…";
    const health=await waitForServiceOnline();
    if(!sameProject(projectId,epoch))return;
    if(!health){
      els.projectServiceStatus.textContent="启动/重启已提交，但服务未在20秒内恢复";
      toast("项目服务未在20秒内恢复，请检查服务状态",true);
      return;
    }
    await loadAppVersion();
    if(!sameProject(projectId,epoch))return;
    state.csrfToken=null;
    state.projectServiceStatus={supported:true,state:"running",port:47831};
    renderProjectServiceStatus();
    showLogin();
    toast("项目服务已"+(result.action==="restart"?"重启":"启动")+"，请重新登录");
  }catch(error){
    toast("项目启动/重启失败："+error.message,true);
    await loadProjectServiceStatus();
  }
}
async function stopProjectService(){
  const projectId=state.projectId,epoch=state.projectEpoch;
  if(!projectId)return;
  els.projectStartRestartBtn.disabled=true;
  els.projectStopServiceBtn.disabled=true;
  try{
    await api("/api/projects/"+encodeURIComponent(projectId)+"/service/stop",{method:"POST",body:{}});
    if(!sameProject(projectId,epoch))return;
    els.projectServiceStatus.textContent="正在关闭…";
    setTimeout(()=>{
      if(!sameProject(projectId,epoch))return;
      state.projectServiceStatus={supported:true,state:"stopped",port:47831};
      renderProjectServiceStatus();
      els.projectStartRestartBtn.disabled=true;
      els.projectServiceStatus.textContent="已关闭 · 重新启动看板自身请使用本机启动入口";
    },1200);
  }catch(error){
    toast("项目关闭失败："+error.message,true);
    await loadProjectServiceStatus();
  }
}
async function loadProject(){
  const projectId=state.projectId,epoch=state.projectEpoch,request=++state.projectLoadEpoch;
  let scanStatus=null;
  try{scanStatus=await api("/api/task-scan/status")}catch{/* LOG-IGNORE: scan status is diagnostic only, not project/task authority */}
  if(!sameProject(projectId,epoch)||request!==state.projectLoadEpoch)return false;
  if(!projectId){
    state.scanStatus=scanStatus;state.workflow=null;state.snapshot={tasks:[]};state.filtered=[];state.requirements=[];
    els.projectHealth.textContent="尚未添加项目，请点击“添加项目”并填写本机项目根路径";
    els.projectHealth.classList.add("bad");renderScanStatus();renderSummary();renderRequirements();render();return true;
  }
  const project=state.projects.find(p=>p.id===projectId);
  const workflow=await api("/api/projects/"+encodeURIComponent(projectId)+"/workflow");
  if(!sameProject(projectId,epoch)||request!==state.projectLoadEpoch)return false;
  const snapshot=healthOk(project?.health)
    ?await api("/api/projects/"+encodeURIComponent(projectId)+"/tasks")
    :{tasks:[],sourceHealth:project?.health};
  if(!sameProject(projectId,epoch)||request!==state.projectLoadEpoch)return false;
  const requirements=(await api("/api/projects/"+encodeURIComponent(projectId)+"/requirements")).items||[];
  if(!sameProject(projectId,epoch)||request!==state.projectLoadEpoch)return false;
  state.scanStatus=scanStatus;state.workflow=workflow;state.snapshot=snapshot;state.requirements=requirements;
  fillFilters();applyFilters();renderHealth();renderScanStatus();renderSummary();renderRequirements();render();
  return true;
}
function renderHealth(){
  const project=state.projects.find(p=>p.id===state.projectId),health=state.snapshot?.sourceHealth||project?.health;
  els.projectHealth.textContent=(project?.name||state.projectId)+" · 协作流程ID："+(state.workflow?.id||project?.workflowProfile||"—")+" · "+healthText(health);
  els.projectHealth.classList.toggle("bad",!healthOk(health));
}
function renderSummary(){
  const tasks=state.snapshot?.tasks||[];
  const defs=[
    ["总任务",tasks.length],
    ["最高优先级",tasks.filter(t=>t.priority==="P0"&&!["已完成","已取消"].includes(t.status)).length],
    ["执行中",tasks.filter(t=>["开发中","修复中","独测中","复测中","交付中"].includes(t.status)).length],
    ["待测试",tasks.filter(t=>["待独测","待复测"].includes(t.status)).length],
    ["待用户",tasks.filter(t=>t.status==="待用户验收").length],
    ["有用户留言",tasks.filter(t=>t.presentation?.latestUserMessage).length],
    ["待拆需求",state.requirements.filter(r=>r.status==="待AI拆解").length],
    ["阻断/暂停",tasks.filter(t=>["阻断","HOLD","测试失败待修复"].includes(t.status)).length]
  ];
  els.summary.replaceChildren(...defs.map(([label,value])=>{
    const div=document.createElement("div");div.className="summary-card";if(label==="有用户留言"&&value)div.classList.add("message-summary");
    const s=document.createElement("span"),b=document.createElement("strong");s.textContent=label;b.textContent=String(value);div.append(s,b);return div;
  }));
}
function planButton(taskId,plan,small=false){
  const button=document.createElement("button");button.type="button";button.className=small?"plan-link small":"plan-link";
  button.textContent=(plan.primary?"主计划：":"关联计划：")+plan.name;
  const projectId=state.projectId,epoch=state.projectEpoch;
  button.addEventListener("click",event=>{event.stopPropagation();if(sameProject(projectId,epoch))openPlan(taskId,plan.index)});
  return button;
}
function documentButton(taskId,doc){
  const button=document.createElement("button");button.type="button";button.className="plan-link small";
  const label=doc.kind==="checkpoint"?"任务断点":doc.kind==="report"?"测试报告":"关联文档";
  button.textContent=label+"："+doc.name;
  const projectId=state.projectId,epoch=state.projectEpoch;
  button.addEventListener("click",event=>{event.stopPropagation();if(sameProject(projectId,epoch))openDocument(taskId,doc.index)});
  return button;
}
function taskCard(task){
  const card=document.createElement("article");card.className="task-card";
  if(task.presentation?.latestUserMessage?.replied){
    const stamp=document.createElement("div");stamp.className="reply-stamp";stamp.textContent="已回复";stamp.title="最新用户留言已有AI回复";card.append(stamp);
  }
  const id=document.createElement("div");id.className="task-id";id.textContent=task.id;
  const h4=document.createElement("h4");h4.textContent=taskTitle(task);
  const badges=document.createElement("div");badges.className="badges";
  badges.append(badge(trackLabel(task.track)),badge(priorityLabel(task.priority),task.priority?.toLowerCase()),badge(statusLabel(task.status)));
  if(["待开发","待准备"].includes(task.status)&&task.plannedRole==="开发AI"){const candidate=developerCandidateFor(task);badges.append(badge(candidate?.eligible===true?"待认领":"待处理",candidate?.eligible===true?"claimable":"waiting"));}
  const plan=mainPlan(task);const planRow=document.createElement("div");planRow.className="card-plan";
  if(plan)planRow.append(planButton(task.id,plan,true));else planRow.textContent="主计划：未绑定";
  const responsibility=document.createElement("div");responsibility.className="task-responsibility";responsibility.textContent="本任务负责："+(task.presentation?.responsibility||task.boundary||"未填写");
  const progress=document.createElement("div");progress.className="task-progress";progress.textContent="当前进展："+(task.presentation?.currentProgress||statusLabel(task.status));
  card.append(id,h4,badges,planRow,responsibility,progress);
  const assistanceText=task.presentation?.userAssistance||"";
  if(assistanceText&&!assistanceText.startsWith("当前无需你操作")){
    const assistance=document.createElement("div");assistance.className="task-user-assistance";assistance.textContent="需要你配合："+assistanceText;card.append(assistance);
  }
  if(task.presentation?.latestUserMessage){
    const msg=document.createElement("div");msg.className="task-user-message";msg.textContent="用户留言："+task.presentation.latestUserMessage.note;card.append(msg);
  }
  const foot=document.createElement("div");foot.className="card-foot";foot.textContent="执行窗口："+(task.sessionWindowName||task.assignee||roleLabel(task.plannedRole)||"未认领");card.append(foot);
  const projectId=state.projectId,epoch=state.projectEpoch;
  card.addEventListener("click",()=>{if(sameProject(projectId,epoch))openTask(task.id)});return card;
}
function columnPageKey(planPath,columnId){return (planPath||"__none__")+"::"+columnId}
function renderPagination(key,page,totalPages){
  const wrap=document.createElement("div");wrap.className="column-pagination";
  const prev=document.createElement("button");prev.type="button";prev.className="ghost small";prev.textContent="上一页";prev.disabled=page<=1;
  const label=document.createElement("span");label.textContent="第"+page+"页 · 共"+totalPages+"页";
  const next=document.createElement("button");next.type="button";next.className="ghost small";next.textContent="下一页";next.disabled=page>=totalPages;
  prev.addEventListener("click",()=>{state.columnPages[key]=page-1;renderBoard()});
  next.addEventListener("click",()=>{state.columnPages[key]=page+1;renderBoard()});
  wrap.append(prev,label,next);return wrap;
}
function renderBoard(){
  els.boardView.replaceChildren();
  const columns=state.workflow?.boardColumns||[];
  if(!state.filtered.length){
    const empty=document.createElement("div");empty.className="empty-state";empty.textContent="当前筛选条件下没有任务";els.boardView.append(empty);return;
  }
  for(const column of columns){
    const tasks=boardTasksForColumn(column);
    const key=column.id;
    const {page,totalPages,visible}=paginateColumn(tasks,state.columnPages[key],PAGE_SIZE);state.columnPages[key]=page;
    const col=document.createElement("section");col.className="board-column";
    const head=document.createElement("div");head.className="column-head";
    const columnTitle=document.createElement("span");columnTitle.textContent=column.title.replace(/HOLD/g,"暂停");
    const columnCount=document.createElement("span");columnCount.className="count";columnCount.textContent=tasks.length+"项";
    head.append(columnTitle,columnCount);col.append(head);
    if(visible.length)col.append(...visible.map(taskCard));
    else{const empty=document.createElement("div");empty.className="column-empty";empty.textContent="暂无任务";col.append(empty)}
    if(totalPages>1)col.append(renderPagination(key,page,totalPages));
    els.boardView.append(col);
  }
}
function renderList(){
  els.taskTableBody.replaceChildren(...state.filtered.map(task=>{
    const tr=document.createElement("tr");
    const values=[
      task.id+" · "+taskTitle(task),planName(mainPlan(task)),trackLabel(task.track),priorityLabel(task.priority),
      statusLabel(task.status),task.assignee||"—",task.sessionWindowName||"—",formatTime(task.updatedAt)
    ];
    for(const value of values){const td=document.createElement("td");td.textContent=value;tr.append(td)}
    const projectId=state.projectId,epoch=state.projectEpoch;
    tr.addEventListener("click",()=>{if(sameProject(projectId,epoch))openTask(task.id)});return tr;
  }));
}
function renderRequirements(){
  if(!els.requirementList)return;
  const items=(state.requirements||[]).slice().sort((a,b)=>String(b.updatedAt||"").localeCompare(String(a.updatedAt||"")));
  els.requirementList.replaceChildren(...items.map(item=>{
    const card=document.createElement("article");card.className="requirement-card";
    const head=document.createElement("div");head.className="requirement-head";
    const id=document.createElement("strong");id.textContent=item.id;
    const status=document.createElement("span");status.className="badge";status.textContent=item.status;
    head.append(id,status);
    const text=document.createElement("div");text.className="requirement-text";text.textContent=item.text;
    const meta=document.createElement("div");meta.className="event-meta";meta.textContent="提交："+formatTime(item.createdAt)+" · 更新："+formatTime(item.updatedAt);
    card.append(head,text,meta);
    if(item.planPaths?.length||item.taskIds?.length){
      const refs=document.createElement("div");refs.className="requirement-refs";
      refs.textContent="关联计划："+(item.planPaths?.join("、")||"—")+"；任务："+(item.taskIds?.join("、")||"—")+"；关键文件："+(item.keyFiles?.join("、")||"—");card.append(refs);
    }
    const messages=document.createElement("div");messages.className="requirement-messages";
    for(const message of item.messages||[]){
      const row=document.createElement("div");row.className="requirement-message "+(message.actorType==="user"?"from-user":"from-ai");
      const who=message.actorType==="user"?"用户":"AI";
      row.textContent=who+" · "+formatTime(message.timestamp)+"\n"+message.note;
      messages.append(row);
    }
    card.append(messages);
    if(!["已拆解","已取消"].includes(item.status)){
      const form=document.createElement("form");form.className="requirement-reply-form";
      const input=document.createElement("textarea");input.rows=2;input.placeholder="补充需求或回复AI问题";
      const button=document.createElement("button");button.type="submit";button.textContent="补充说明";
      form.append(input,button);
      const projectId=state.projectId,epoch=state.projectEpoch;
      form.addEventListener("submit",async event=>{
        event.preventDefault();const note=input.value.trim();if(!note||!sameProject(projectId,epoch))return;
        try{
          await api("/api/projects/"+encodeURIComponent(projectId)+"/requirements/"+encodeURIComponent(item.id)+"/reply",{
            method:"POST",body:{operationId:opId("requirement_user_reply"),note,replyToMessageId:(item.messages||[]).filter(m=>m.actorType!=="user").at(-1)?.id||null}
          });
          if(!sameProject(projectId,epoch))return;
          input.value="";await loadProject();toast("需求补充已保存");
        }catch(error){toast(error.message,true)}
      });
      card.append(form);
    }
    return card;
  }));
  if(!items.length)els.requirementList.textContent="暂无需求记录";
}
function render(){
  renderBoard();renderList();
  els.boardView.hidden=state.view!=="board";els.listView.hidden=state.view!=="list";
  els.boardViewBtn.classList.toggle("active",state.view==="board");els.listViewBtn.classList.toggle("active",state.view==="list");
}
async function refreshAll(message=null){
  try{
    if(await loadProjects()===false)return;
    if(await loadProject()===false)return;
    await loadProjectServiceStatus();
    if(message)toast(message);
  }catch(error){if(error.status===401)return showLogin();toast(error.message,true)}
}
function showLogin(){state.csrfToken=null;els.appView.hidden=true;els.loginView.hidden=false}
function showApp(){els.loginView.hidden=true;els.appView.hidden=false}
function jumpToPlanLine(lineNumber){
  const target=els.planDocumentContent.querySelector('[data-plan-line="'+String(lineNumber)+'"]');
  if(!target)return;
  els.planDocumentContent.querySelectorAll(".plan-line.index-active").forEach((node)=>node.classList.remove("index-active"));
  target.classList.add("index-active");
  target.scrollIntoView({behavior:"smooth",block:"center"});
}
function renderPlanReader(data,taskId){
  const model=buildPlanIndex(data.content,taskId);
  els.planNavigator.hidden=false;
  els.planLocationStatus.textContent=model.foundTask
    ? "当前任务："+taskId+" · 已定位到第"+model.targetLine+"行"
    : "当前任务："+taskId+" · 计划中未找到精确任务ID，请使用索引跳转";
  const indexNodes=model.entries.map((entry)=>{
    const button=document.createElement("button");
    button.type="button";
    button.className="plan-index-item"+(entry.taskMatch?" task-match":"");
    button.style.setProperty("--plan-level",String(entry.level||1));
    button.textContent="第"+entry.lineNumber+"行 · "+entry.label;
    button.addEventListener("click",()=>jumpToPlanLine(entry.lineNumber));
    return button;
  });
  els.planIndexList.replaceChildren(...indexNodes);
  const lineNodes=model.lines.map((line,index)=>{
    const lineNumber=index+1;
    const row=document.createElement("div");
    row.className="plan-line"+(lineNumber===model.targetLine?" task-target":"");
    row.dataset.planLine=String(lineNumber);
    const number=document.createElement("span");number.className="plan-line-number";number.textContent=String(lineNumber);
    const text=document.createElement("span");text.className="plan-line-text";text.textContent=line||" ";
    row.append(number,text);
    return row;
  });
  els.planDocumentContent.replaceChildren(...lineNodes);
  return model.targetLine;
}
function renderPlainDocument(data){
  els.planNavigator.hidden=true;
  els.planLocationStatus.textContent="";
  els.planIndexList.replaceChildren();
  els.planDocumentContent.replaceChildren();
  const pre=document.createElement("pre");
  pre.className="plain-document-content";
  pre.textContent=data.content;
  els.planDocumentContent.append(pre);
}
async function openPlan(taskId,planIndex){
  const projectId=state.projectId,epoch=state.projectEpoch,request=++state.planEpoch;
  if(!projectId||!(state.snapshot?.tasks||[]).some(task=>task.id===taskId))return;
  try{
    const data=await api("/api/projects/"+encodeURIComponent(projectId)+"/tasks/"+encodeURIComponent(taskId)+"/plans/"+encodeURIComponent(planIndex));
    if(!sameProject(projectId,epoch)||request!==state.planEpoch)return;
    els.planDialogTitle.textContent=data.name;els.planDialogPath.textContent="项目内路径："+data.path;
    const targetLine=renderPlanReader(data,taskId);
    els.planDialog.showModal();
    if(targetLine)requestAnimationFrame(()=>{if(sameProject(projectId,epoch)&&request===state.planEpoch)jumpToPlanLine(targetLine)});
  }catch(error){if(sameProject(projectId,epoch)&&request===state.planEpoch)toast(error.message,true)}
}
async function openDocument(taskId,documentIndex){
  const projectId=state.projectId,epoch=state.projectEpoch,request=++state.planEpoch;
  if(!projectId||!(state.snapshot?.tasks||[]).some(task=>task.id===taskId))return;
  try{
    const data=await api("/api/projects/"+encodeURIComponent(projectId)+"/tasks/"+encodeURIComponent(taskId)+"/documents/"+encodeURIComponent(documentIndex));
    if(!sameProject(projectId,epoch)||request!==state.planEpoch)return;
    els.planDialogTitle.textContent=data.name;els.planDialogPath.textContent="项目内路径："+data.path;
    renderPlainDocument(data);els.planDialog.showModal();
  }catch(error){if(sameProject(projectId,epoch)&&request===state.planEpoch)toast(error.message,true)}
}
const REPLY_ACTOR_LABELS={developer_ai:"开发AI回复",test_ai:"测试AI回复"};
function replyActorLabel(actorType){
  const normalized=String(actorType||"").trim();
  if(!normalized)return "AI回复（历史）";
  return REPLY_ACTOR_LABELS[normalized]||"AI回复";
}
function renderUserMessages(){
  const messages=state.userMessages||[];
  const ordered=messages.slice().reverse();
  const totalPages=Math.max(1,Math.ceil(ordered.length/USER_MESSAGE_PAGE_SIZE));
  state.userMessagePage=Math.min(Math.max(1,state.userMessagePage||1),totalPages);
  const start=(state.userMessagePage-1)*USER_MESSAGE_PAGE_SIZE;
  const visible=ordered.slice(start,start+USER_MESSAGE_PAGE_SIZE);
  els.userMessagePanel.hidden=!messages.length;
  els.userMessageCount.textContent=messages.length?(messages.length+"条 · 第"+state.userMessagePage+"/"+totalPages+"页"):"";
  const nodes=visible.map(message=>{
    const div=document.createElement("div");div.className="user-message-item";div.dataset.messageEventId=message.eventId;
    const time=document.createElement("div");time.className="user-message-time";time.textContent=formatTime(message.timestamp);
    const note=document.createElement("div");note.textContent=message.note;div.append(time,note);
    for(const reply of message.replies||[]){
      const replyBox=document.createElement("div");replyBox.className="ai-reply";
      const replyHead=document.createElement("div");replyHead.className="ai-reply-head";replyHead.textContent=replyActorLabel(reply.actorType)+" · "+formatTime(reply.timestamp)+(reply.inferred?" · 历史自动关联":"");
      const replyText=document.createElement("div");replyText.textContent=reply.note;
      const locate=document.createElement("button");locate.type="button";locate.className="ghost small";locate.textContent="定位历史回复";
      locate.addEventListener("click",()=>{const target=document.getElementById("history-"+reply.eventId);if(target)target.scrollIntoView({behavior:"smooth",block:"center"})});
      replyBox.append(replyHead,replyText,locate);div.append(replyBox);
    }
    return div;
  });
  els.userMessageList.replaceChildren(...nodes);
  if(totalPages>1){
    const pager=document.createElement("div");pager.className="user-message-pagination";
    const prev=document.createElement("button");prev.type="button";prev.className="ghost small";prev.textContent="上一页";prev.disabled=state.userMessagePage<=1;
    const label=document.createElement("span");label.textContent="第"+state.userMessagePage+"页 · 共"+totalPages+"页";
    const next=document.createElement("button");next.type="button";next.className="ghost small";next.textContent="下一页";next.disabled=state.userMessagePage>=totalPages;
    prev.addEventListener("click",()=>{state.userMessagePage-=1;renderUserMessages()});
    next.addEventListener("click",()=>{state.userMessagePage+=1;renderUserMessages()});
    pager.append(prev,label,next);els.userMessageList.append(pager);
  }
}


function renderTestResources(resourceState){
  if(!els.testResourceList||!els.testResourceSummary)return;
  const active=resourceState?.active||[];
  const stale=Number(resourceState?.staleCount||0),urgent=Number(resourceState?.immediateCleanupCount||0);
  els.testResourceSummary.textContent="待处理 "+active.length+" 项"+(stale?" · 陈旧提醒 "+stale+" 项":"")+(urgent?" · 安全清理提醒 "+urgent+" 项":"");
  if(!active.length){const empty=document.createElement("div");empty.className="test-resource-empty";empty.textContent="当前没有登记中的测试临时资源";els.testResourceList.replaceChildren(empty);return}
  els.testResourceList.replaceChildren(...active.map(item=>{
    const card=document.createElement("article");card.className="test-resource-card"+(item.stale?" stale":"")+(item.requiresImmediateCleanup?" danger":"");
    const head=document.createElement("div");head.className="test-resource-head";
    const title=document.createElement("strong");title.textContent=item.resourceId+" · "+(item.resourceType||"临时资源");
    const status=document.createElement("span");status.className="badge";status.textContent=item.requiresImmediateCleanup?"需安全清理":item.stale?"待清理检查":item.status;
    head.append(title,status);
    const locator=document.createElement("div");locator.className="test-resource-locator";locator.textContent="定位："+(item.locator||"—");
    const detail=document.createElement("div");detail.className="test-resource-detail";
    detail.textContent="用途："+(item.purpose||"—")+"\n创建者："+(item.owner?.actorId||"—")+" / "+(item.owner?.sessionId||"—")+"\n接手者："+(item.handoffTarget||"—")+"\n清理条件："+(item.cleanupCondition||"—")+"\n证据："+(item.evidencePath||"—")+(item.observed?"\n开发确认："+item.observed.result+" · "+(item.observed.note||""):"");
    card.append(head,locator,detail);return card;
  }));
}
async function openTask(taskId){
  const projectId=state.projectId,epoch=state.projectEpoch,request=++state.detailEpoch;
  state.selectedTask=null;state.selectedTaskProjectId=null;
  if(!projectId||!(state.snapshot?.tasks||[]).some(task=>task.id===taskId))return;
  try{
    const data=await api("/api/projects/"+encodeURIComponent(projectId)+"/tasks/"+encodeURIComponent(taskId));
    if(!sameProject(projectId,epoch)||request!==state.detailEpoch||data.id!==taskId)return;
    state.selectedTask=data;state.selectedTaskProjectId=projectId;
    els.detailTaskId.textContent=data.id;els.detailTitle.textContent=taskTitle(data);
    const p=data.presentation||{};
    els.taskPlanList.replaceChildren(...(p.plans||[]).map(plan=>planButton(data.id,plan)));
    if(!(p.plans||[]).length)els.taskPlanList.textContent="未绑定主计划";
    els.responsibilityText.textContent=p.responsibility||data.boundary||"未填写";
    els.currentProgressText.textContent=p.currentProgress||statusLabel(data.status);
    els.userAssistanceText.textContent=p.userAssistance||"当前无需你操作";
    els.traceabilityText.textContent=p.traceability||data.traceability||"—";
    els.readDependenciesText.textContent=data.readDependencies||"—";
    els.writeTargetsText.textContent=data.writeTargets||"—";
    const documents=p.documents||[];
    els.relatedArtifactsText.replaceChildren(...documents.map(document=>documentButton(data.id,document)));
    if(!documents.length)els.relatedArtifactsText.textContent=p.relatedArtifacts||data.targets||"—";
    renderTestResources(data.testResources);
    state.userMessages=data.userMessages?.messages||[];
    state.userMessagePage=1;
    const autoCloseAuthorized=Boolean(data.autoCloseAuthorization?.authorized);
    els.autoCloseAuthorizationStatus.textContent=autoCloseAuthorized?"已授权：该低风险任务若独测/复测通过且没有真实交付动作，可直接完成":"未授权：测试通过且无真实交付动作时仍进入待用户验收";
    els.authorizeAutoCloseBtn.disabled=autoCloseAuthorized||["已完成","已取消"].includes(data.status);
    els.revokeAutoCloseBtn.disabled=!autoCloseAuthorized||["已完成","已取消"].includes(data.status);
    renderUserMessages();
    const meta=[
      ["状态",statusLabel(data.status)],["优先级",priorityLabel(data.priority)],["任务类别",trackLabel(data.track)],
      ["计划角色",roleLabel(data.plannedRole)],["当前负责人",data.assignee||"—"],["最近更新",formatTime(data.updatedAt)]
    ];
    els.detailMeta.replaceChildren(...meta.map(([label,value])=>{
      const div=document.createElement("div");div.className="meta-item";const s=document.createElement("span"),b=document.createElement("strong");
      s.textContent=label;b.textContent=value;div.append(s,b);return div;
    }));
    const deliveryStageNote=["待交付","待用户验收"].includes(data.status)?("\n看板列："+DELIVERY_USER_COLUMN_LABEL+"（同列展示，当前真实状态仍是“"+statusLabel(data.status)+"”）"):"";
    els.sessionInfo.textContent=
      "窗口名称："+(data.sessionWindowName||"—")+
      "\n技术会话ID："+(data.sessionId||"—")+
      "\n停止请求："+(data.stop?.stopRequested?"是（协作式停止）":"否")+
      "\n疑似失联："+(data.takeover?.suspectedDisconnect?"是":"否")+
      "\n异常接管授权："+(data.takeover?.takeoverAllowed?"已授权":"未授权")+deliveryStageNote;
    els.prioritySelect.value=data.priority||"";els.reviewNote.value="";
    els.resumeBtn.disabled=!(data.status==="HOLD"||data.stop?.stopRequested);
    els.allowTakeoverBtn.disabled=!data.takeover?.suspectedDisconnect||data.takeover?.takeoverAllowed;
    els.revokeTakeoverBtn.disabled=!data.takeover?.takeoverAllowed;
    els.taskDialog.showModal();await loadHistory();
  }catch(error){if(sameProject(projectId,epoch)&&request===state.detailEpoch)toast(error.message,true)}
}
async function loadHistory(){
  const scope=selectedTaskScope();if(!scope)return;
  try{
    const data=await api("/api/projects/"+encodeURIComponent(scope.projectId)+"/tasks/"+encodeURIComponent(scope.task.id)+"/history?limit=120");
    if(!sameTask(scope))return;
    const events=(data.events||[]).slice().reverse();
    els.historyList.replaceChildren(...events.map(event=>{
      const div=document.createElement("div");
      const isMessage=event.actor_type==="user"&&event.event_type==="user_review";
      const isAccept=event.actor_type==="user"&&event.event_type==="user_accept";
      const isReject=event.actor_type==="user"&&event.event_type==="user_reject";
      div.className="history-item"+(isMessage?" user-event":isAccept?" user-accept-event":isReject?" user-reject-event":"");
      div.id="history-"+(event.event_id||event.eventId||"");
      const title=document.createElement("div");title.className="event-title";title.textContent=eventLabel(event.event_type||event.eventType);
      const meta=document.createElement("div");meta.className="event-meta";
      meta.textContent=[formatTime(event.timestamp),event.actor_id||event.actorId,event.session_window_name||event.sessionWindowName].filter(Boolean).join(" · ");
      div.append(title,meta);
      if((isAccept||isReject)&&event.old_status&&event.new_status&&event.old_status!==event.new_status){
        const change=document.createElement("div");change.className="status-change";change.textContent="状态："+statusLabel(event.old_status)+" → "+statusLabel(event.new_status);div.append(change);
      }
      if(event.event_type==="user_message_reply"&&event.metadata?.replyToEventId){
        const replyTo=document.createElement("button");replyTo.type="button";replyTo.className="ghost small";replyTo.textContent="定位对应用户问题";
        replyTo.addEventListener("click",()=>{const target=els.userMessageList.querySelector('[data-message-event-id="'+event.metadata.replyToEventId+'"]');if(target)target.scrollIntoView({behavior:"smooth",block:"center"})});
        div.append(replyTo);
      }
      if(event.note){const note=document.createElement("div");note.className="event-note";note.textContent=event.note;div.append(note)}
      return div;
    }));
    if(!events.length)els.historyList.textContent="暂无事件记录";
  }catch(error){if(sameTask(scope))els.historyList.textContent="历史读取失败："+error.message}
}
async function mutateTask(endpoint,body,successMessage){
  const scope=selectedTaskScope();
  if(!scope){toast("项目或任务已经切换，请重新打开正确的任务",true);return;}
  try{
    await api("/api/projects/"+encodeURIComponent(scope.projectId)+"/tasks/"+encodeURIComponent(scope.task.id)+endpoint,{method:"POST",body});
    if(!sameTask(scope))return;
    els.taskDialog.close();
    await refreshAll(successMessage);
  }catch(error){if(sameTask(scope))toast(error.message,true)}
}
async function openAiSettings(){
  try{
    const data=await api("/api/ai-execution/settings"),s=data.settings||{};
    els.developerModel.value=s.developer?.model||"";
    els.developerReasoning.value=s.developer?.reasoning_effort||"high";
    els.testModel.value=s.test?.model||"";
    els.testReasoning.value=s.test?.reasoning_effort||"high";
    els.scanIntervalMinutes.value=s.scan_interval_minutes??10;
    els.maxRequestsPerChat.value=s.max_requests_per_chat??20;
    els.contextWarningAt.value=s.context_warning_at??15;
    els.timeoutRetryLimit.value=s.timeout_retry_limit??3;
    els.anomalyWindowMinutes.value=s.anomaly_window_minutes??10;
    els.anomalyLimit.value=s.anomaly_limit??6;
    els.roleSwitchLimit.value=s.role_switch_limit??3;
    els.aiSettingsDialog.showModal();
  }catch(error){toast("设置读取失败："+error.message,true)}
}
function aiSettingsPayload(){
  return {
    version:1,
    developer:{model:els.developerModel.value.trim(),reasoning_effort:els.developerReasoning.value},
    test:{model:els.testModel.value.trim(),reasoning_effort:els.testReasoning.value},
    scan_interval_minutes:Number(els.scanIntervalMinutes.value),
    max_requests_per_chat:Number(els.maxRequestsPerChat.value),
    context_warning_at:Number(els.contextWarningAt.value),
    timeout_retry_limit:Number(els.timeoutRetryLimit.value),
    anomaly_window_minutes:Number(els.anomalyWindowMinutes.value),
    anomaly_limit:Number(els.anomalyLimit.value),
    role_switch_limit:Number(els.roleSwitchLimit.value)
  };
}
function suggestProjectFields(){
  const root=els.projectRootInput.value.trim().replace(/[\\/]+$/,"");if(!root)return;
  const parts=root.split(/[\\/]+/),base=parts[parts.length-1]||"";
  if(!els.projectNameInput.value.trim())els.projectNameInput.value=base;
  const candidate=base.toLowerCase().replace(/[^a-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64);
  if(candidate&&!els.projectIdInput.value.trim())els.projectIdInput.value=candidate;
}

async function removeCurrentProject(){
  if(!state.projectId)return;
  const projectId=state.projectId,epoch=state.projectEpoch;
  const project=state.projects.find(item=>item.id===projectId);
  const name=project?.name||projectId;
  if(!window.confirm("确定将“"+name+"”从任务看板移除吗？只会解除任务看板管理关系，不会删除磁盘项目文件。"))return;
  els.removeProjectBtn.disabled=true;
  try{
    if(!sameProject(projectId,epoch))return;
    await api("/api/projects/"+encodeURIComponent(projectId),{method:"DELETE",body:{operationId:opId("project_remove")}});
    if(!sameProject(projectId,epoch))return;
    switchProject(null);
    await refreshAll("项目已从任务看板移除；磁盘项目文件未删除");
  }catch(error){
    toast("移除项目失败："+error.message,true);
  }finally{
    if(els.removeProjectBtn)els.removeProjectBtn.disabled=!state.projectId;
  }
}
els.projectStartRestartBtn.addEventListener("click",startOrRestartProjectService);
els.projectStopServiceBtn.addEventListener("click",stopProjectService);
els.aiSettingsBtn.addEventListener("click",openAiSettings);
els.closeAiSettingsBtn.addEventListener("click",()=>els.aiSettingsDialog.close());
els.cancelAiSettingsBtn.addEventListener("click",()=>els.aiSettingsDialog.close());
els.aiSettingsForm.addEventListener("submit",async event=>{
  event.preventDefault();
  try{
    const payload=aiSettingsPayload();
    const result=await api("/api/ai-execution/settings",{method:"PUT",body:{settings:payload}});
    els.aiSettingsDialog.close();
    await loadScanStatus();
    renderScanStatus();
    toast("AI自动执行设置已保存并应用；扫描间隔 "+result.settings.scan_interval_minutes+" 分钟");
  }catch(error){toast("设置保存失败："+error.message,true)}
});
els.addRequirementBtn.addEventListener("click",()=>{renderRequirements();els.requirementDialog.showModal();els.requirementText.focus()});
els.closeRequirementDialogBtn.addEventListener("click",()=>els.requirementDialog.close());
els.reloadRequirementsBtn.addEventListener("click",async()=>{await loadProject();renderRequirements();toast("需求队列已刷新")});
els.requirementForm.addEventListener("submit",async event=>{
  event.preventDefault();const text=els.requirementText.value.trim();if(!text)return;
  const projectId=state.projectId,epoch=state.projectEpoch;if(!projectId)return;
  try{
    await api("/api/projects/"+encodeURIComponent(projectId)+"/requirements",{method:"POST",body:{operationId:opId("requirement_create"),text}});
    if(!sameProject(projectId,epoch))return;
    els.requirementText.value="";await loadProject();renderRequirements();toast("需求已进入待AI拆解队列");
  }catch(error){toast(error.message,true)}
});
els.addProjectBtn.addEventListener("click",()=>{els.addProjectForm.reset();els.projectRegistryInput.value="待办任务总清单.md";els.addProjectDialog.showModal();els.projectRootInput.focus()});
els.removeProjectBtn.addEventListener("click",removeCurrentProject);
els.adaptProjectBtn.addEventListener("click",async()=>{
  const projectId=state.projectId,epoch=state.projectEpoch;
  if(!projectId)return;
  if(!window.confirm("当前项目格式不满足任务看板要求。是否保留原文档并自动追加任务看板机器注册区，同时创建P0补计划治理任务？"))return;
  try{if(!sameProject(projectId,epoch))return;await api("/api/projects/"+encodeURIComponent(projectId)+"/adapt",{method:"POST",body:{operationId:opId("project_adapt")}});if(!sameProject(projectId,epoch))return;await loadProjects();await loadProject();toast("项目格式已自动适配，已创建P0补计划治理任务")}
  catch(error){toast(error.message,true)}
});
els.closeAddProjectBtn.addEventListener("click",()=>els.addProjectDialog.close());
els.cancelAddProjectBtn.addEventListener("click",()=>els.addProjectDialog.close());
els.projectRootInput.addEventListener("blur",suggestProjectFields);
els.addProjectForm.addEventListener("submit",async event=>{
  event.preventDefault();suggestProjectFields();
  const epoch=state.projectEpoch;
  try{
    const result=await api("/api/projects",{method:"POST",body:{
      root:els.projectRootInput.value.trim(),name:els.projectNameInput.value.trim(),id:els.projectIdInput.value.trim(),
      taskRegistry:els.projectRegistryInput.value.trim()||"待办任务总清单.md"
    }});
    if(epoch!==state.projectEpoch)return;
    switchProject(result.project.id);els.addProjectDialog.close();
    const adaptationRequired=result.validation?.adaptationRequired===true;
    await refreshAll(adaptationRequired?"项目已登记，但格式不满足任务看板要求；可点击“自动适配当前项目”继续":"项目已验证并添加");
  }catch(error){toast(error.message,true)}
});
els.loginForm.addEventListener("submit",async event=>{
  event.preventDefault();
  try{const result=await api("/api/auth/login",{method:"POST",body:{secret:els.adminSecret.value}});state.csrfToken=result.csrfToken;els.adminSecret.value="";showApp();await refreshAll("已登录")}
  catch(error){toast(error.message,true)}
});
els.logoutBtn.addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST",body:{}})}catch{}showLogin()});
els.projectSelect.addEventListener("change",async()=>{switchProject(els.projectSelect.value);await loadProject();await loadProjectServiceStatus()});
els.refreshBtn.addEventListener("click",()=>refreshAll("已刷新"));
for(const input of[els.searchInput,els.planFilter,els.trackFilter,els.priorityFilter,els.statusFilter,els.archiveFilter]){
  input.addEventListener(input===els.searchInput?"input":"change",()=>{state.columnPages={};applyFilters();render()});
}
els.boardViewBtn.addEventListener("click",()=>{state.view="board";render()});
els.listViewBtn.addEventListener("click",()=>{state.view="list";render()});
els.closePlanDialogBtn.addEventListener("click",()=>els.planDialog.close());
els.closeDialogBtn.addEventListener("click",()=>els.taskDialog.close());
els.reloadHistoryBtn.addEventListener("click",loadHistory);
els.suspectDisconnectBtn.addEventListener("click",()=>mutateTask("/takeover/suspect",{operationId:opId("suspected_disconnect"),note:els.reviewNote.value.trim()||"用户标记疑似失联；尚未授权异常接管"},"已标记疑似失联（尚未授权接管）"));
els.allowTakeoverBtn.addEventListener("click",()=>{
  const note=els.reviewNote.value.trim();if(!note)return toast("允许异常接管前请填写现场核验依据",true);
  mutateTask("/takeover/allow",{operationId:opId("takeover_allowed"),note},"已允许异常接管；等待新执行助手显式接管");
});
els.revokeTakeoverBtn.addEventListener("click",()=>mutateTask("/takeover/revoke",{operationId:opId("takeover_revoked"),note:els.reviewNote.value.trim()||"用户撤销异常接管授权"},"异常接管授权已撤销"));
els.authorizeAutoCloseBtn.addEventListener("click",()=>mutateTask("/review",{operationId:opId("authorize_auto_close"),expectedRevision:state.selectedTask.registryRevision,action:"authorize_auto_close",note:els.reviewNote.value.trim()||"用户授权该低风险任务在独测/复测通过且无真实交付动作时自动完成"},"已授权该任务满足条件时自动完成"));
els.revokeAutoCloseBtn.addEventListener("click",()=>mutateTask("/review",{operationId:opId("revoke_auto_close"),expectedRevision:state.selectedTask.registryRevision,action:"revoke_auto_close",note:els.reviewNote.value.trim()||"用户撤销该任务自动完成授权"},"自动完成授权已撤销"));
els.savePriorityBtn.addEventListener("click",async()=>{
  const scope=selectedTaskScope();
  if(!scope){toast("项目或任务已切换，请重新打开正确的任务",true);return;}
  const priority=els.prioritySelect.value;
  try{
    await api("/api/projects/"+encodeURIComponent(scope.projectId)+"/tasks/"+encodeURIComponent(scope.task.id),{
      method:"PATCH",body:{operationId:opId("priority"),expectedRevision:scope.task.registryRevision,eventType:"priority_change",patch:{priority},note:"用户在任务看板调整优先级"}
    });
    if(!sameTask(scope))return;
    els.taskDialog.close();await refreshAll("优先级已更新");
  }catch(error){if(sameTask(scope))toast(error.message,true)}
});
els.commentBtn.addEventListener("click",()=>mutateTask("/review",{operationId:opId("review"),action:"comment",note:els.reviewNote.value},"审阅意见已保存"));
els.acceptBtn.addEventListener("click",()=>mutateTask("/review",{operationId:opId("accept"),expectedRevision:state.selectedTask.registryRevision,action:"accept",note:els.reviewNote.value},"审阅结果已保存"));
els.rejectBtn.addEventListener("click",()=>mutateTask("/review",{operationId:opId("reject"),expectedRevision:state.selectedTask.registryRevision,action:"reject",reason:els.rejectReason.value,note:els.reviewNote.value},"任务已按审阅意见打回"));
els.stopBtn.addEventListener("click",()=>mutateTask("/stop",{operationId:opId("stop"),expectedRevision:state.selectedTask.registryRevision,note:els.reviewNote.value||"用户从任务看板请求停止"},"停止请求已登记"));
els.resumeBtn.addEventListener("click",()=>mutateTask("/resume",{operationId:opId("resume"),expectedRevision:state.selectedTask.registryRevision,note:els.reviewNote.value||"用户从任务看板恢复任务"},"任务已恢复或停止请求已取消"));

(async()=>{await loadAppVersion();if(await restoreSession()){showApp();await refreshAll()}else showLogin()})();
setInterval(()=>{if(!els.appView.hidden&&!document.hidden&&!els.taskDialog.open&&!els.planDialog.open&&!els.requirementDialog.open)refreshAll()},5000);