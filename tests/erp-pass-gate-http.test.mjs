import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createTaskboardServer } from "../server/http-server.mjs";
import { makeFixture } from "./helpers.mjs";
const URL_PATH="/api/erp-release/pass/verify";
const PASS_TOKEN="t".repeat(48);
async function service(t,options={}){
 const fixture=await makeFixture();
 const app=await createTaskboardServer({rootDir:fixture.boardRoot,host:"127.0.0.1",port:0,erpPassGateOptions:options});
 await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));await fs.rm(fixture.boardRoot,{recursive:true,force:true});});
 const base="http://127.0.0.1:"+app.server.address().port;
 const secret=JSON.parse(await fs.readFile(path.join(fixture.boardRoot,"config","admin-secret.json"),"utf8")).adminSecret;
 return {base,secret,app};
}
function config(){return {WTB_ERP_PASS_DISPATCH_ENABLED:"1",WTB_ERP_PASS_VERIFY_URL:"https://board.example.test"+URL_PATH,WTB_ERP_PASS_VERIFY_TOKEN:PASS_TOKEN,WTB_ERP_GITHUB_DISPATCH_TOKEN:"g".repeat(48)};}
test("disabled verification route is HTTP 503; admin secret cannot bypass dedicated pass token",async t=>{
 const d=await service(t,{env:{}}),x=await fetch(d.base+URL_PATH,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 assert.equal(x.status,503);
 const enabled=await service(t,{env:config()});
 const bare=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
 assert.equal(bare.status,401);
 const admin=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Authorization:"Bearer "+enabled.secret},body:"{}"});
 assert.equal(admin.status,401);
 const bad=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Authorization:"Bearer "+PASS_TOKEN,"Content-Type":"application/json"},body:"{}"});
 assert.equal(bad.status,400);
 const origin=await fetch(enabled.base+URL_PATH,{method:"POST",headers:{Origin:"https://evil.example",Authorization:"Bearer "+PASS_TOKEN},body:"{}"});
 assert.equal(origin.status,403);
});
test("local browser retry requires CSRF and cannot retry unknown evidence",async t=>{
 const x=await service(t,{env:config()});
 let r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Authorization:"Bearer "+PASS_TOKEN,"Content-Type":"application/json"},body:JSON.stringify({evidence_id:"evt_"+"a".repeat(24)})});
 assert.equal(r.status,401);
 r=await fetch(x.base+"/api/auth/session");
 assert.equal(r.status,200);const csrf=(await r.json()).csrfToken,cookie="";
 r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Cookie:cookie,Origin:x.base,"Content-Type":"application/json"},body:"{}"});
 assert.equal(r.status,403);
 r=await fetch(x.base+"/api/erp-release/pass/retry",{method:"POST",headers:{Cookie:cookie,Origin:x.base,"X-CSRF-Token":csrf,"Content-Type":"application/json"},body:JSON.stringify({evidence_id:"evt_"+"a".repeat(24)})});
 assert.equal(r.status,409);
});
