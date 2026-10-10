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
