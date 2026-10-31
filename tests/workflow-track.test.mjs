import test from "node:test";
import assert from "node:assert/strict";
import { wyerpAiFlowV1 as workflow } from "../server/workflows/wyerp-ai-flow-v1.mjs";

test("wyerp-ai-flow-v1 accepts product, bugfix and infrastructure tracks", () => {
  for (const track of ["product", "product/video", "product/video+image", "product/order/return", "bugfix", "infrastructure"]) assert.doesNotThrow(() => workflow.validateTrack(track));
  for (const track of ["unknown", "foo/bar", "product/", "product/video bad"]) assert.throws(() => workflow.validateTrack(track), (error) => error.code === "INVALID_TRACK");
});

test("same-priority track ordering keeps product before bugfix before infrastructure", () => {
  const tasks = [
    { priority:"P0", track:"infrastructure" },
    { priority:"P0", track:"bugfix" },
    { priority:"P0", track:"product/video" },
    { priority:"P0", track:"product" }
  ];
  const order = tasks.map((task,index)=>({index,score:workflow.sortKey(task)}))
    .sort((a,b)=>a.score-b.score).map(({index})=>tasks[index].track);
  assert.deepEqual(order, ["product/video","product","bugfix","infrastructure"]);
});

test("acceptance scope defaults to system across tracks and preserves explicit and legacy user scope", () => {
  for (const track of ["product", "product/video", "bugfix", "infrastructure"]) {
    assert.equal(workflow.resolveAcceptanceScope({ track }, []), "system", track);
  }
  assert.equal(workflow.resolveAcceptanceScope({ track: "product" }, [{ event_type: "task_created", metadata: { acceptanceScope: "user_ui_business" } }]), "user_ui_business");
  assert.equal(workflow.resolveAcceptanceScope({ track: "product", status: "待用户验收" }, []), "user_ui_business");
  assert.equal(workflow.resolveAcceptanceScope({ track: "product" }, [{ event_type: "test_result", metadata: { deliveryDisposition: "user_acceptance" } }]), "user_ui_business");
  assert.equal(workflow.resolveAcceptanceScope({ track: "product", status: "待用户验收" }, [{ event_type: "task_created", metadata: { acceptanceScope: "system" } }]), "system");
});

test("independent PASS derives the correct next state from acceptance scope and delivery actions", () => {
  assert.deepEqual(workflow.resolveIndependentTestOutcome("独测中", "pass", { acceptanceScope: "system" }), {
    status: "已完成", plannedRole: "", deliveryDisposition: "auto_close", deliveryActions: []
  });
  assert.deepEqual(workflow.resolveIndependentTestOutcome("复测中", "pass", { acceptanceScope: "user_ui_business" }), {
    status: "待用户验收", plannedRole: "用户", deliveryDisposition: "user_acceptance", deliveryActions: []
  });
  assert.deepEqual(workflow.resolveIndependentTestOutcome("独测中", "pass", { acceptanceScope: "system", deliveryActions: ["candidate_merge"] }), {
    status: "待交付", plannedRole: "开发AI", deliveryDisposition: "required", deliveryActions: ["candidate_merge"]
  });
  assert.throws(
    () => workflow.resolveIndependentTestOutcome("独测中", "pass", { acceptanceScope: "system", deliveryActions: "candidate_merge" }),
    (error) => error.code === "INVALID_DELIVERY_ACTION"
  );
  assert.throws(
    () => workflow.resolveIndependentTestOutcome("独测中", "pass", { acceptanceScope: "system", deliveryActions: [" "] }),
    (error) => error.code === "INVALID_DELIVERY_ACTION"
  );
});
