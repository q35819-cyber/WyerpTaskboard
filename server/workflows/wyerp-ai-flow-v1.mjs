import { TaskboardError } from "../core/errors.mjs";

const priorities = ["P0", "P1", "P2"];
const tracks = ["product", "bugfix", "infrastructure"];
function isValidTrack(track) {
  const value = String(track || "").trim();
  if (tracks.includes(value)) return true;
  return /^product\/[A-Za-z0-9][A-Za-z0-9+._-]*(?:\/[A-Za-z0-9][A-Za-z0-9+._-]*)*$/.test(value);
}
function trackRank(track) {
  const value = String(track || "").trim();
  if (value === "product" || value.startsWith("product/")) return 0;
  if (value === "bugfix") return 1;
  if (value === "infrastructure") return 2;
  return 99;
}
const deliveryActionTypes = [
  "candidate_merge", "deploy_switch", "artifact_release", "database_migration",
  "authorized_restart", "post_test_production_verification", "release_record_sync"
];
const deliveryActionSet = new Set(deliveryActionTypes);
const statuses = [
  "待确认", "待准备", "待开发", "开发中", "待独测", "独测中",
  "测试失败待修复", "修复中", "待复测", "复测中", "待交付", "交付中",
  "待用户验收", "已完成", "阻断", "HOLD", "已取消"
];
const transitions = new Map([
  ["待确认", new Set(["待准备", "HOLD", "已取消"])],
  ["待准备", new Set(["开发中", "待开发", "待独测", "待复测", "阻断", "HOLD", "已取消"])],
  ["待开发", new Set(["开发中", "阻断", "HOLD", "已取消"])],
  ["开发中", new Set(["待独测", "阻断", "HOLD"])],
  ["待独测", new Set(["独测中", "测试失败待修复", "待准备", "待确认", "阻断", "HOLD"])],
  ["独测中", new Set(["待交付", "待用户验收", "已完成", "测试失败待修复", "待准备", "阻断", "HOLD"])],
  ["测试失败待修复", new Set(["修复中", "阻断", "HOLD", "已取消"])],
  ["修复中", new Set(["待复测", "阻断", "HOLD"])],
  ["待复测", new Set(["复测中", "测试失败待修复", "待准备", "待确认", "阻断", "HOLD"])],
  ["复测中", new Set(["待交付", "待用户验收", "已完成", "测试失败待修复", "阻断", "HOLD"])],
  ["待交付", new Set(["交付中", "阻断", "HOLD"])],
  ["交付中", new Set(["待用户验收", "待复测", "阻断", "HOLD"])],
  ["待用户验收", new Set(["已完成", "测试失败待修复", "待准备", "待确认", "HOLD"])],
  ["阻断", new Set(["待确认", "待准备", "待开发", "待独测", "待复测", "HOLD", "已取消"])],
  ["HOLD", new Set(["待确认", "待准备", "待开发", "测试失败待修复", "待独测", "待复测", "待交付", "已取消"])],
  ["已完成", new Set()],
  ["已取消", new Set()],
]);

const fixedPlannedRoleByStatus = new Map([
  ["待确认", "用户"], ["待准备", "开发AI"], ["待开发", "开发AI"], ["开发中", "开发AI"],
  ["待独测", "独立测试AI"], ["独测中", "独立测试AI"], ["测试失败待修复", "开发AI"], ["修复中", "开发AI"],
  ["待复测", "独立测试AI"], ["复测中", "独立测试AI"], ["待用户验收", "用户"],
  ["已完成", ""], ["HOLD", ""], ["已取消", ""]
]);
const deliveryStatuses = new Set(["待交付", "交付中"]);
function canonicalRole(value) { const role = String(value ?? "").trim(); return role === "—" ? "" : role; }
function validRole(role) { return ["", "开发AI", "独立测试AI", "用户"].includes(role); }

