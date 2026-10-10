import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutomationControlStore } from "../server/automation-control.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-automation-control-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "data/runtime/validation"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await fs.writeFile(path.join(root, "config/automation-control.json"), JSON.stringify({
    version: 1, approval_ttl_seconds: 120, pending_ttl_seconds: 600, input_lease_ms: 4000, unattended_requires_validation: true
  }));
  return root;
}

test("automation control starts paused and requires explicit first start", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root, { clock: () => Date.parse("2026-09-30T00:00:00Z") }).init();
  const state = await store.publicState();
  assert.equal(state.running, false);
  assert.equal(state.unattended, false);
  const decision = await store.requestAction({ source: "test", kind: "click", summary: "click" });
  assert.equal(decision.state, "paused");
});

test("manual lifecycle start requires a short-lived non-injected one-shot proof", async (t) => {
  const root = await fixture(t);
  let now = Date.parse("2026-09-30T00:00:00Z");
  const store = await new AutomationControlStore(root, { clock: () => now }).init();
  await assert.rejects(() => store.issueManualStartProof({ injected: true, input_type: "mouse" }), error => error.code === "AUTOMATION_MANUAL_START_PROOF_REJECTED");
  await assert.rejects(() => store.start({ require_manual_proof: true }), error => error.code === "AUTOMATION_MANUAL_START_REQUIRED");
  const proof = await store.issueManualStartProof({ injected: false, input_type: "mouse" });
  assert.ok(proof.proof_id);
  const started = await store.start({ proof_id: proof.proof_id, require_manual_proof: true });
  assert.equal(started.running, true);
  assert.equal(started.manual_start_proof, undefined);
  await store.pause("test");
  await assert.rejects(() => store.start({ proof_id: proof.proof_id, require_manual_proof: true }), error => error.code === "AUTOMATION_MANUAL_START_REQUIRED");
  const expiring = await store.issueManualStartProof({ injected: false, input_type: "mouse" });
  now += 4000;
  await assert.rejects(() => store.start({ proof_id: expiring.proof_id, require_manual_proof: true }), error => error.code === "AUTOMATION_MANUAL_START_REQUIRED");
});

test("manual approval is one-time and fingerprint-bound", async (t) => {
  const root = await fixture(t);
  let now = Date.parse("2026-09-30T00:00:00Z");
  const store = await new AutomationControlStore(root, { clock: () => now }).init();
  await store.start();
  const first = await store.requestAction({ source: "mcp", kind: "Click", summary: "点重试", details: { x: 1, y: 2 } });
  assert.equal(first.state, "approval_required");
  await store.decide(first.approval_id, "allow");
  const allowed = await store.requestAction({ source: "mcp", kind: "Click", summary: "点重试", details: { x: 1, y: 2 } });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.mode, "approved_once");
  const inFlight = await store.requestAction({ source: "mcp", kind: "Click", summary: "点重试", details: { x: 1, y: 2 } });
  assert.equal(inFlight.state, "in_flight");
  assert.equal(inFlight.approval_id, first.approval_id);
  await store.finishExecution({ action_fingerprint: allowed.action_fingerprint, trace_id: allowed.trace_id, result: "succeeded" });
  const again = await store.requestAction({ source: "mcp", kind: "Click", summary: "点重试", details: { x: 1, y: 2 } });
  assert.equal(again.state, "approval_required");
  const different = await store.requestAction({ source: "mcp", kind: "Click", summary: "点继续", details: { x: 3, y: 4 } });
  assert.notEqual(different.action_fingerprint, first.action_fingerprint);
});

test("safety-blocked action is logged and does not immediately request a second approval", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await store.start();
  const first = await store.requestAction({ source: "chatgpt-mcp-executor", kind: "chatgpt_navigate_session", summary: "切换会话", action_fingerprint: "fp-safety" });
  await store.decide(first.approval_id, "allow");
  const allowed = await store.requestAction({ source: "chatgpt-mcp-executor", kind: "chatgpt_navigate_session", summary: "切换会话", action_fingerprint: "fp-safety" });
  assert.equal(allowed.allowed, true);
  const duplicate = await store.requestAction({ source: "chatgpt-mcp-executor", kind: "chatgpt_navigate_session", summary: "切换会话", action_fingerprint: "fp-safety" });
  assert.equal(duplicate.state, "in_flight");
  await store.finishExecution({
    action_fingerprint: "fp-safety",
    trace_id: allowed.trace_id,
    result: "safety_blocked",
    error_source: "platform_safety",
    error_code: "SAFETY_BLOCK",
    error_message: "blocked by safety check"
  });
  const suppressed = await store.requestAction({ source: "chatgpt-mcp-executor", kind: "chatgpt_navigate_session", summary: "切换会话", action_fingerprint: "fp-safety" });
  assert.equal(suppressed.state, "safety_blocked_recent");
  const log = await fs.readFile(path.join(root, "data/runtime/automation-control/events.jsonl"), "utf8");
  const events = log.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.stage === "approval_requested" && event.trace_id === first.trace_id));
  assert.ok(events.some(event => event.stage === "approval_allowed" && event.trace_id === first.trace_id));
  assert.ok(events.some(event => event.stage === "execution_started" && event.trace_id === allowed.trace_id));
  assert.ok(events.some(event => event.stage === "execution_safety_blocked" && event.error_source === "platform_safety"));
});

