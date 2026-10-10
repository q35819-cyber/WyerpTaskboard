import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WakeBridge } from "../server/wake-bridge.mjs";

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-wake-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function candidate(overrides = {}) {
  return {
    project_id: "project-a",
    task_id: "TASK-1",
    detection_id: "det_123",
    eligible_role: "developer_ai",
    eligible: true,
    reason: "must not be uploaded",
    blockers: [],
    ...overrides,
  };
}

test("GitHub wake bridge sends only minimal candidate references and dedupes by detection_id", async (t) => {
  const root = await tempRoot(t);
  const calls = [];
  const bridge = await new WakeBridge(root, {
    config: {
      enabled: true,
      repo: "owner/wake",
      pr_number: 1,
      gh_command: "gh",
      work_trigger_verified: false,
    },
    execFileFn: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ id: 42, html_url: "https://github.test/comment/42" }) };
    },
  }).init();

  const first = await bridge.notifyCandidate(candidate());
  assert.equal(first.state, "sent");
  assert.equal(first.instant_trigger, "github_bridge_ready_unverified");
  assert.equal(calls.length, 1);
  const commandArgs = calls[0][1];
  assert.deepEqual(commandArgs.slice(0, 4), ["api", "--method", "POST", "repos/owner/wake/issues/1/comments"]);
  const bodyArg = commandArgs.find((item) => item.startsWith("body="));
  assert.equal(bodyArg, "body=candidate_ready | project-a | TASK-1 | det_123 | developer_ai");
  assert.ok(!bodyArg.includes("must not be uploaded"));

  const second = await bridge.notifyCandidate(candidate());
  assert.equal(second.state, "deduped");
  assert.equal(calls.length, 1);
});

test("GitHub wake bridge degrades without failing the scanner contract and retries unsent detection", async (t) => {
  const root = await tempRoot(t);
  let attempts = 0;
  const bridge = await new WakeBridge(root, {
    config: { enabled: true, repo: "owner/wake", pr_number: 1, work_trigger_verified: false },
    execFileFn: async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error("network down");
        error.code = "ECONNRESET";
        throw error;
      }
      return { stdout: JSON.stringify({ id: 77 }) };
    },
  }).init();

  const failed = await bridge.notifyCandidate(candidate());
  assert.equal(failed.state, "error");
  assert.equal(failed.instant_trigger, "github_bridge_error_fallback");

  const retried = await bridge.notifyCandidate(candidate());
  assert.equal(retried.state, "sent");
  assert.equal(retried.instant_trigger, "github_bridge_ready_unverified");
  assert.equal(retried.last_error, null);
  assert.equal(attempts, 2);
});

test("GitHub wake bridge does not emit for blocked or absent candidates", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const bridge = await new WakeBridge(root, {
    config: { enabled: true, repo: "owner/wake", pr_number: 1 },
    execFileFn: async () => { calls++; return { stdout: "{}" }; },
  }).init();

  assert.equal((await bridge.notifyCandidate(null)).state, "no_candidate");
  assert.equal((await bridge.notifyCandidate(candidate({ eligible: false }))).state, "no_candidate");
  assert.equal(calls, 0);
});

test("GitHub wake bridge rejects malformed references without calling gh", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const bridge = await new WakeBridge(root, {
    config: { enabled: true, repo: "owner/wake", pr_number: 1 },
    execFileFn: async () => { calls++; return { stdout: "{}" }; },
  }).init();

  const result = await bridge.notifyCandidate(candidate({ task_id: "TASK-1\nsecret payload" }));
  assert.equal(result.state, "error");
  assert.equal(result.error.code, "INVALID_WAKE_REFERENCE");
  assert.equal(calls, 0);
});
test("chat-only mode disables the Work bridge and never calls gh", async (t) => {
  const root = await tempRoot(t);
  let calls = 0;
  const bridge = await new WakeBridge(root, {
    config: {
      enabled: false,
      execution_mode: "chat_only",
      disabled_reason: "work_forbidden_by_user",
      repo: "owner/wake",
      pr_number: 1,
      chat_trigger_verified: false,
      work_trigger_verified: false,
    },
    execFileFn: async () => { calls++; return { stdout: "{}" }; },
  }).init();

  const result = await bridge.notifyCandidate(candidate());
  assert.equal(result.state, "disabled");
  assert.equal(result.instant_trigger, "chat_mode_only_unavailable");
  assert.equal(result.execution_mode, "chat_only");
  assert.equal(result.disabled_reason, "work_forbidden_by_user");
  assert.equal(result.chat_trigger_verified, false);
  assert.equal(calls, 0);
});
