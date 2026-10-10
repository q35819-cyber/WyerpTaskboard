import test from "node:test";
import assert from "node:assert/strict";
import { paginateColumn, resolveProjectId, tasksForColumn } from "../web/board-state.mjs";

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
