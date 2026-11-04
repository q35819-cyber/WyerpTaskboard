import crypto from "node:crypto";
import { withProjectLock } from "./core/project-lock.mjs";

// Trusted, finite legacy split registry. Original controller events contain only prose,
// so never infer a new parent/child relationship from arbitrary notes or task titles.
export const approvedSplitParents = Object.freeze({
  "WTB-P0-ROLE-STEPS-SERVER-GATES-20261102-T1": {
    splits: [
      { id: "evt_b33dd1d5efad1eac1ce202b8", type: "controller_minimal_function_split_20261104", children: [
        "WTB-P0-STEP-CURSOR-20261104-T1", "WTB-P0-STEP-STATE-GATE-20261104-T1",
        "WTB-P0-ROLE-NEXT-QUEUE-20261104-T1", "WTB-P0-COMPLETE-SAFE-CLEAN-20261104-T1"
      ] },
      { id: "evt_68208d84ad8b2e2c25a30dcf", type: "controller_split_completion_addendum_20261104", children: [
        "WTB-P0-STEP-STARTUP-C00-20261104-T1", "WTB-P0-STEP-REPORT-EVIDENCE-20261104-T1"
      ] }
    ]
  },
  "WTB-P1-UNIVERSAL-SOFTWARE-WORKFLOW-TEMPLATE-20261031-T1": {
    splits: [
      { id: "evt_e765c6209d9f36225866620b", type: "controller_minimal_function_split_20261104", children: [
        "WTB-P1-ONBOARD-STACK-IDENTIFY-20261104-T1", "WTB-P1-ONBOARD-PROJECT-REGISTER-20261104-T1",
        "WTB-P1-ONBOARD-FLOW-TEMPLATE-20261104-T1", "WTB-P1-ONBOARD-COMMAND-VERIFY-20261104-T1",
        "WTB-P1-CROSS-PROJECT-QA-VIEW-20261104-T1"
      ] }
    ]
  }
});

const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const sameSet = (actual, expected) => Array.isArray(actual)
  && actual.length === expected.length && new Set(actual).size === expected.length
  && expected.every(id => actual.includes(id));
const sha40 = value => /^[a-f0-9]{40}$/i.test(String(value || ""));
const sha64 = value => /^[a-f0-9]{64}$/i.test(String(value || ""));

export class SplitParentReconciler {
  constructor(taskStore, { requirementStore = null } = {}) {
    this.store = taskStore;
    this.requirements = requirementStore;
  }

