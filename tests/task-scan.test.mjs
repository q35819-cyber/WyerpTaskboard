import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeFixture, registryText } from "./helpers.mjs";
import { TaskStore } from "../server/task-store.mjs";
import { RequirementStore } from "../server/requirement-store.mjs";
import { ScanStore } from "../server/scan-store.mjs";
import { CandidateEvaluator } from "../server/candidate-evaluator.mjs";
import { TaskScanner } from "../server/task-scanner.mjs";

const execFileAsync = promisify(execFile);
const TASK_SCAN_CLI = path.resolve(import.meta.dirname, "..", "cli", "task-scan.mjs");

async function fixtureWithLedger(t) {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.boardRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.projectRoot, "ledger.md"), "# ledger\n", "utf8");
  return fixture;
}

test("scanner creates role-aware candidates, dedupes repeated scans and expires after 30 minutes", async (t) => {
  const fixture = await fixtureWithLedger(t);
  let now = Date.parse("2026-09-29T00:00:00Z");
  const clock = () => now;
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot, { clock }).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { clock, taskStore, requirementStore, scanStore }).init();

  const first = await scanner.scanOnce();
  assert.equal(first.state, "completed");
  const active1 = await scanStore.list();
  const a10 = active1.find((x) => x.task_id === "A-10");
  const t01 = active1.find((x) => x.task_id === "T-01");
  assert.equal(a10.eligible, true);
  assert.equal(a10.eligible_role, "developer_ai");
  assert.equal(t01.eligible, true);
  assert.equal(t01.eligible_role, "test_ai");
  assert.equal(active1.some((x) => x.task_id === "B-10"), false);

  const a10Id = a10.detection_id;
  now += 10 * 60 * 1000;
  const second = await scanner.scanOnce();
  assert.equal(second.created_candidates, 0);
  assert.ok(second.refreshed_candidates >= 2);
  const active2 = await scanStore.list();
  assert.equal(active2.find((x) => x.task_id === "A-10").detection_id, a10Id);

  now += 31 * 60 * 1000;
  assert.equal((await scanStore.list()).length, 0);
});

test("scanner marks owned task blocked and recheck rejects changed registry", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const rows = [
    ["A-10","F-001","product","P0","待开发","开发AI","owner","窗口","sess-owner","2026-09-29T00:00:00Z","权限收口","账号登录与权限开发计划.md","cp/A-10.md"],
    ["T-01","F-TEST","product","P1","待独测","独立测试AI","—","—","—","—","独立测试夹具","测试计划.md","cp/T-01.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");

  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();
  const candidates = await scanStore.list();
  const owned = candidates.find((x) => x.task_id === "A-10");
  assert.equal(owned.eligible, false);
  assert.ok(owned.blockers.some((x) => x.includes("负责人")));

  const testCandidate = candidates.find((x) => x.task_id === "T-01");
  const changed = [
    ["A-10","F-001","product","P0","待开发","开发AI","owner","窗口","sess-owner","2026-09-29T00:00:00Z","权限收口","账号登录与权限开发计划.md","cp/A-10.md"],
    ["T-01","F-TEST","product","P1","独测中","独立测试AI","tester","测试窗口","sess-test","2026-09-29T00:10:00Z","独立测试夹具","测试计划.md","cp/T-01.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(changed), "utf8");
  const evaluator = new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore });
  const recheck = await evaluator.recheck(testCandidate);
  assert.equal(recheck.ok, false);
  assert.equal(recheck.stale, true);
  assert.ok(recheck.mismatches.includes("registry_revision_changed"));
  assert.ok(recheck.mismatches.includes("status_changed"));
});

