import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanIndex, exactTaskRegex } from "../web/plan-index.mjs";

test("task id matching does not confuse B-10 with B-10-AUTO",()=>{
  const re=exactTaskRegex("B-10");
  assert.equal(re.test("### B-10｜主任务"),true);
  assert.equal(re.test("### B-10-AUTO｜自动巡检"),false);
});

test("plan index prefers a heading containing the exact task id",()=>{
  const content=[
    "# 总计划",
    "",
    "正文提到 B-10-AUTO 但不是B-10。",
    "## B-10｜独立任务看板",
    "B-10 细节",
    "### R8｜B-10-AUTO",
    "更多内容"
  ].join("\n");
  const result=buildPlanIndex(content,"B-10");
  assert.equal(result.targetLine,4);
  assert.equal(result.foundTask,true);
  assert.ok(result.entries.some((entry)=>entry.lineNumber===4&&entry.taskMatch));
});

test("plan index exposes headings and task references with stable line numbers",()=>{
  const content="# 标题\n正文\n## 模块\n任务 A-01 在这里\n### 子节";
  const result=buildPlanIndex(content,"A-01");
  assert.deepEqual(result.entries.map((entry)=>entry.lineNumber),[1,3,4,5]);
  assert.equal(result.targetLine,4);
});

test("missing task id has explicit no-target result while headings remain usable",()=>{
  const result=buildPlanIndex("# 总计划\n## A模块\n正文","Z-99");
  assert.equal(result.foundTask,false);
  assert.equal(result.targetLine,null);
  assert.deepEqual(result.entries.map((entry)=>entry.label),["总计划","A模块"]);
});
