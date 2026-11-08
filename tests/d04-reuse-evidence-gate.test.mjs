import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeFixture } from "./helpers.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { TaskStepCheckpoint } from "../server/task-step-checkpoint.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args],
  { encoding: "utf8", windowsHide: true }).trim();
let seq = 1;
test("D04 real reuse evidence rejects invented / cross-task paths, then permits repaired D04 and D08", async (t) => {
  const f = await makeFixture();
  t.after(() => fs.rm(f.boardRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(f.projectRoot, "src"));
  await fs.mkdir(path.join(f.projectRoot, "tests"));
  await fs.mkdir(path.join(f.projectRoot, "docs"));
  await fs.writeFile(path.join(f.projectRoot, "src/index.mjs"), "export function reuse(){return true}\n");
  await fs.writeFile(path.join(f.projectRoot, "tests/index.test.mjs"), "import {reuse} from '../src/index.mjs'; reuse();\n");
  await fs.writeFile(path.join(f.projectRoot, "package.json"), '{"dependencies":{}}');
  await fs.writeFile(path.join(f.projectRoot, "docs/notes.md"), "Actual local technical notes.");
  const lib = path.join(f.boardRoot, "开源参考源码");
  await fs.mkdir(path.join(lib, "sample"), { recursive: true });
  await fs.writeFile(path.join(lib, "00_公共开源库索引.md"), "Local checked index.");
  await fs.writeFile(path.join(lib, "sample", "impl.mjs"), "export const unrelated = 1;");
  git(f.projectRoot, "init", "-q");
  git(f.projectRoot, "config", "user.name", "Fixture Developer");
  git(f.projectRoot, "config", "user.email", "fixture@example.test");
  git(f.projectRoot, "add", "src/index.mjs", "tests/index.test.mjs", "package.json", "docs/notes.md");
  git(f.projectRoot, "commit", "-qm", "fixture: reusable existing implementation");
  const commit = git(f.projectRoot, "log", "-1", "--format=%H", "--", "src/index.mjs");

  const store = await new TaskStore(f.boardRoot).init();
  const cp = await new TaskStepCheckpoint(f.boardRoot, { taskStore: store }).init();
  const actorId = "dev-reuse", sessionId = "dev-session";
  const checkpoint = {
    version: 1, projectId: "fixture", taskId: "A-10", flowVersion: "role-steps-v2",
    cursors: { controller_ai: null, developer_ai: "D01_CLAIM", test_ai: "Q01_ADMISSION" },
    attempts: 1, records: [], lastAction: null
  };
  await fs.writeFile(path.join(f.projectRoot, "cp/A-10.md"),
    "# Fixture\n<!-- TASK_STEP_CHECKPOINT_START v1 -->\n" + JSON.stringify(checkpoint)
    + "\n<!-- TASK_STEP_CHECKPOINT_END -->\n");
  const snapshot = await store.snapshot("fixture");
  const claim = await store.updateTask("fixture", "A-10",
    { status: "开发中", assignee: "dev-reuse", sessionWindowName: "dev",
      sessionId }, { operationId: "reuse.claim", expectedRevision: snapshot.registryRevision,
      eventType: "claim", actorType: "developer_ai", actorId, sessionId });
  async function record(stepId, extra = {}) {
    const now = await cp.show("fixture", "A-10");
    return cp.record("fixture", "A-10", {
      operationId: "reuse.step." + seq++, expectedSha256: now.sha256,
      stepId, actorType: "developer_ai", actorId, sessionId,
      evidence: "Real fixture evidence for " + stepId, ...extra
    });
  }
  await record("D01_CLAIM", { eventId: claim.eventId });
  await record("D02_WORKTREE");
  await record("D03_WRITE_SCOPE");
  // Enable the production-only new step gate, keeping the fixture's old TaskStore
  // mutation machinery unmodified (it has no copied central authority rules).
  cp.taskStore = new Proxy(store, { get(target, key) {
    if (key === "ruleGateEnabled") return async () => true;
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const proofFile = path.join(f.projectRoot, "reports", "reuse.json");
  const correct = {
    taskId: "A-10", actorId, sessionId, attempt: 1,
    claimEventId: claim.eventId, searchedAt: new Date().toISOString(),
    query: "checkpoint source test git history and local library",
    checks: {
      source: "src/index.mjs", tests: "tests/index.test.mjs",
      dependencies: "package.json", technicalNotes: "docs/notes.md",
      historyCommit: commit,
      libraryIndex: "../开源参考源码/00_公共开源库索引.md",
      libraryStatus: "checked",
      libraryExamples: ["../开源参考源码/sample/impl.mjs"]
    },
    candidates: [{ path: "src/index.mjs", symbol: "function reuse",
      license: "project-owned", decision: "reuse", reason: "Reuse existing source and test" }]
  };
  const write = (data) => fs.writeFile(proofFile, JSON.stringify(data));
  const before = await cp.show("fixture", "A-10");
  await assert.rejects(record("D04_IMPLEMENT"), { code: "CHECKPOINT_REUSE_INVALID" });
  for (const variant of [
    { ...correct, taskId: "B-10" },
    { ...correct, sessionId: "revoked-session" },
    { ...correct, claimEventId: "fake-claim" },
    { ...correct, attempt: 2 },
    { ...correct, searchedAt: "2020-01-01T00:00:00.000Z" },
    { ...correct, checks: { ...correct.checks, source: "src/fake.mjs" } },
    { ...correct, checks: { ...correct.checks, tests: "https://github.com/example" } },
    { ...correct, checks: { ...correct.checks, historyCommit: "a".repeat(40) } },
    { ...correct, checks: { ...correct.checks, historyCommit: "" } },
    { ...correct, checks: { ...correct.checks, libraryExamples: ["../开源参考源码/no-such-source"] } },
    { ...correct, candidates: [{ ...correct.candidates[0], symbol: "nonexistentFunction" }] },
    { ...correct, candidates: [{ ...correct.candidates[0], license: "", decision: "reuse" }] },
    { ...correct, candidates: [] }
  ]) {
    await write(variant);
    await assert.rejects(record("D04_IMPLEMENT", { reuseEvidenceFile: "reports/reuse.json" }),
      { code: "CHECKPOINT_REUSE_INVALID" });
    assert.equal((await cp.show("fixture", "A-10")).sha256, before.sha256,
      "a failed check must preserve the exact D04 cursor and checkpoint");
  }
  await write(correct);
  const pass = await record("D04_IMPLEMENT", { reuseEvidenceFile: "reports/reuse.json" });
  assert.equal(pass.state.cursors.developer_ai, "D05_TEST_1");
  assert.match(pass.state.lastAction.reuseProofSha, /^[0-9a-f]{64}$/);
  assert.equal(pass.state.lastAction.claimEventId, claim.eventId);
  assert.equal(pass.state.lastAction.reuseEvidenceFile, "reports/reuse.json");
  await record("D05_TEST_1");
  await record("D06_TEST_2");
  await record("D07_TEST_3");
  await fs.writeFile(proofFile, JSON.stringify({ ...correct, taskId: "B-10" }));
  await assert.rejects(cp.assertTransitionEvidence("fixture", "A-10", {
    eventType: "handoff", actorType: "developer_ai", actorId, sessionId
  }), { code: "CHECKPOINT_REUSE_INVALID" });
  await write(correct);
  await cp.assertTransitionEvidence("fixture", "A-10", {
    eventType: "handoff", actorType: "developer_ai", actorId, sessionId
  });
  const revision = (await store.snapshot("fixture")).registryRevision;
  const handoff = await store.updateTask("fixture", "A-10",
    { status: "待独测", assignee: "", sessionWindowName: "", sessionId: "" },
    { operationId: "reuse.handoff", expectedRevision: revision,
      eventType: "handoff", actorType: "developer_ai", actorId, sessionId,
      metadata: { atomicLifecycle: true, completedFromStatus: "开发中",
        handoffTarget: "待独测", commitSha: commit } });
  const d08 = await record("D08_HANDOFF", { eventId: handoff.eventId });
  assert.equal(d08.state.cursors.developer_ai, "D09_NEXT");
});
