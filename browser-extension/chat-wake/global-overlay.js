(() => {
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.getManifest || !runtime?.sendMessage) return;
  const extensionVersion = runtime.getManifest().version;
  const existingHosts = Array.from(document.querySelectorAll("#wyerp-global-status-overlay-host"));
  const currentHost = existingHosts.find(
    node => node.dataset?.wyerpExtensionVersion === extensionVersion
  );
  if (currentHost) {
    for (const node of existingHosts) {
      if (node !== currentHost) node.remove();
    }
    return;
  }
  for (const node of existingHosts) node.remove();
  globalThis.__WYERP_GLOBAL_STATUS_OVERLAY_ACTIVE__ = extensionVersion;

  const host = document.createElement("div");
  host.id = "wyerp-global-status-overlay-host";
  host.dataset.wyerpExtensionVersion = extensionVersion;
  host.style.cssText = "all:initial;position:fixed;top:10px;right:10px;z-index:2147483647!important;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <style>
      .card{width:360px;box-sizing:border-box;background:rgba(18,18,22,.94);color:#f5f7fb;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:10px 12px;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.28);pointer-events:auto;backdrop-filter:blur(8px)}
      .row{display:flex;gap:8px;align-items:center;min-width:0}.top{font-weight:700;font-size:13px}.grow{flex:1;min-width:0}.muted{opacity:.72}.ok{color:#7ce59b}.warn{color:#ffd166}.bad{color:#ff7b7b}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.small{font-size:11px}.hidden{display:none}
      button{all:unset;cursor:pointer;padding:1px 5px;border-radius:5px;background:rgba(255,255,255,.08)}
    </style>
    <div class="card">
      <div class="row top"><span id="lamp">●</span><span class="grow">Wyerp 全局状态</span><span id="age" class="muted small">--</span><button id="toggle">－</button></div>
      <div id="detail">
        <div class="row"><span class="muted">任务</span><span id="task" class="grow small">等待状态</span></div>
        <div class="row"><span class="muted">动作</span><span id="phase" class="grow">--</span></div>
        <div class="row"><span class="muted">ChatGPT</span><span id="chat" class="grow">--</span></div>
        <div class="row"><span class="muted">双通道</span><span id="channels" class="grow">扩展 -- / 截图 --</span></div>
        <div class="row"><span class="muted">异常</span><span id="anomaly" class="grow">--</span></div>
      </div>
    </div>`;
  shadow.appendChild(wrap);
  (document.documentElement || document.body).appendChild(host);

  const $ = selector => wrap.querySelector(selector);
  let collapsed = false;
  let lastOkAt = 0;
  let pollTimer = null;
  let retired = false;

  function isContextInvalidated(error) {
    return /Extension context invalidated/i.test(String(error?.message || error || ""));
  }

  function retireInvalidContext(error) {
    if (retired) return;
    retired = true;
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    host.remove();
    if (globalThis.__WYERP_GLOBAL_STATUS_OVERLAY_ACTIVE__ === extensionVersion) {
      delete globalThis.__WYERP_GLOBAL_STATUS_OVERLAY_ACTIVE__;
    }
    // LOG-IGNORE: extension reload invalidates the old runtime by design. The timer and host
    // are already retired locally, and using console.warn here makes Chrome surface a handled
    // lifecycle event as an extension error.
  }

  $("#toggle").addEventListener("click", () => {
    collapsed = !collapsed;
    $("#detail").classList.toggle("hidden", collapsed);
    $("#toggle").textContent = collapsed ? "＋" : "－";
  });

  const uiStateText = value => ({
    stable: "稳定待命",
    idle: "空闲",
    generating: "生成中",
    processing: "处理中",
    processing_delayed: "处理延迟",
    execution_error: "执行异常",
    waiting: "等待中"
  })[String(value || "")] || "状态待确认";
  const phaseText = value => ({
    executing: "执行中",
    idle: "空闲",
    monitoring: "监控中",
    waiting: "等待中"
  })[String(value || "")] || uiStateText(value);
  const crossCheckText = value => ({
    pending: "等待核对",
    agree: "双通道一致",
    observe: "状态不一致，需复核"
  })[String(value || "")] || "尚未核对";
  const anomalyText = value => ({
    candidate_unleased_stalled: "候选任务长时间未领取",
    extension_runtime_outdated: "浏览器扩展版本过旧",
    extension_contract_mismatch: "浏览器扩展版本配置不一致",
    processing_delayed: "ChatGPT 处理延迟",
    execution_error: "ChatGPT 执行错误",
    generating_stalled: "ChatGPT 生成疑似停滞",
    dispatcher_stale: "浏览器调度连接已过期",
    approval_required: "等待用户授权",
    version_contract_not_current: "运行组件版本不一致"
  })[String(value || "")] || "系统检测到异常，请查看总日志";
  const activeTaskText = (roleName, items) => {
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return roleName + "：空闲";
    return roleName + "：" + list.slice(0, 3).map(item => {
      const id = String(item?.task_id || "未知任务");
      const name = String(item?.name || id);
      return id + " / " + name;
    }).join("；");
  };

  function paint(payload) {
    const ok = payload?.ok === true;
    const status = payload?.status || null;
    const rawAnomalies = Array.isArray(status?.anomalies) ? status.anomalies : [];
    const anomalyLabels = rawAnomalies.map(anomalyText);
    if (!ok) anomalyLabels.unshift("状态服务不可用");
    else if (status?.chatgpt_health?.healthy === false && anomalyLabels.length === 0) anomalyLabels.push("ChatGPT 健康检查异常");
    const degraded = anomalyLabels.length > 0;
    if (ok) lastOkAt = Date.now();
    $("#lamp").className = degraded ? "bad" : "ok";
    const activity = status?.activity || {};
    const activeTasks = status?.active_tasks || {};
    const developerTasks = Array.isArray(activeTasks.developer) ? activeTasks.developer : [];
    const testTasks = Array.isArray(activeTasks.test) ? activeTasks.test : [];
    const hasEngineeringTask = developerTasks.length + testTasks.length > 0;
    $("#task").textContent = activeTaskText("开发AI", developerTasks) + "；" + activeTaskText("测试AI", testTasks);
    $("#phase").textContent = anomalyLabels.length
      ? "异常待处理：" + anomalyLabels[0] + "；下一步：查看异常详情"
      : (hasEngineeringTask ? "后台工程任务执行中" : phaseText(activity.phase || activity.ui_state || "idle"));
    $("#chat").textContent = status?.bridge?.dispatcher?.fresh === false
      ? "浏览器调度连接已过期"
      : uiStateText(activity.ui_state || status?.chatgpt_health?.chatgpt_bridge?.ui_state);
    const browser = status?.channels?.browser_extension;
    const visual = status?.channels?.visual_snapshot;
    $("#channels").textContent =
      "扩展 " + (browser?.fresh ? "正常" : "异常") +
      " / 截图 " + (visual?.available ? "正常" : (visual?.checked ? "异常" : "未检查")) +
      " / " + crossCheckText(status?.channels?.cross_check);
    $("#anomaly").textContent = anomalyLabels.length ? anomalyLabels.slice(0, 3).join("；") : "无";
    const age = lastOkAt ? Math.max(0, Math.round((Date.now() - lastOkAt) / 1000)) : null;
    $("#age").textContent = ok ? "刚更新" : (age == null ? "离线" : "离线 " + age + "秒");
  }

  async function tick() {
    if (retired) return;
    try {
      const result = await runtime.sendMessage({ type: "WYERP_GET_GLOBAL_STATUS" });
      paint(result || { ok: false });
    } catch (error) {
      paint({ ok: false });
      if (isContextInvalidated(error)) {
        retireInvalidContext(error);
        return;
      }
      try {
        await runtime.sendMessage({
          type: "WYERP_EXTENSION_LOG_EVENT",
          source: "overlay",
          level: "warning",
          event: "status_poll_failed",
          error_message: String(error?.message || error || "unknown").slice(0, 1200)
        });
      } catch (logError) {
        if (isContextInvalidated(logError)) {
          retireInvalidContext(logError);
          return;
        }
        console.warn("Wyerp overlay log report failed:", logError?.message || logError);
      }
    }
  }

  pollTimer = setInterval(() => { void tick(); }, 2000);
  void tick();
})();