test("full control lifecycle keeps reject fail-closed, allow one-shot, takeover dominant, and unattended bounded", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({ state: "passed", failedFiles: 0, package_version: "1.2.3" }));
  const store = await new AutomationControlStore(root).init();

  await store.start();
  const first = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(first.state, "approval_required");

  const rejectedState = await store.decide(first.approval_id, "reject");
  assert.equal(rejectedState.approval_grant, null);
  const afterReject = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(afterReject.allowed, false);
  assert.equal(afterReject.state, "approval_required");
  assert.notEqual(afterReject.approval_id, first.approval_id);

  await store.decide(afterReject.approval_id, "allow");
  const allowedOnce = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(allowedOnce.allowed, true);
  assert.equal(allowedOnce.mode, "approved_once");
  const duplicateWhileRunning = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(duplicateWhileRunning.state, "in_flight");
  await store.finishExecution({ action_fingerprint: allowedOnce.action_fingerprint, trace_id: allowedOnce.trace_id, result: "succeeded" });
  const needsApprovalAgain = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(needsApprovalAgain.state, "approval_required");
  await store.decide(needsApprovalAgain.approval_id, "reject");

  await store.userTakeover("mouse");
  const takeoverState = await store.publicState();
  assert.equal(takeoverState.running, true);
  assert.equal(takeoverState.user_takeover, true);
  assert.equal(takeoverState.interaction_paused, true);
  assert.equal(takeoverState.takeover_scope, "interactive_input_only");
  assert.equal(takeoverState.background_work_preserved, true);
  assert.equal(takeoverState.unattended, false);
  assert.equal(takeoverState.pending_action, null);
  assert.equal(takeoverState.approval_grant, null);

  await assert.rejects(() => store.setUnattended(true), error => error.code === "UNATTENDED_USER_TAKEOVER_ACTIVE");
  const stillPaused = await store.requestAction({ source: "browser", kind: "send", summary: "发送任务" });
  assert.equal(stillPaused.allowed, false);
  assert.equal(stillPaused.state, "user_takeover");

  await store.start();
  await store.setUnattended(true);
  const unattended = await store.requestAction({ source: "browser", kind: "send", summary: "发送任务" });
  assert.equal(unattended.allowed, true);
  assert.equal(unattended.mode, "unattended");

  const human = await store.observeInput({ injected: false, input_type: "keyboard" });
  assert.equal(human.classification, "human");
  assert.equal(human.takeover, true);
  assert.equal(human.control.running, true);
  assert.equal(human.control.user_takeover, true);
  assert.equal(human.control.unattended, false);
});

test("unattended cannot be enabled before validation and bypasses per-action approval after validation", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await assert.rejects(() => store.setUnattended(true), error => error.code === "UNATTENDED_VALIDATION_REQUIRED");
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({ state: "passed", failedFiles: 0, package_version: "1.2.3" }));
  const enabled = await store.setUnattended(true);
  assert.equal(enabled.unattended, true);
  assert.equal(enabled.unattended_available, true);
  await store.start();
  const action = await store.requestAction({ source: "browser", kind: "send", summary: "发送任务" });
  assert.equal(action.allowed, true);
  assert.equal(action.mode, "unattended");
});

test("unattended rejects a passing result from a different package version", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({ state: "passed", failedFiles: 0, package_version: "1.2.2" }));
  const store = await new AutomationControlStore(root).init();
  const state = await store.publicState();
  assert.equal(state.unattended_available, false);
  assert.equal(state.validation.version_match, false);
  assert.equal(state.validation.tested_package_version, "1.2.2");
  assert.equal(state.validation.current_package_version, "1.2.3");
  await assert.rejects(() => store.setUnattended(true), error => error.code === "UNATTENDED_VALIDATION_REQUIRED");
});

