import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateRoot = path.join(root, "templates/webcodex-v1");

async function sources() {
  const [agents, workflow] = await Promise.all([
    fs.readFile(path.join(templateRoot, "AGENTS.md"), "utf8"),
    fs.readFile(path.join(templateRoot, "WORKFLOW.md"), "utf8")
  ]);
  return { agents, workflow };
}

function verifyRoleOwnership(agents, workflow) {
  assert.match(agents, /流程文档\/00_统一入口\.md/);
  for (const role of ["总控", "开发", "独测"]) assert.ok(agents.includes("流程文档/" + role + "/00_角色入口.md"));
  assert.match(agents, /PASS 后由总控以合法身份合并/);
  assert.match(workflow, /总控负责：同步最新远端主分支/);
  assert.match(workflow, /由总控以自己合法actor-id\/Session认领交付/);
  assert.match(workflow, /总控以合法controller_ai和自己的Session执行taskctl complete/);
  for (const old of [
    /三角色完整职责在\*\*当前项目根目录/,
    /完整细节见当前项目根目录 `开发AI\.md`/,
    /PASS 后由原开发者合并/,
    /原开发者负责：同步最新远端主分支/,
    /只有原开发者在原Session中可以认领/,
    /原开发者以原actor-id\/Session执行taskctl complete/
  ]) {
    assert.doesNotMatch(agents + "\n" + workflow, old);
  }
}

test("R1: source template selects the three-role entry and controller delivery", async () => {
  const { agents, workflow } = await sources();
  verifyRoleOwnership(agents, workflow);
  assert.match(agents, /根目录旧角色文档不是活动权威/);
  assert.match(workflow, /唯一生效权威为流程文档中的最新版本与角色入口/);
  for (const name of ["00_统一入口.md", "总控/00_角色入口.md", "开发/00_角色入口.md", "独测/00_角色入口.md"]) {
    const file = path.join(templateRoot, "流程文档", name);
    assert.ok((await fs.stat(file)).isFile());
  }
});

test("R1: when integrated manifest exists, it requires the published role entry files", async (t) => {
  const file = path.join(root, "templates/software-project-v1/manifest.json");
  let raw;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    t.diagnostic("The separate P1 template-link candidate has not been merged into this main; integrated manifest requires a later QA check");
    return;
  }
  const manifest = JSON.parse(raw);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.source, "../webcodex-v1");
  for (const name of ["AGENTS.md", "WORKFLOW.md", "流程文档/00_统一入口.md",
    "流程文档/总控/00_角色入口.md", "流程文档/开发/00_角色入口.md",
    "流程文档/独测/00_角色入口.md", ".agents/skills/ponytail/SKILL.md"]) {
    assert.ok(manifest.files.includes(name), name);
    assert.ok((await fs.stat(path.join(templateRoot, name))).isFile(), name);
  }
  for (const removed of ["开发AI.md", "总控AI.md", "独立测试AI.md"]) {
    assert.ok(!manifest.files.includes(removed), removed);
  }
});

test("R2: old developer-merge and missing-root entry drift is rejected", async () => {
  const { agents, workflow } = await sources();
  for (const [badAgents, badWorkflow] of [
    [agents.replace("三角色唯一职责", "三角色完整职责在**当前项目根目录**"), workflow],
    [agents, workflow + "\n原开发者负责：同步最新远端主分支"],
    [agents, workflow + "\n只有原开发者在原Session中可以认领"],
    [agents + "\nPASS 后由原开发者合并", workflow]
  ]) {
    assert.throws(() => verifyRoleOwnership(badAgents, badWorkflow), assert.AssertionError);
  }
});

test("R3: flow retains STOP, independent QA and Git SHA safeguards", async () => {
  const { agents, workflow } = await sources();
  const authoritativeBugRule = await fs.readFile(path.join(templateRoot, "流程文档/07_全软件BUG强制修复与闭环续接规范.md"), "utf8");
  for (const guard of ["STOP", "HOLD", "依赖"]) assert.ok(authoritativeBugRule.includes(guard), guard);
  assert.match(workflow, /独测者必须不同于开发者/);
  assert.match(workflow, /重新自测和独测/);
  assert.match(agents, /不允许伪造 PASS/);
  assert.match(agents, /保全主目录未提交与其它AI工作区/);
});