test("delivery candidates require a recorded non-empty real delivery action", async (t) => {
  const fixture = await fixtureWithLedger(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["D-EMPTY","F-DELIVERY","product","P0","待交付","开发AI","—","—","—","2026-10-01T00:00:00Z","没有登记真实交付动作","测试计划.md","cp/D-EMPTY.md"],
    ["D-REAL","F-DELIVERY","product","P0","待交付","开发AI","—","—","—","2026-10-01T00:00:00Z","有正式部署动作","测试计划.md","cp/D-REAL.md"]
  ]), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  await taskStore.appendTaskEvent("fixture", "D-REAL", {
    operationId: "delivery.candidate.real.001",
    eventType: "test_result",
    actorType: "test_ai",
    actorId: "tester",
    metadata: {
      testResult: "pass",
      deliveryDisposition: "required",
      deliveryActions: ["deploy_switch"],
      handoffTarget: "待交付"
    }
  });
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const evaluator = new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore });
  const evaluated = await evaluator.evaluateProject("fixture");
  assert.equal(evaluated.candidates.some((item) => item.task_id === "D-EMPTY"), false);
  const real = evaluated.candidates.find((item) => item.task_id === "D-REAL");
  assert.ok(real);
  assert.equal(real.eligible_role, "developer_ai");
  assert.equal(real.eligible, true);
  assert.match(real.reason, /真实交付动作/);
});

test("scan lock prevents reentry and stale/corrupt state is recoverable", async (t) => {
  const fixture = await fixtureWithLedger(t);
  let now = Date.parse("2026-09-29T00:00:00Z");
  const store = await new ScanStore(fixture.boardRoot, { clock: () => now }).init();
  const first = await store.acquireRunLock({ pid: process.pid, isAlive: async () => true });
  assert.equal(first.acquired, true);
  const second = await store.acquireRunLock({ pid: process.pid, isAlive: async () => true });
  assert.equal(second.acquired, false);
  assert.equal(second.reason, "previous_run_active");
  await store.releaseRunLock(first.token);

  await fs.writeFile(store.statePath, "{bad json", "utf8");
  const recovered = await store.readState();
  assert.equal(recovered.version, 1);
  assert.deepEqual(recovered.candidates, {});
  const files = await fs.readdir(store.dir);
  assert.ok(files.some((x) => x.startsWith("candidates.corrupt.")));
});

test("Windows schedule interval is configurable while full project scans are adaptive", async () => {
  const base = path.resolve(import.meta.dirname, "..", "scripts");
  const install = await fs.readFile(path.join(base, "install-task-scan-schedule.ps1"), "utf8");
  const hidden = await fs.readFile(path.join(base, "run-hidden.vbs"), "utf8");
  const remove = await fs.readFile(path.join(base, "remove-task-scan-schedule.ps1"), "utf8");
  const status = await fs.readFile(path.join(base, "task-scan-schedule-status.ps1"), "utf8");
  assert.match(install, /WyerpTaskboard-TaskScan/);
  assert.match(install, /IntervalMinutes/);
  assert.match(install, /wscript\.exe/);
  assert.match(install, /\/\/B \/\/Nologo/);
  assert.match(install, /run-hidden\.vbs/);
  assert.match(hidden, /shell\.Run\(command, 0, True\)/);
  assert.match(install, /task-scan\.mjs/);
  assert.match(install, /"scheduled"/);
  assert.doesNotMatch(install, /powershell\.exe/i);
  assert.doesNotMatch(install, /run-task-scan\.ps1/);
  assert.match(install, /New-TimeSpan -Minutes \$IntervalMinutes/);
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /MultipleInstances IgnoreNew/);
  assert.match(install, /StartWhenAvailable/);
  assert.match(install, /New-TimeSpan -Minutes 8/);
  assert.match(remove, /Unregister-ScheduledTask/);
  assert.match(status, /Get-ScheduledTask -TaskName/);
  assert.match(status, /NextRunTime/);
});

test("candidate consumption is idempotent and preserves the first real claim", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();

  const candidate = (await scanStore.list()).find((x) => x.task_id === "A-10");
  assert.ok(candidate);
  const first = await scanStore.mark(candidate.detection_id, "consumed", { claimEventId: "evt_claim_1" });
  assert.equal(first.claim_event_id, "evt_claim_1");
  const second = await scanStore.mark(candidate.detection_id, "consumed", { claimEventId: "evt_claim_1" });
  assert.equal(second.claim_event_id, "evt_claim_1");
  await assert.rejects(
    () => scanStore.mark(candidate.detection_id, "consumed", { claimEventId: "evt_claim_2" }),
    (error) => error.code === "CANDIDATE_ALREADY_CONSUMED"
  );
  const events = await scanStore.recentEvents(20);
  assert.equal(events.filter((x) => x.type === "candidate_consumed").length, 1);
});