  async reconcile(projectId) {
    const snapshot = await this.store.snapshot(projectId);
    const byId = new Map(snapshot.tasks.map(task => [task.id, task]));
    const parentIds = Object.keys(approvedSplitParents).filter(id => byId.has(id));
    if (!parentIds.length) return [];
    const allIds = [...new Set(parentIds.flatMap(id => [id,
      ...approvedSplitParents[id].splits.flatMap(split => split.children)]))];
    const history = await this.store.events.listProjectTaskEvents(projectId, allIds, { all: true });
    const requirements = this.requirements
      ? await this.requirements.pending(projectId) : { pendingCount: 0, waitingUserCount: 0 };
    const output = [];

    for (const parentId of parentIds) {
      const parent = byId.get(parentId), definition = approvedSplitParents[parentId];
      const children = definition.splits.flatMap(split => split.children);
      const parentHistory = history.get(parentId) || [];
      const blockers = [];
      const completed = [];
      const childDeliveryEvents = [];
      const expectedSplits = definition.splits.map(split => split.id);

      if (!["HOLD", "阻断", "已取消"].includes(parent.status)) {
        blockers.push("父任务状态不是可信拆分暂缓状态：" + parent.status);
      }
      for (const split of definition.splits) {
        const event = parentHistory.find(item => item.event_id === split.id);
        if (!event || event.task_id !== parentId || event.actor_type !== "controller_ai"
          || !event.actor_id || event.event_type !== split.type
          || !split.children.every(childId => String(event.note || "").includes(childId))) {
          blockers.push("正式拆分事件缺失或不匹配：" + split.id);
        }
      }

      for (const childId of children) {
        const child = byId.get(childId);
        if (!child) { blockers.push("子任务未登记：" + childId); continue; }
        if (child.status !== "已完成") {
          blockers.push("子任务未完成：" + childId + "（" + child.status + "）");
          continue;
        }
        if ((await this.store.stopState(projectId, childId)).stopRequested) {
          blockers.push("子任务仍有STOP：" + childId); continue;
        }
        const events = history.get(childId) || [];
        const qa = [...events].reverse().find(event => event.event_type === "test_result");
        const delivery = [...events].reverse().find(event => event.event_type === "delivery_complete");
        if (!qa || qa.actor_type !== "test_ai" || qa.metadata?.testResult !== "pass"
          || !sha40(qa.metadata?.commitSha) || !qa.metadata?.reportPath
          || !delivery || delivery.actor_type !== "controller_ai" || !delivery.actor_id
          || delivery.new_status !== "已完成" || delivery.metadata?.deliveryVerified !== true
          || delivery.metadata?.postMergeRegressionResult !== "PASS"
          || delivery.metadata?.independentPassEventId !== qa.event_id
          || delivery.metadata?.candidateCommitSha !== qa.metadata.commitSha
          || !sha40(delivery.metadata?.mergeCommitSha)
          || delivery.metadata?.mergeCommitSha !== delivery.metadata?.remoteMainSha
          || !sha64(delivery.metadata?.postMergeReportSha256)
          || Date.parse(delivery.timestamp) < Date.parse(qa.timestamp)
          || events.some(event => Date.parse(event.timestamp) > Date.parse(delivery.timestamp)
            && (event.event_type === "code_change" || event.metadata?.invalidatesTestEvidence === true))) {
          blockers.push("子任务独测/总控交付证据不足：" + childId);
          continue;
        }
        const journal = await this.store.transactions.read(delivery.operation_id);
        if (journal?.state !== "committed" || journal.projectId !== projectId
          || journal.taskId !== childId || journal.eventId !== delivery.event_id
          || journal.result?.eventId !== delivery.event_id) {
          blockers.push("子任务交付事务未正式提交：" + childId);
          continue;
        }
        completed.push(childId);
        childDeliveryEvents.push(delivery);
      }

      if (requirements.pendingCount || requirements.waitingUserCount) {
        blockers.push("仍有待处理或待用户补充的需求");
      }
      if ((await this.store.stopState(projectId, parentId)).stopRequested) {
        blockers.push("父任务仍有STOP");
      }
      if (parent.assignee || parent.sessionId) blockers.push("父任务存在执行占用");

      const clearance = [...parentHistory].reverse().find(event =>
        event.event_type === "controller_split_parent_integration_verified");
      const latestDelivery = Math.max(0, ...childDeliveryEvents.map(event => Date.parse(event.timestamp) || 0));
      const clearanceValid = Boolean(clearance && clearance.actor_type === "controller_ai"
        && clearance.actor_id && clearance.task_id === parentId
        && clearance.metadata?.parentTaskId === parentId
        && clearance.metadata?.integrationResult === "NO_REMAINING_SCOPE"
        && clearance.metadata?.noIndependentIntegrationRequired === true
        && sameSet(clearance.metadata?.splitEventIds, expectedSplits)
        && sameSet(clearance.metadata?.childTaskIds, children)
        && Array.isArray(clearance.metadata?.outstandingIntegrationActions)
        && clearance.metadata.outstandingIntegrationActions.length === 0
        && Date.parse(clearance.timestamp) >= latestDelivery
        && !parentHistory.some(event => Date.parse(event.timestamp) > Date.parse(clearance.timestamp)
          && (event.actor_type === "user" || event.event_type === "controller_split_parent_integration_revoked")));
      if (!clearanceValid) blockers.push("缺少全部子项交付后的总控无剩余集成缺口确认");

      const operationId = clearanceValid ? "split_parent_reconcile." +
        hash(projectId + "|" + parentId + "|" + clearance.event_id).slice(0, 48) : null;
      if (parent.status === "已取消" && operationId) {
        const prior = await this.store.transactions.read(operationId);
        if (prior && !["committed", "aborted_no_effect"].includes(prior.state)) {
          await withProjectLock(this.store.rootDir, projectId, operationId, async () => {
            const pending = await this.store.transactions.read(operationId);
            if (pending && pending.state !== "committed") {
              const result = await this.store.recoverTransaction(pending);
              if (result.action === "inconsistent") throw new Error("拆分父项归档事务恢复不一致");
            }
          });
        }
      }
      const archivedTransaction = parent.status === "已取消" && operationId
        ? await this.store.transactions.read(operationId) : null;
      if (parent.status === "已取消" && archivedTransaction?.state !== "committed") {
        blockers.push("已取消父项缺少可信系统归档事务");
      }
      const record = { parent_id: parentId, status: parent.status,
        children_total: children.length, children_verified: completed.length,
        children_remaining: children.length - completed.length, blockers,
        archived: parent.status === "已取消" && archivedTransaction?.state === "committed" };

      if (!blockers.length && ["HOLD", "阻断"].includes(parent.status)) {
        try {
          const latest = await this.store.getTask(projectId, parentId);
          if (latest.task.status !== parent.status) {
            const error = new Error("父任务状态并发变化");
            error.code = "REVISION_CONFLICT";
            throw error;
          }
          const result = await this.store.updateTask(projectId, parentId,
            { status: "已取消", assignee: "", sessionId: "", sessionWindowName: "" }, {
              operationId, expectedRevision: latest.snapshot.registryRevision,
              eventType: "split_parent_reconciled", actorType: "system", actorId: "task-scan",
              note: "所有可信拆分子任务已正式交付且总控确认无剩余集成范围；原父项已拆分覆盖，系统归档为已取消",
              metadata: { splitEventIds: expectedSplits, childTaskIds: children,
                verifiedChildDeliveryEventIds: childDeliveryEvents.map(event => event.event_id),
                integrationEvidenceEventId: clearance.event_id, archiveReason: "已拆分覆盖" }
            });
          record.status = "已取消";
          record.archived = true;
          record.event_id = result.eventId;
          record.idempotent_replay = result.idempotentReplay;
        } catch (error) {
          if (!["REVISION_CONFLICT", "PROJECT_LOCKED"].includes(error.code)) throw error;
          record.blockers.push("并发写入需下轮复核：" + error.code);
        }
      }
      output.push(record);
    }
    return output;
  }
}
