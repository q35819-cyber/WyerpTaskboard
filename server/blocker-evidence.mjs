// Status-transition remarks are historical. Only a fresh, matching scanner entry proves a current blocker.
const abnormal = new Set(["阻断", "HOLD", "测试失败待修复"]);
const ids = /\bWTB-[A-Z0-9-]+-\d{8}-T\d+\b/g;

function visibleNote(note) {
  const raw = String(note ?? "");
  if (!raw.trim()) return "";
  if (/(?:Bearer\s+\S+|(?:token|password|secret|cookie|authorization|api[_-]?key)\s*[:=]|sk-[A-Za-z0-9_-]{10,}|[\w.+-]+@[\w.-]+\.\w+|1[3-9]\d{9})/i.test(raw)) {
    return "原始备注包含可能敏感的信息；请从授权审计记录核验";
  }
  return raw;
}

function latestTransition(task, events) {
  return [...(Array.isArray(events) ? events : [])].reverse().find(e =>
    (!e.task_id || e.task_id === task.id) &&
    e.new_status === task.status && e.old_status !== task.status &&
    (task.status !== "测试失败待修复" ||
      (e.actor_type === "test_ai" &&
        ((e.event_type === "test_result" && String(e.metadata?.testResult).toLowerCase() === "fail") ||
          e.event_type === "test_fail_return")))
  ) || null;
}

export function qaFailReportPath(task, events) {
  if (task?.status !== "测试失败待修复") return null;
  const candidate = latestTransition(task, events)?.metadata?.reportPath;
  if (typeof candidate !== "string" || !candidate.startsWith("reports/" + task.id + "/") ||
      !/^reports\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+\.md$/.test(candidate) ||
      candidate.includes("..")) return null;
  return candidate;
}

function verifiedScan(task, options) {
  const now = Number.isFinite(options?.now) ? options.now : Date.now();
  if (!options?.projectId || !options?.registryRevision || !Array.isArray(options?.scanCandidates)) return null;
  return options.scanCandidates.find(item => item.project_id === options.projectId &&
    item.task_id === task.id && item.status === task.status &&
    item.task_updated_at === task.updatedAt &&
    item.registry_revision === options.registryRevision &&
    !item.stale_at && !item.consumed_at &&
    Number.isFinite(Date.parse(item.detected_at)) &&
    Date.parse(item.detected_at) <= now && now - Date.parse(item.detected_at) < 30 * 60 * 1000 &&
    Date.parse(item.expires_at) > now &&
    Array.isArray(item.blockers) && item.blockers.length > 0 &&
    item.blockers.every(value => typeof value === "string" && value.trim().length > 0)) || null;
}

function failureItems(reportText, metadata) {
  const extracted = String(reportText || "").split(/\r?\n/)
    .filter(line => /(?:\bF\d{2}\b|复现实测|测试失败|独测.*FAIL|^\s*#{1,4}\s*.*(?:问题|失败|根因))/i.test(line))
    .map(line => visibleNote(line.replace(/^\s*(?:#{1,5}\s*|[-*]\s*)/, "").replace(/\*\*/g, "").trim()))
    .filter(Boolean).slice(0, 6);
  if (extracted.length) return extracted;
  return Array.isArray(metadata?.failureItems)
    ? metadata.failureItems.filter(x => typeof x === "string").slice(0, 6).map(visibleNote)
    : [];
}

export function blockerEvidence(task, events = [], tasks = [], options = {}) {
  if (!abnormal.has(task?.status)) return null;
  const transition = latestTransition(task, events);
  const prereqs = [...new Set(String(task.readDependencies || "").match(ids) || [])]
    .filter(id => id !== task.id).map(id => {
      const found = tasks.find(item => item.id === id);
      return { id, status: found?.status || "未登记", completed: found?.status === "已完成" };
    }).filter(item => !item.completed);
  const metadata = transition?.metadata || {};
  const code = [metadata.errorCode, metadata.reasonCode, metadata.failureCode,
    metadata.blockCode, metadata.blockerCode, metadata.code]
    .find(value => /^[A-Z][A-Z0-9_]{2,79}$/.test(String(value || ""))) || null;
  const recordedCode = code || (String(transition?.note || "").match(
    /\b(?:CHECKPOINT_[A-Z0-9_]+|CLAIM_[A-Z0-9_]+|QA_[A-Z0-9_]+|TASK_[A-Z0-9_]+|[A-Z][A-Z0-9_]+_CONFLICT)\b/
  ) || [])[0] || null;
  const scan = verifiedScan(task, options);
  const currentCause = scan ? visibleNote(scan.blockers[0]) : "";
  const reason = currentCause
    ? "当前机器扫描：" + currentCause
    : transition ? (recordedCode ? "历史事件：" + recordedCode : "历史生命周期事件；当前根因未核验")
      : "缺少可信当前阻断依据，请核验";
  const recovery = task.status === "测试失败待修复"
    ? "原开发修复后重新三轮自测，交唯一独测重新判定"
    : task.status === "HOLD"
      ? "由授权总控核对暂停/拆分条件；未完成子项须先正式交付，禁止手工解除"
      : "先修复记录的阻断根因，由系统核验真实前置、STOP/占用后恢复";
  const extra = prereqs.length ? "；未完成前置：" + prereqs.map(x => x.id + "（" + x.status + "）").join("、") : "";
  const reportPath = qaFailReportPath(task, events);
  return {
    summary: (reason + extra).slice(0, 240), currentStatus: task.status,
    source: currentCause ? "machine_scan" : transition ? "lifecycle_event" : "unverified",
    eventId: transition?.event_id || null, eventAt: transition?.timestamp || null,
    eventType: transition?.event_type || null, recordedCode,
    reportPath, failureItems: reportPath ? failureItems(options.reportText, metadata) : [],
    machineScanAt: currentCause ? scan.detected_at : null,
    originalNote: visibleNote(transition?.note),
    historicalOnly: !currentCause, unresolvedDependencies: prereqs,
    recovery, verifiedCurrentCause: Boolean(currentCause),
    qualification: currentCause
      ? "来源为同项目、同任务、同状态、同版本且未过期的机器扫描；执行前仍需重新核验"
      : transition
        ? "仅有当时的状态转换事件，不能证明历史故障现在仍在发生"
        : "未取得能证明当前异常原因的可信状态转换事件或机器扫描"
  };
}
