import test from "node:test";
import assert from "node:assert/strict";
import { latestAuthorizedTestExecution, deliveryEvidence } from "../server/candidate-evaluator.mjs";

const REV = "a".repeat(64);
const SHA = "6".repeat(40);
const BRANCH = "fix/WTB-P0-ONBOARD-TEMPLATE-ROLE-DRIFT-20261105-T1";

function legacyTakeoverHistory() {
  let counter = 0;
  const event = (type, actorType, actorId, sessionId, metadata = {}, other = {}) => ({
    event_id: "evt_fixture_" + ++counter,
    operation_id: "fixture.operation." + counter,
    event_type: type, actor_type: actorType, actor_id: actorId, session_id: sessionId,
    registry_revision_before: REV, registry_revision_after: REV,
    old_status: "独测中", new_status: "独测中", metadata, ...other
  });
  const published = event("code_published", "developer_ai", "dev-1", "dev-session", {
    remoteVerified: true, mainMerged: false, commitSha: SHA,
    branch: BRANCH, reportPath: "reports/role-drift/dev-pass.md",
    reportSha256: "d".repeat(64)
  });
  const handoff = event("handoff", "developer_ai", "dev-1", "dev-session", {
    atomicLifecycle: true, completedFromStatus: "开发中", handoffTarget: "待独测"
    // Legacy persisted handoff has no commitSha/headBranch.
  }, { old_status: "开发中", new_status: "待独测" });
  const firstQa = event("claim", "test_ai", "qa-1", "qa-1-session",
    { claimedFromStatus: "待独测" }, { old_status: "待独测" });
  const authorization = event("takeover_allowed", "test_ai", "qa-2", "qa-2-session", {
    authorizedFromStatus: "独测中", authorizedFromSessionId: "qa-1-session",
    authorizedRegistryRevision: REV, authorizationScope: "task",
    authorizationSource: "chat_user_instruction_cooperative",
    explicitUserOverride: true, authorizationForwardedBy: "qa-2",
    authorizationForwardingSessionId: "qa-2-session"
  });
  const execution = event("takeover", "test_ai", "qa-2", "qa-2-session", {
    authorizationOperationId: authorization.operation_id,
    previousSessionId: "qa-1-session"
  });
  const result = event("test_result", "test_ai", "qa-2", "qa-2-session", {
    atomicLifecycle: true, testResult: "pass", acceptanceScope: "system",
    deliveryDisposition: "required", deliveryActions: ["candidate_merge"],
    commitSha: SHA, headBranch: BRANCH,
    reportPath: "reports/role-drift/QA-TAKEOVER-PASS.md"
  }, { new_status: "待交付" });
  return {
    history: [published, handoff, firstQa, authorization, execution, result],
    published, handoff, firstQa, authorization, execution, result, event
  };
}

const workflow = { isExecutableDeliveryDecision: () => true };

test("real Q2 takeover can use matching verified developer publication for legacy handoff", () => {
  const f = legacyTakeoverHistory();
  assert.equal(f.handoff.metadata.commitSha, undefined);
  assert.equal(latestAuthorizedTestExecution(f.history, f.result), f.execution);
  const evidence = deliveryEvidence(f.history, workflow);
  assert.equal(evidence.valid, true);
  assert.equal(evidence.eventId, f.result.event_id);
  assert.equal(evidence.developerActorId, "dev-1");
  assert.equal(evidence.developerSessionId, "dev-session");
});

test("modern Git-bound handoff remains valid without legacy fallback", () => {
  const f = legacyTakeoverHistory();
  f.handoff.metadata.commitSha = SHA;
  f.handoff.metadata.headBranch = BRANCH;
  f.history.shift(); // No historic code_published event required for modern handoff.
  assert.equal(latestAuthorizedTestExecution(f.history, f.result), f.execution);
  assert.equal(deliveryEvidence(f.history, workflow).valid, true);
});

test("legacy fallback denies forged publications, mismatched candidate and invalidated source", () => {
  const mutations = [
    ["no publication", (f) => f.history.shift()],
    ["unverified publication", (f) => { f.published.metadata.remoteVerified = false; }],
    ["wrong candidate SHA", (f) => { f.published.metadata.commitSha = "7".repeat(40); }],
    ["wrong branch", (f) => { f.published.metadata.branch = "fix/other"; }],
    ["wrong developer", (f) => { f.published.actor_id = "intruder"; }],
    ["wrong developer session", (f) => { f.published.session_id = "another-session"; }],
    ["missing dev report SHA256", (f) => { delete f.published.metadata.reportSha256; }],
    ["forged report SHA256", (f) => { f.published.metadata.reportSha256 = "invalid"; }],
    ["missing report path", (f) => { f.published.metadata.reportPath = ""; }],
    ["partial handoff SHA", (f) => { f.handoff.metadata.commitSha = SHA; }],
    ["partial handoff branch", (f) => { f.handoff.metadata.headBranch = BRANCH; }],
    ["changed QA candidate", (f) => { f.result.metadata.commitSha = "7".repeat(40); }],
    ["changed QA branch", (f) => { f.result.metadata.headBranch = "fix/other"; }],
    ["code change since publication", (f) => f.history.splice(1, 0,
      f.event("code_change", "developer_ai", "dev-1", "dev-session"))],
    ["revoked source evidence", (f) => f.history.splice(1, 0,
      f.event("evidence_invalidated", "developer_ai", "dev-1", "dev-session",
        { invalidatesTestEvidence: true }))]
  ];
  for (const [name, mutate] of mutations) {
    const f = legacyTakeoverHistory();
    mutate(f);
    assert.equal(latestAuthorizedTestExecution(f.history, f.result), null, name);
    assert.equal(deliveryEvidence(f.history, workflow).valid, false, name);
  }
});

test("legacy fallback never bypasses independent QA takeover authorization", () => {
  const mutations = [
    ["Q2 actor mismatch", (f) => { f.result.actor_id = "qa-1"; }],
    ["Q2 session mismatch", (f) => { f.result.session_id = "qa-1-session"; }],
    ["unapproved user scope", (f) => { f.authorization.metadata.authorizationScope = "project"; }],
    ["forged authorization provenance", (f) => {
      f.authorization.metadata.authorizationForwardedBy = "attacker";
    }],
    ["wrong predecessor session", (f) => {
      f.execution.metadata.previousSessionId = "other-session";
    }],
    ["stale authorization revision", (f) => {
      f.authorization.metadata.authorizedRegistryRevision = "b".repeat(64);
    }],
    ["revoked takeover", (f) => f.history.splice(-1, 0,
      f.event("takeover_revoked", "user", "user", "user-session"))],
    ["missing developer handoff", (f) => {
      f.history.splice(f.history.indexOf(f.handoff), 1);
    }]
  ];
  for (const [name, mutate] of mutations) {
    const f = legacyTakeoverHistory();
    mutate(f);
    assert.equal(latestAuthorizedTestExecution(f.history, f.result), null, name);
    assert.equal(deliveryEvidence(f.history, workflow).valid, false, name);
  }
});
