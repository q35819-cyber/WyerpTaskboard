import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";

test("board state module is public static while project API remains authenticated", async (t) => {
  const fixture=await makeFixture();
  await fs.copyFile("web/board-state.mjs", fixture.boardRoot+"/web/board-state.mjs");
  const app=await createTaskboardServer({rootDir:fixture.boardRoot,host:"127.0.0.1",port:0});
  await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(0,"127.0.0.1",resolve)});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>app.server.close(resolve));
    await fs.rm(fixture.boardRoot,{recursive:true,force:true});
  });

  const moduleResponse=await fetch(base+"/board-state.mjs");
  assert.equal(moduleResponse.status,200);
  assert.match(moduleResponse.headers.get("content-type")||"",/text\/javascript/);
  assert.equal(moduleResponse.headers.get("cache-control"),"no-store");
  assert.match(await moduleResponse.text(),/export function tasksForColumn/);

  const denied=await fetch(base+"/api/projects");
  assert.equal(denied.status,401);
});