test("two consumers racing the same candidate produce only one real claim", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();

  const candidate = (await scanStore.list()).find((x) => x.task_id === "A-10");
  assert.ok(candidate?.eligible);
  const before = await taskStore.snapshot("fixture");
  const expectedRevision = before.registryRevision;

  const attempt = (suffix) => taskStore.updateTask("fixture", "A-10", {
    status: "开发中",
    assignee: "consumer-" + suffix,
    sessionWindowName: "窗口-" + suffix,
    sessionId: "sess-" + suffix
  }, {
    expectedRevision,
    operationId: "scan.race." + suffix,
    eventType: "claim",
    actorType: "developer_ai",
    actorId: "consumer-" + suffix,
    sessionWindowName: "窗口-" + suffix,
    sessionId: "sess-" + suffix,
    note: "候选并发claim测试"
  });

  const results = await Promise.allSettled([attempt("1"), attempt("2")]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(results.filter((x) => x.status === "rejected").length, 1);
  const winner = results.find((x) => x.status === "fulfilled").value;
  const loser = results.find((x) => x.status === "rejected").reason;
  assert.ok(["PROJECT_LOCKED", "REVISION_CONFLICT"].includes(loser.code));
  const current = await taskStore.snapshot("fixture");
  const claimed = current.tasks.find((x) => x.id === "A-10");
  assert.equal(claimed.status, "开发中");
  assert.equal(claimed.assignee, winner.after.assignee);

  const recheck = await new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore }).recheck(candidate);
  assert.equal(recheck.stale, true);
  assert.ok(recheck.mismatches.includes("registry_revision_changed"));
  assert.ok(recheck.mismatches.includes("status_changed"));
});

test("one unavailable project is isolated while other whitelist projects continue scanning", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const secondRoot = path.join(fixture.boardRoot, "managed-project-2");
  await fs.mkdir(path.join(secondRoot, "cp"), { recursive: true });
  await fs.mkdir(path.join(secondRoot, "reports"), { recursive: true });
  await fs.writeFile(path.join(secondRoot, "tasks.md"), registryText([
    ["X-01","F-X","product","P1","待开发","开发AI","—","—","—","—","第二项目","计划.md","cp/X-01.md"]
  ]), "utf8");
  await fs.writeFile(path.join(secondRoot, "ledger.md"), "# ledger\n", "utf8");
  await fs.writeFile(path.join(secondRoot, "计划.md"), "# 计划\n", "utf8");

  const configPath = path.join(fixture.boardRoot, "config", "projects.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  config.projects.push({
    id: "fixture2",
    name: "Fixture 2",
    root: secondRoot,
    adapter: "markdown-task-registry-v1",
    registryFormatVersion: 1,
    workflowProfile: "wyerp-ai-flow-v1",
    taskRegistry: "tasks.md",
    resourceLedger: "ledger.md",
    checkpointDir: "cp",
    reportDir: "reports",
    defaultTrack: "product",
    trackOverrides: {}
  });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  await fs.rm(path.join(secondRoot, "tasks.md"));

  const result = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init().then((scanner) => scanner.scanOnce());
  assert.equal(result.project_count, 2);
  assert.equal(result.project_errors, 1);
  assert.equal(result.projects.find((x) => x.project_id === "fixture").status, "ok");
  assert.equal(result.projects.find((x) => x.project_id === "fixture2").status, "source_unavailable");
  assert.ok((await scanStore.list()).some((x) => x.project_id === "fixture" && x.task_id === "A-10"));
});


