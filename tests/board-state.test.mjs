import test from "node:test";
import assert from "node:assert/strict";
import { countReadyColumnBugs, paginateColumn, resolveProjectId, tasksForColumn } from "../web/board-state.mjs";

test("restores the last selected registered project instead of silently returning to the first project",()=>{
  const projects=[{id:"wyerp-taskboard"},{id:"erp-x20"}];
  assert.equal(resolveProjectId(projects,null,"erp-x20"),"erp-x20");
  assert.equal(resolveProjectId(projects,"erp-x20","wyerp-taskboard"),"erp-x20");
  assert.equal(resolveProjectId(projects,null,"missing"),"wyerp-taskboard");
});

test("first board column membership depends only on task status and not candidate eligibility",()=>{
  const tasks=[
    {id:"B-09-PRE",status:"待准备",plannedRole:"开发AI",candidate:{eligible:false}},
    {id:"INFRA-WTB-003",status:"待开发",plannedRole:"开发AI",candidate:null},
    {id:"A-10",status:"待独测",plannedRole:"独立测试AI",candidate:{eligible:true}}
  ];
  const visible=tasksForColumn(tasks,["待确认","待准备","待开发"]);
  assert.deepEqual(visible.map(task=>task.id),["B-09-PRE","INFRA-WTB-003"]);
});

test("first column with two tasks renders both on page one and clamps invalid page state",()=>{
  const tasks=[{id:"B-09-PRE"},{id:"INFRA-WTB-003"}];
  assert.deepEqual(paginateColumn(tasks,1,3),{page:1,totalPages:1,visible:tasks});
  assert.deepEqual(paginateColumn(tasks,99,3),{page:1,totalPages:1,visible:tasks});
  assert.deepEqual(paginateColumn(tasks,Number.NaN,3),{page:1,totalPages:1,visible:tasks});
});

test("shared ready BUG counter includes visible QA bugfix once and ignores pagination",()=>{
  const list=[
    {id:"B-01",track:"bugfix",status:"待开发"},
    {id:"B-02",track:"bugfix",status:"待独测"},
    {id:"B-03",track:"bugfix",status:"待复测"},
    {id:"P-01",track:"product",status:"待开发"},
    {id:"P-02",track:"product",status:"待独测"},
    {id:"B-02",track:"bugfix",status:"待独测"}
  ];
  assert.equal(countReadyColumnBugs([]),0);
  assert.equal(countReadyColumnBugs(list),3);
  assert.equal(countReadyColumnBugs(paginateColumn(list,1,3).visible),3);
  assert.equal(countReadyColumnBugs(paginateColumn(list,2,3).visible),1);
  assert.equal(countReadyColumnBugs(list),3,"column count must use unpaginated tasks");
  assert.equal(countReadyColumnBugs([list[3],list[4]]),0);
  assert.equal(countReadyColumnBugs([list[0]]),1);
});

test("shared ready counter excludes blocked, HOLD, other project and filtered-out tasks via column membership",()=>{
  const all=[
    {id:"B-01",track:"bugfix",status:"待独测",projectId:"A"},
    {id:"B-02",track:"bugfix",status:"阻断",projectId:"A"},
    {id:"B-03",track:"bugfix",status:"HOLD",projectId:"A"},
    {id:"B-04",track:"bugfix",status:"待独测",projectId:"B"},
    {id:"B-05",track:"bugfix",status:"已完成",projectId:"A"},
    {id:"P-01",track:"product",status:"待复测",projectId:"A"}
  ];
  const filtered=all.filter(t=>t.projectId==="A");
  const shared=tasksForColumn(filtered,["待独测","待复测"]);
  assert.equal(countReadyColumnBugs(shared),1);
  assert.equal(countReadyColumnBugs(tasksForColumn(filtered.filter(t=>t.id!=="B-01"),["待独测","待复测"])),0);
});
