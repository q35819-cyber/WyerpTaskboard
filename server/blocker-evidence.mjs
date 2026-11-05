// Only lifecycle evidence is authoritative; event remarks describe what was recorded, not a live diagnosis.
const abnormal = new Set(["阻断", "HOLD", "测试失败待修复"]);
const ids = /\bWTB-[A-Z0-9-]+-\d{8}-T\d+\b/g;
function visibleNote(note) {
  const raw = String(note || "").trim();
  if (!raw) return "";
  if (/(?:Bearer\s+\S+|(?:token|password|secret|cookie|authorization|api[_-]?key)\s*[:=]|sk-[A-Za-z0-9_-]{10,}|[\w.+-]+@[\w.-]+\.\w+|1[3-9]\d{9})/i.test(raw)) {
    return "原始备注包含可能敏感的信息；请从授权审计记录核验";
  }
  return raw.slice(0, 1200) + (raw.length > 1200 ? "（原文较长，已截断）" : "");
}
function latestTransition(task, events) {
  const list = Array.isArray(events) ? events : [];
  return [...list].reverse().find(e =>
    (!e.task_id || e.task_id === task.id) &&
    e.new_status === task.status && e.old_status !== task.status &&
    (task.status !== "测试失败待修复" ||
      ((e.event_type === "test_result" && e.actor_type === "test_ai" &&
        (e.metadata?.testResult === "fail" || e.metadata?.testResult === "FAIL" ||
         /(?:independent|test).*fail|^fail$/i.test(String(e.metadata?.result || "")))) ||
       e.event_type === "test_fail_return" && e.actor_type === "test_ai"))
  ) || null;
}
export function blockerEvidence(task, events = [], tasks = []) {
  if (!abnormal.has(task?.status)) return null;
  const transition = latestTransition(task, events);
  const prereqs = [...new Set(String(task.readDependencies || "").match(ids) || [])]
    .filter(id => id !== task.id)
    .map(id => {
      const found = tasks.find(item => item.id === id);
      return { id, status: found?.status || "未登记", completed: found?.status === "已完成" };
    }).filter(item => !item.completed);
  const metadata = transition?.metadata || {};
  const code = [metadata.errorCode, metadata.reasonCode, metadata.failureCode,
    metadata.blockCode, metadata.blockerCode, metadata.code]
    .find(value => /^[A-Z][A-Z0-9_]{2,79}$/.test(String(value || ""))) || null;
  const recordedCode = code || (String(transition?.note || "").match(/\b(?:CHECKPOINT_[A-Z0-9_]+|CLAIM_[A-Z0-9_]+|QA_[A-Z0-9_]+|TASK_[A-Z0-9_]+|[A-Z][A-Z0-9_]+_CONFLICT)\b/) || [])[0] || null;
  const reason = transition
    ? (recordedCode ? "事件记录：" + recordedCode : "已有进入当前状态的生命周期事件")
    : "缺少可信当前阻断依据，请核验";
  const recovery = task.status === "测试失败待修复"
    ? "原开发修复后重新三轮自测，交唯一独测重新判定"
    : task.status === "HOLD"
      ? "由授权总控核对暂停/拆分条件；未完成子项须先正式交付，禁止手工解除"
      : "先修复记录的阻断根因，由系统核验真实前置、STOP/占用后恢复";
  const extra = prereqs.length ? "；未完成前置：" + prereqs.map(x => x.id + "（" + x.status + "）").join("、") : "";
  const summary = reason + extra;
  return {
    summary: summary.slice(0, 240), currentStatus: task.status,
    source: transition ? "lifecycle_event" : "unverified",
    eventId: transition?.event_id || null, eventAt: transition?.timestamp || null,
    eventType: transition?.event_type || null, recordedCode,
    originalNote: visibleNote(transition?.note),
    historicalOnly: true, unresolvedDependencies: prereqs,
    recovery, verifiedCurrentCause: false,
    qualification: transition
      ? "该事件确曾使任务进入当前状态；备注为当时的记录，是否仍有相同技术根因须复核"
      : "未取得能证明当前异常原因的可信状态转换事件"
  };
}