test("developer candidates require declared write targets and exclude conflicts with active development", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const rows = [
    ["DEV-A","F-A","product","P0","待开发","开发AI","—","—","—","—","候选A","计划A.md","trace/A.md","read/shared.md","src/shared.js","cp/DEV-A.md"],
    ["DEV-B","F-B","product","P0","开发中","开发AI","owner","窗口","sess-owner","2026-09-29T00:00:00Z","执行中B","计划B.md","trace/B.md","read/other.md","src/shared.js","cp/DEV-B.md"],
    ["DEV-C","F-C","product","P1","待开发","开发AI","—","—","—","—","候选C","计划C.md","trace/C.md","read/c.md","","cp/DEV-C.md"],
    ["DEV-D","F-D","product","P0","测试失败待修复","开发AI","—","—","—","—","失败回流D","计划D.md","trace/D.md","read/d.md","src/fix-d.js","cp/DEV-D.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();
  const candidates = await scanStore.list();
  const a = candidates.find((x) => x.task_id === "DEV-A");
  const c = candidates.find((x) => x.task_id === "DEV-C");
  const d = candidates.find((x) => x.task_id === "DEV-D");
  assert.equal(a.eligible, false);
  assert.deepEqual(a.read_dependencies, ["read/shared.md"]);
  assert.deepEqual(a.write_targets, ["src/shared.js"]);
  assert.ok(a.blockers.some((x) => x.includes("DEV-B") && x.includes("src/shared.js")));
  assert.equal(c.eligible, false);
  assert.ok(c.blockers.includes("未声明计划写文件，不能进入待认领"));
  assert.equal(d.eligible, true);
  assert.equal(d.eligible_role, "developer_ai");
  assert.deepEqual(d.write_targets, ["src/fix-d.js"]);
});



test("developer claimable eligibility is recalculated when write conflicts appear and disappear", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();

  const waiting = ["DEV-A","F-A","product","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","候选A","计划A.md","trace/A.md","read/a.md","src/shared.js","cp/DEV-A.md"];
  await fs.writeFile(fixture.registryPath, registryText([waiting]), "utf8");
  await scanner.scanOnce();
  const first = (await scanStore.list()).find((x) => x.task_id === "DEV-A");
  assert.equal(first.eligible, true);
  const firstDetection = first.detection_id;

  const activeConflict = ["DEV-B","F-B","product","P0","开发中","开发AI","owner","窗口","sess-b","2026-09-29T00:00:00Z","执行中B","计划B.md","trace/B.md","read/b.md","src/shared.js","cp/DEV-B.md"];
  await fs.writeFile(fixture.registryPath, registryText([waiting, activeConflict]), "utf8");
  await scanner.scanOnce();
  const conflicted = (await scanStore.list()).find((x) => x.task_id === "DEV-A");
  assert.equal(conflicted.detection_id, firstDetection);
  assert.equal(conflicted.eligible, false);
  assert.ok(conflicted.blockers.some((x) => x.includes("DEV-B") && x.includes("src/shared.js")));

  await fs.writeFile(fixture.registryPath, registryText([waiting]), "utf8");
  await scanner.scanOnce();
  const restored = (await scanStore.list()).find((x) => x.task_id === "DEV-A");
  assert.equal(restored.detection_id, firstDetection);
  assert.equal(restored.eligible, true);
  assert.deepEqual(restored.blockers, []);
});

test("developer candidate queue order prefers delivery then failures then waiting development before priority", async (t) => {
  const fixture = await fixtureWithLedger(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["DEV-DELIVERY","F-D","product","P2","待交付","开发AI","—","—","—","2026-09-29T00:00:00Z","交付","计划D.md","trace/D.md","read/d.md","src/delivery.js","cp/DEV-DELIVERY.md"],
    ["DEV-FAIL","F-F","product","P2","测试失败待修复","开发AI","—","—","—","2026-09-29T00:00:00Z","失败","计划F.md","trace/F.md","read/f.md","src/fix.js","cp/DEV-FAIL.md"],
    ["DEV-WAIT","F-W","product","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","待开发","计划W.md","trace/W.md","read/w.md","src/wait.js","cp/DEV-WAIT.md"],
    ["TEST-RE","F-T","infrastructure","P0","待复测","独立测试AI","—","—","—","2026-09-29T00:00:00Z","待复测","计划T.md","trace/T.md","read/t.md","","cp/TEST-RE.md"]
  ]), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  await taskStore.appendTaskEvent("fixture", "DEV-DELIVERY", {
    operationId: "delivery.queue.real.001", eventType: "test_result", actorType: "test_ai", actorId: "tester",
    metadata: { testResult: "pass", deliveryDisposition: "required", deliveryActions: ["deploy_switch"], handoffTarget: "待交付" }
  });
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();
  const developer = (await scanStore.list()).filter((x) => x.eligible_role === "developer_ai");
  assert.deepEqual(developer.map((x) => x.task_id), ["DEV-DELIVERY","DEV-FAIL","DEV-WAIT"]);
  const testCandidates = (await scanStore.list()).filter((x) => x.eligible_role === "test_ai");
  assert.deepEqual(testCandidates.map((x) => x.status), ["待复测"]);
});

