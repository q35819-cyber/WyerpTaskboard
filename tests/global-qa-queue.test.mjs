import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const app = await fs.readFile(path.join(root, "web/app.js"), "utf8");
const html = await fs.readFile(path.join(root, "web/index.html"), "utf8");
const helpers = app.slice(app.indexOf("function qaCandidateSha("), app.indexOf("async function loadScanStatus("));

test("R1 cross-project QA panel is read-only and uses registered projects", () => {
  assert.match(html, /id="globalQaQueue"/);
  assert.match(html, /id="globalQaSummary"/);
  assert.match(html, /id="globalQaList"/);
  assert.match(app, /state\.projects\.slice\(\)/);
  assert.match(helpers, /encodeURIComponent\(project\.id\)\+"\/tasks"/);
  assert.match(helpers, /encodeURIComponent\(task\.id\)\+"\/history\?limit=200"/);
  assert.doesNotMatch(helpers, /method:\s*["'](?:POST|PATCH|DELETE)["']/);
  assert.match(app, /await loadGlobalQaQueue\(\)/);
});

test("R1 real code_published SHA remains visible when handoff lacks commitSha", () => {
  const ctx = vm.createContext({});
  vm.runInContext(helpers + "\nthis.readSha=qaCandidateSha;", ctx);
  const sha = "250470ffc2b6e2565aa756c1892c7987925ac63c";
  const developer = "wtb-dev-cross-project-qa-view-20261106-5acbc19f";
  assert.equal(ctx.readSha([
    { event_type:"code_published", actor_type:"developer_ai", actor_id:developer,
      metadata:{commitSha:sha,branch:"feat/WTB-P1-CROSS-PROJECT-QA-VIEW-20261104-T1",remoteVerified:true}},
    { event_type:"handoff", actor_type:"developer_ai", actor_id:developer, metadata:{atomicLifecycle:true}}
  ]),sha);
});
test("R2 fake, mismatched and unverified code_published cannot supply candidate SHA", () => {
  const ctx = vm.createContext({});
  vm.runInContext(helpers + "\nthis.readSha=qaCandidateSha;", ctx);
  const sha = "a".repeat(40), handoff = {event_type:"handoff",actor_type:"developer_ai",actor_id:"dev-a"};
  const proof = {event_type:"code_published",actor_type:"developer_ai",actor_id:"dev-a",
    metadata:{commitSha:sha,branch:"fix/candidate",remoteVerified:true}};
  assert.equal(ctx.readSha([proof,handoff]),sha);
  assert.equal(ctx.readSha([handoff,proof]),"待核验","proof after handoff must not validate earlier candidate");
  assert.equal(ctx.readSha([{...proof,actor_id:"other-dev"},handoff]),"待核验");
  assert.equal(ctx.readSha([{...proof,actor_type:"controller_ai"},handoff]),"待核验");
  assert.equal(ctx.readSha([{...proof,metadata:{...proof.metadata,remoteVerified:false}},handoff]),"待核验");
  assert.equal(ctx.readSha([{...proof,metadata:{...proof.metadata,commitSha:"fake"}},handoff]),"待核验");
  assert.equal(ctx.readSha([{...proof,metadata:{...proof.metadata,branch:" "}},handoff]),"待核验");
  assert.equal(ctx.readSha([proof,{...handoff,actor_type:"test_ai"}]),"待核验");
  assert.equal(ctx.readSha([{event_type:"test_result",actor_type:"test_ai",metadata:{commitSha:sha}},handoff]),"待核验");
  assert.equal(ctx.readSha([]),"待核验");
});

test("R2 simultaneous projects retain project identity and show multiple QA occupancies", () => {
  const summary = { textContent: "" };
  const list = { rows: [], replaceChildren(...items) { this.rows = items; } };
  const context = vm.createContext({
    state: { globalQa: [
      { projectId: "alpha", pending: [{projectId:"alpha",taskId:"SAME",status:"待独测",sha:"a".repeat(40)}],
        running: [{projectId:"alpha",taskId:"QA-1",status:"独测中",assignee:"Q1",session:"session-alpha"}] },
      { projectId: "beta", pending: [{projectId:"beta",taskId:"SAME",status:"待复测",sha:"读取失败"}],
        running: [{projectId:"beta",taskId:"QA-2",status:"复测中",assignee:"Q2",session:"session-beta"}] }
    ]},
    els: { globalQaSummary:summary, globalQaList:list },
    document: { createElement() { return { textContent:"", className:"" }; } }
  });
  vm.runInContext(helpers + "\nrenderGlobalQaQueue();", context);
  assert.match(summary.textContent, /待独测\/待复测 2/);
  assert.match(summary.textContent, /警告：全局存在多个独测占用/);
  assert.equal(list.rows.length, 4);
  assert.ok(list.rows.some(x=>x.textContent.includes("alpha / SAME")));
  assert.ok(list.rows.some(x=>x.textContent.includes("beta / SAME")&&x.textContent.includes("读取失败")));
  assert.ok(list.rows.some(x=>x.textContent.includes("session-alpha")));
  assert.ok(list.rows.some(x=>x.textContent.includes("session-beta")));
});

test("R3 unavailable project remains visible rather than being silently discarded", () => {
  const summary={textContent:""}, list={rows:[],replaceChildren(...x){this.rows=x;}};
  const context=vm.createContext({state:{globalQa:[{projectId:"offline",error:"项目不可用",pending:[],running:[]}]},els:{globalQaSummary:summary,globalQaList:list},document:{createElement(){return {textContent:"",className:""};}}});
  vm.runInContext(helpers+"\nrenderGlobalQaQueue();",context);
  assert.match(summary.textContent,/1 个项目不可读取/);
  assert.match(list.rows[0].textContent,/offline 读取失败/);
});