test("human takeover pauses only interactive automation and automatically clears unattended", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({ state: "passed", failedFiles: 0, package_version: "1.2.3" }));
  const store = await new AutomationControlStore(root).init();
  await store.setUnattended(true);
  await store.start();
  await store.userTakeover("keyboard");
  const state = await store.publicState();
  assert.equal(state.running, true);
  assert.equal(state.user_takeover, true);
  assert.equal(state.interaction_paused, true);
  assert.equal(state.takeover_scope, "interactive_input_only");
  assert.equal(state.unattended, false);
  assert.equal(state.background_work_preserved, true);
});


test("Windows MCP injected input is accepted only inside an active input lease", async (t) => {
  const root = await fixture(t);
  let now = Date.parse("2026-09-30T00:00:00Z");
  await fs.writeFile(path.join(root, "data/runtime/validation/npm-test.json"), JSON.stringify({ state: "passed", failedFiles: 0, package_version: "1.2.3" }));
  const store = await new AutomationControlStore(root, { clock: () => now }).init();
  await store.setUnattended(true);
  await store.start();
  const action = await store.requestAction({ source: "windows-mcp", kind: "Click", summary: "自动点击", details: { x: 10, y: 20 } });
  assert.equal(action.allowed, true);
  assert.ok(action.input_lease?.expires_at);
  const automated = await store.observeInput({ injected: true, input_type: "mouse" });
  assert.equal(automated.classification, "automation");
  assert.equal(automated.control.running, true);
  now += 5000;
  const unknown = await store.observeInput({ injected: true, input_type: "mouse" });
  assert.equal(unknown.classification, "unknown_injected");
  assert.equal(unknown.control.running, true);
  assert.equal(unknown.control.user_takeover, true);
  assert.equal(unknown.control.unattended, false);
});

test("mouse movement can navigate to approval UI while pending but clicks remain fail-closed", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await store.start();
  const pending = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(pending.state, "approval_required");

  const humanMove = await store.observeInput({ injected: false, input_type: "mouse_move" });
  assert.equal(humanMove.classification, "approval_navigation");
  assert.equal(humanMove.takeover, false);
  assert.equal(humanMove.control.running, true);
  assert.equal(humanMove.control.pending_action?.id, pending.approval_id);

  const injectedMove = await store.observeInput({ injected: true, input_type: "mouse_move" });
  assert.equal(injectedMove.classification, "approval_navigation");
  assert.equal(injectedMove.takeover, false);
  assert.equal(injectedMove.control.running, true);

  const outsideClick = await store.observeInput({ injected: false, input_type: "mouse" });
  assert.equal(outsideClick.classification, "human");
  assert.equal(outsideClick.takeover, true);
  assert.equal(outsideClick.control.running, true);
  assert.equal(outsideClick.control.pending_action, null);
});

test("mouse movement remains safe after allow until one-shot approval is consumed", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await store.start();
  const pending = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  await store.decide(pending.approval_id, "allow");

  const moveBeforeConsume = await store.observeInput({ injected: true, input_type: "mouse_move" });
  assert.equal(moveBeforeConsume.classification, "approval_navigation");
  assert.equal(moveBeforeConsume.takeover, false);
  assert.equal(moveBeforeConsume.control.running, true);
  assert.equal(moveBeforeConsume.control.approval_grant?.approval_id, pending.approval_id);

  const consumed = await store.requestAction({ source: "browser", kind: "retry", summary: "重试当前回复" });
  assert.equal(consumed.allowed, true);
  assert.equal(consumed.mode, "approved_once");
  const moveAfterConsume = await store.observeInput({ injected: true, input_type: "mouse_move" });
  assert.equal(moveAfterConsume.classification, "unknown_injected");
  assert.equal(moveAfterConsume.takeover, true);
  assert.equal(moveAfterConsume.control.running, true);
});

test("mouse movement still triggers takeover when no approval is pending", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await store.start();
  const observed = await store.observeInput({ injected: false, input_type: "mouse_move" });
  assert.equal(observed.classification, "human");
  assert.equal(observed.takeover, true);
  assert.equal(observed.control.running, true);
});

test("non-injected keyboard or mouse input always triggers user takeover while running", async (t) => {
  const root = await fixture(t);
  const store = await new AutomationControlStore(root).init();
  await store.start();
  const observed = await store.observeInput({ injected: false, input_type: "keyboard" });
  assert.equal(observed.classification, "human");
  assert.equal(observed.takeover, true);
  assert.equal(observed.control.running, true);
  assert.equal(observed.control.user_takeover, true);
  assert.equal(observed.control.unattended, false);
});