test("latest successful scan supersedes older candidate revisions and removes tasks no longer detected", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();

  const initial = registryText([
    ["A-10","F-001","product","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","initial A","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/A-10.md","write/A-10.js","cp/A-10.md"],
    ["B-10","F-022","infrastructure","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","initial B","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/B-10.md","write/B-10.js","cp/B-10.md"]
  ]);
  await fs.writeFile(fixture.registryPath, initial, "utf8");
  await scanner.scanOnce();
  const initialActive = await scanStore.list();
  const firstA = initialActive.find((x) => x.task_id === "A-10");
  const firstB = initialActive.find((x) => x.task_id === "B-10");
  assert.ok(firstA);
  assert.ok(firstB);

  const parsed = registryText([
    ["A-10","F-001","product","P0","待开发","开发AI","—","—","—","2026-09-29T01:00:00Z","updated boundary","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/A-10.md","write/A-10.js","cp/A-10.md"],
    ["B-10","F-022","infrastructure","P0","HOLD","开发AI","—","—","—","2026-09-29T01:00:00Z","paused","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/B-10.md","write/B-10.js","cp/B-10.md"]
  ]);
  await fs.writeFile(fixture.registryPath, parsed, "utf8");
  await scanner.scanOnce();

  const active = await scanStore.list();
  assert.equal(active.filter((x) => x.task_id === "A-10").length, 1);
  assert.equal(active.some((x) => x.task_id === "B-10"), false);
  const inactive = await scanStore.list({ includeInactive: true });
  const oldA = inactive.find((x) => x.detection_id === firstA.detection_id);
  assert.equal(oldA.stale_reason, "superseded");
  const oldB = inactive.find((x) => x.detection_id === firstB.detection_id);
  assert.equal(oldB.stale_reason, "not_detected_in_latest_scan");
});

test("failed project scan does not stale prior active candidates", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();

  await scanner.scanOnce();
  const before = await scanStore.list();
  assert.ok(before.length);

  await fs.rename(fixture.registryPath, fixture.registryPath + ".missing");
  await scanner.scanOnce();
  const after = await scanStore.list();
  assert.equal(after.length, before.length);
});

test("scheduled CLI skips idle_hunt before due and rearm forces a one-shot", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  await scanStore.writeStatus({ state: "completed", scheduler_mode: "idle_hunt", rearm_pending: false, next_due_at: new Date(Date.now() + 60_000).toISOString() });

  const missing = fixture.registryPath + ".missing";
  await fs.rename(fixture.registryPath, missing);
  const idle = await execFileAsync(process.execPath, [TASK_SCAN_CLI, "scheduled"], {
    env: { ...process.env, WYERP_TASKBOARD_ROOT: fixture.boardRoot }, windowsHide: true
  });
  const skipped = JSON.parse(idle.stdout);
  assert.equal(skipped.state, "skipped");
  assert.equal(skipped.reason, "not_due");
  assert.equal(skipped.run, false);

  await fs.rename(missing, fixture.registryPath);
  await scanStore.requestRearm("test_rearm", { source: "unit" });
  const rearmed = await execFileAsync(process.execPath, [TASK_SCAN_CLI, "scheduled"], {
    env: { ...process.env, WYERP_TASKBOARD_ROOT: fixture.boardRoot }, windowsHide: true
  });
  const scanned = JSON.parse(rearmed.stdout);
  assert.equal(scanned.state, "completed");
  assert.equal(scanned.trigger, "scheduled");
  assert.equal(scanned.rearm_pending, false);
});