export const wyerpAiFlowV1 = {
  id: "wyerp-ai-flow-v1",
  priorities,
  tracks,
  statuses,
  roles: ["开发AI", "独立测试AI", "用户", "—"],
  boardColumns: [
    { id: "todo", title: "待处理 / 待认领", statuses: ["待确认", "待准备", "待开发"], derived: "developer_candidate_state" },
    { id: "awaiting_work", title: "待执行", statuses: ["待独测", "待复测"] },
    { id: "executing", title: "执行中", statuses: ["开发中", "修复中", "交付中", "独测中", "复测中"] },
    { id: "awaiting_delivery_user", title: "待交付 / 待用户", statuses: ["待交付", "待用户验收"] },
    { id: "blocked", title: "失败 / 阻断 / 暂停", statuses: ["测试失败待修复", "阻断", "HOLD"] },
    { id: "done", title: "完成", statuses: ["已完成", "已取消"] }
  ],
  validatePriority(priority) {
    if (!priorities.includes(priority)) throw new TaskboardError(`非法优先级: ${priority}`, { code: "INVALID_PRIORITY", status: 400 });
  },
  validateTrack(track) {
    if (!isValidTrack(track)) throw new TaskboardError("非法track: " + track, { code: "INVALID_TRACK", status: 400 });
  },
  validateStatus(status) {
    if (!statuses.includes(status)) throw new TaskboardError(`非法任务阶段: ${status}`, { code: "INVALID_STATUS", status: 400 });
  },
  assertTransition(from, to) {
    this.validateStatus(from); this.validateStatus(to);
    if (from === to) return;
    if (!transitions.get(from)?.has(to)) {
      throw new TaskboardError(`非法状态流转: ${from} → ${to}`, {
        code: "INVALID_STATUS_TRANSITION", status: 409, details: { from, to },
      });
    }
  },
  plannedRoleForStatus(status, { currentRole = "", suppliedRole, hasSuppliedRole = false, statusChanging = false } = {}) {
    this.validateStatus(status);
    if (fixedPlannedRoleByStatus.has(status)) return fixedPlannedRoleByStatus.get(status);
    if (deliveryStatuses.has(status)) {
      const role = hasSuppliedRole ? canonicalRole(suppliedRole) : canonicalRole(currentRole);
      if (!role || !validRole(role)) {
        throw new TaskboardError("待交付/交付中必须保留已登记的真实交付执行角色", {
          code: "DELIVERY_ROLE_REQUIRED", status: 409, details: { status, role: role || null }
        });
      }
      return role;
    }
    if (status === "阻断") {
      const role = hasSuppliedRole ? canonicalRole(suppliedRole) : (statusChanging ? "" : canonicalRole(currentRole));
      if (!validRole(role)) throw new TaskboardError("阻断阶段计划角色非法", {
        code: "INVALID_PLANNED_ROLE", status: 409, details: { status, role }
      });
      return role;
    }
    throw new TaskboardError("任务阶段缺少计划角色规则: " + status, { code: "STATUS_ROLE_RULE_MISSING", status: 500 });
  },
  normalizeTaskPatch(task, patch = {}) {
    const normalized = { ...patch };
    const stateKeys = ["status", "plannedRole", "assignee", "sessionWindowName", "sessionId"];
    if (!stateKeys.some((key) => key in normalized)) return normalized;

    const statusChanging = "status" in normalized;
    const targetStatus = statusChanging ? String(normalized.status) : task.status;
    if (statusChanging) this.assertTransition(task.status, targetStatus);
    const hasSuppliedRole = "plannedRole" in normalized;
    const expectedRole = this.plannedRoleForStatus(targetStatus, {
      currentRole: task.plannedRole, suppliedRole: normalized.plannedRole, hasSuppliedRole, statusChanging
    });
    if (hasSuppliedRole && canonicalRole(normalized.plannedRole) !== expectedRole) {
      throw new TaskboardError(`阶段 ${targetStatus} 的计划角色必须为 ${expectedRole || "—"}`, {
        code: "STATUS_ROLE_MISMATCH", status: 409,
        details: { targetStatus, expectedRole: expectedRole || "—", suppliedRole: normalized.plannedRole || "—" }
      });
    }
    normalized.plannedRole = expectedRole;

    const targetIsExecution = this.isExecutionStatus(targetStatus);
    if (statusChanging && !targetIsExecution) {
      normalized.assignee = "";
      normalized.sessionWindowName = "";
      normalized.sessionId = "";
    }

    const next = { ...task, ...normalized, plannedRole: canonicalRole(normalized.plannedRole) };
    if (targetIsExecution) {
      if (!next.assignee || !next.sessionWindowName || !next.sessionId) {
        throw new TaskboardError("进入执行中阶段必须同时具备负责人、会话窗口和Session；请使用正式claim/接管入口", {
          code: "EXECUTION_IDENTITY_REQUIRED", status: 409,
          details: { targetStatus, assignee: next.assignee || null, sessionWindowName: next.sessionWindowName || null, sessionId: next.sessionId || null }
        });
      }
    } else if (next.assignee || next.sessionWindowName || next.sessionId) {
      throw new TaskboardError("非执行阶段不得保留负责人或Session占用", {
        code: "NON_EXECUTION_OWNER_FORBIDDEN", status: 409,
        details: { targetStatus, assignee: next.assignee || null, sessionWindowName: next.sessionWindowName || null, sessionId: next.sessionId || null }
      });
    }
    return normalized;
  },
  deliveryActionTypes,
  resolveIndependentTestOutcome(status, result, { deliveryDisposition = "", deliveryActions = [], autoCloseAuthorized = false } = {}) {
    if (!["独测中", "复测中"].includes(status)) return null;
    if (result === "fail") return { status: "测试失败待修复", plannedRole: "开发AI", deliveryDisposition: null, deliveryActions: [] };
    if (result === "blocked") return { status: "阻断", plannedRole: "—", deliveryDisposition: null, deliveryActions: [] };
    if (result !== "pass") return null;
    const disposition = String(deliveryDisposition || "").trim();
    if (!disposition) throw new TaskboardError("测试通过后必须明确交付必要性判定", { code: "DELIVERY_DISPOSITION_REQUIRED", status: 400 });
    if (!["required", "user_acceptance", "auto_close"].includes(disposition)) {
      throw new TaskboardError("未知交付必要性判定: " + disposition, { code: "INVALID_DELIVERY_DISPOSITION", status: 400 });
    }
    const actions = Array.isArray(deliveryActions) ? deliveryActions.map((x) => String(x || "").trim()).filter(Boolean) : [];
    const invalid = actions.filter((action) => !deliveryActionSet.has(action));
    if (invalid.length) throw new TaskboardError("存在不允许的交付动作: " + invalid.join(", "), { code: "INVALID_DELIVERY_ACTION", status: 400, details: { invalid } });
    if (disposition === "required") {
      if (!actions.length) throw new TaskboardError("判定需要交付时必须提供至少一个真实交付动作", { code: "DELIVERY_ACTION_REQUIRED", status: 400 });
      return { status: "待交付", plannedRole: "开发AI", deliveryDisposition: disposition, deliveryActions: actions };
    }
    if (actions.length) throw new TaskboardError("无交付动作路径不能携带deliveryActions", { code: "DELIVERY_ACTION_NOT_ALLOWED", status: 400 });
    if (disposition === "user_acceptance") return { status: "待用户验收", plannedRole: "用户", deliveryDisposition: disposition, deliveryActions: [] };
    if (!autoCloseAuthorized) throw new TaskboardError("该任务没有用户明确的低风险自动闭环授权", { code: "AUTO_CLOSE_NOT_AUTHORIZED", status: 409 });
    return { status: "已完成", plannedRole: "", deliveryDisposition: disposition, deliveryActions: [] };
  },
  isExecutableDeliveryDecision(metadata = {}) {
    const actions = Array.isArray(metadata.deliveryActions) ? metadata.deliveryActions : [];
    return metadata.testResult === "pass" && metadata.deliveryDisposition === "required" && actions.length > 0 && actions.every((action) => deliveryActionSet.has(action));
  },
  isExecutionStatus(status) {
    return ["开发中", "修复中", "独测中", "复测中", "交付中"].includes(status);
  },
  resumeTargetForStatus(status) {
    return ({
      "开发中": "待开发",
      "修复中": "测试失败待修复",
      "独测中": "待独测",
      "复测中": "待复测",
      "交付中": "待交付"
    })[status] || status;
  },
  reviewRejectTarget(reason) {
    const target = ({
      defect: "测试失败待修复",
      evidence: "待准备",
      decision: "待确认",
      hold: "HOLD"
    })[reason];
    if (!target) throw new TaskboardError("未知打回原因: " + reason, { code: "INVALID_REVIEW_REASON", status: 400 });
    return target;
  },
  sortKey(task) {
    const p = Math.max(0, priorities.indexOf(task.priority));
    const t = trackRank(task.track);
    return p * 10 + t;
  },
};