test("busy scanner next_due_at follows configured busy interval", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const now = Date.parse("2026-09-29T00:00:00Z");
  await fs.writeFile(path.join(fixture.boardRoot, "config", "ai-execution.json"), JSON.stringify({
    scan_interval_minutes: 7
  }), "utf8");
  await fs.writeFile(fixture.registryPath, registryText([
    ["A-10","F-001","product","P0","开发中","开发AI","owner","窗口","sess-owner","2026-09-29T00:00:00Z","A","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/A-10.md","write/A-10.js","cp/A-10.md"]
  ]), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot, { clock: () => now }).init();
  const result = await new TaskScanner(fixture.boardRoot, {
    clock: () => now, taskStore, requirementStore, scanStore
  }).init().then(scanner => scanner.scanOnce());
  assert.equal(result.scheduler_mode, "busy_watch");
  assert.equal(result.scan_interval_minutes, 7);
  assert.equal(Date.parse(result.next_due_at) - Date.parse(result.last_scan_at), 7 * 60 * 1000);
});

test("scheduled decision supports busy_watch and idle_hunt due times", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const now = Date.parse("2026-09-29T00:00:00Z");
  const scanStore = await new ScanStore(fixture.boardRoot, { clock: () => now }).init();
  await scanStore.writeStatus({ scheduler_mode: "busy_watch", rearm_pending: false, next_due_at: new Date(now).toISOString() });
  let decision = await scanStore.scheduledDecision();
  assert.equal(decision.run, true);
  assert.equal(decision.reason, "interval_due");
  await scanStore.writeStatus({ scheduler_mode: "idle_hunt", rearm_pending: false, next_due_at: new Date(now + 10_000).toISOString() });
  decision = await scanStore.scheduledDecision();
  assert.equal(decision.run, false);
  assert.equal(decision.reason, "not_due");
});
test("developer preparation task is claimable when gates pass and non-developer preparation is not", async (t) => {
  const fixture = await fixtureWithLedger(t);
  await fs.writeFile(fixture.registryPath, registryText([
    ["PREP-DEV","F-P","product","P0","待准备","开发AI","—","—","—","2026-09-29T00:00:00Z","补证据","计划.md","trace/P.md","read/P.md","src/prep.js","cp/PREP-DEV.md"],
    ["PREP-TEST","F-T","product","P1","待准备","独立测试AI","—","—","—","2026-09-29T00:00:00Z","错误角色","计划.md","trace/T.md","read/T.md","src/test.js","cp/PREP-TEST.md"]
  ]), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();
  const candidates = await scanStore.list();
  const prep = candidates.find((x) => x.task_id === "PREP-DEV");
  assert.equal(prep.eligible, true);
  assert.equal(prep.eligible_role, "developer_ai");
  assert.equal(prep.status, "待准备");
  assert.equal(candidates.some((x) => x.task_id === "PREP-TEST"), false);
});

test("hard task prerequisites block candidates until every declared task is completed", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const dependencyRows = [
    ["B-04","F-004","product","P0","已完成","—","—","—","—","2026-10-06T00:00:00Z","容量已完成","计划.md","trace/B-04.md","read/B-04.md","src/B-04.js","cp/B-04.md"],
    ["B-05B","F-019","product","P0","阻断","—","—","—","—","2026-10-06T00:00:00Z","迁移阻断","计划.md","trace/B-05B.md","read/B-05B.md","src/B-05B.js","cp/B-05B.md"],
    ["B-07A","F-SEC","product","P0","待复测","独立测试AI","—","—","—","2026-10-06T00:00:00Z","安全待复测","计划.md","trace/B-07A.md","read/B-07A.md","src/B-07A.js","cp/B-07A.md"],
    ["B-08","F-PUBLIC","infrastructure","P0","待准备","开发AI","—","—","—","—","公网部署准备","计划.md","trace/B-08.md","B-04完成；B-05B完成；B-07A完成；erp/db/README.md","ops/deploy.js","cp/B-08.md"],
    ["DEP-MISSING","F-MISSING","infrastructure","P1","待准备","开发AI","—","—","—","—","缺失前置","计划.md","trace/MISSING.md","MISSING-01完成；docs/guide.md","ops/missing.js","cp/DEP-MISSING.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(dependencyRows), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  await scanner.scanOnce();

  const firstCandidates = await scanStore.list();
  const blocked = firstCandidates.find((item) => item.task_id === "B-08");
  assert.ok(blocked);
  assert.equal(blocked.eligible, false);
  assert.ok(blocked.blockers.includes("前置任务B-05B未完成（当前：阻断）"));
  assert.ok(blocked.blockers.includes("前置任务B-07A未完成（当前：待复测）"));
  assert.equal(blocked.blockers.some((item) => item.includes("B-04")), false);
  assert.equal(blocked.blockers.some((item) => item.includes("README.md")), false);
  const firstDetectionId = blocked.detection_id;

  const missing = firstCandidates.find((item) => item.task_id === "DEP-MISSING");
  assert.equal(missing.eligible, false);
  assert.ok(missing.blockers.includes("前置任务MISSING-01未登记"));
  assert.equal(missing.blockers.some((item) => item.includes("docs/guide.md")), false);

  const completedRows = structuredClone(dependencyRows);
  completedRows[1][4] = "已完成";
  completedRows[1][5] = "—";
  completedRows[2][4] = "已完成";
  completedRows[2][5] = "—";
  await fs.writeFile(fixture.registryPath, registryText(completedRows), "utf8");
  await scanner.scanOnce();
  const restored = (await scanStore.list()).find((item) => item.task_id === "B-08");
  assert.equal(restored.detection_id, firstDetectionId);
  assert.equal(restored.eligible, true);
  assert.deepEqual(restored.blockers, []);
});

test("recheck rejects a previously eligible candidate when a hard prerequisite regresses", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const rows = [
    ["B-05B","F-019","product","P0","已完成","—","—","—","—","2026-10-06T00:00:00Z","迁移完成","计划.md","trace/B-05B.md","read/B-05B.md","src/B-05B.js","cp/B-05B.md"],
    ["B-08","F-PUBLIC","infrastructure","P0","待准备","开发AI","—","—","—","—","公网部署准备","计划.md","trace/B-08.md","B-05B完成","ops/deploy.js","cp/B-08.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(rows), "utf8");
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const evaluator = new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore });
  const evaluated = await evaluator.evaluateProject("fixture");
  const candidate = evaluated.candidates.find((item) => item.task_id === "B-08");
  assert.equal(candidate.eligible, true);

  const regressedRows = structuredClone(rows);
  regressedRows[0][4] = "阻断";
  await fs.writeFile(fixture.registryPath, registryText(regressedRows), "utf8");
  const recheck = await evaluator.recheck(candidate);
  assert.equal(recheck.ok, false);
  assert.equal(recheck.stale, true);
  assert.ok(recheck.mismatches.includes("hard_dependency_blocked"));
  assert.ok(recheck.blockers.includes("前置任务B-05B未完成（当前：阻断）"));
});

test("unrelated registry changes keep detection_id stable and refresh recheck truth", async (t) => {
  const fixture = await fixtureWithLedger(t);
  const taskStore = await new TaskStore(fixture.boardRoot).init();
  const requirementStore = await new RequirementStore(fixture.boardRoot).init();
  const scanStore = await new ScanStore(fixture.boardRoot).init();
  const scanner = await new TaskScanner(fixture.boardRoot, { taskStore, requirementStore, scanStore }).init();
  const rows1 = [
    ["A-10","F-001","product","P0","待开发","开发AI","—","—","—","2026-09-29T00:00:00Z","A stable","任务看板与AI协作控制开发计划.md","tests/fixture-source.txt","read/A-10.md","write/A-10.js","cp/A-10.md"],
    ["X-01","F-X","product","P1","待准备","开发AI","—","—","—","2026-09-29T00:00:00Z","X old","计划.md","trace/X.md","read/X.md","","cp/X-01.md"]
  ];
  await fs.writeFile(fixture.registryPath, registryText(rows1), "utf8");
  await scanner.scanOnce();
  const first = (await scanStore.list()).find((x) => x.task_id === "A-10");
  const firstDetection = first.detection_id;
  const firstRevision = first.registry_revision;
  const rows2 = structuredClone(rows1);
  rows2[1][9] = "2026-09-29T01:00:00Z";
  rows2[1][10] = "X changed only";
  await fs.writeFile(fixture.registryPath, registryText(rows2), "utf8");
  await scanner.scanOnce();
  const second = (await scanStore.list()).find((x) => x.task_id === "A-10");
  assert.equal(second.detection_id, firstDetection);
  assert.notEqual(second.registry_revision, firstRevision);
  const recheck = await new CandidateEvaluator(fixture.boardRoot, { taskStore, requirementStore }).recheck(second);
  assert.equal(recheck.stale, false);
});
