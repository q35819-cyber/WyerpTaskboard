import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsMcpClient, cursorFromSnapshot } from "../server/windows-mcp-client.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-windows-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.6.6" }), "utf8");
  const fake = path.join(root, "fake-mcp.mjs");
  await fs.writeFile(fake, `
import readline from "node:readline";
let cursor={x:120,y:240};
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function send(v){process.stdout.write(JSON.stringify(v)+"\\n");}
rl.on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="initialize") return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",serverInfo:{name:"fake-windows-mcp",version:"1"}}});
 if(m.method==="tools/list") return send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"Snapshot"},{name:"Move"},{name:"Shell"}]}});
 if(m.method==="tools/call"){
   if(m.params.name==="Move"){cursor={x:m.params.arguments.loc[0],y:m.params.arguments.loc[1]};return send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"moved"}],isError:false}});}
   if(m.params.name==="Snapshot") return send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"Cursor Position: ("+cursor.x+", "+cursor.y+")"}],isError:false}});
 }
});
`, "utf8");
  const nodeRoot = path.dirname(process.execPath);
  await fs.writeFile(path.join(root, "config", "windows-mcp.json"), JSON.stringify({
    version: 1,
    enabled: true,
    transport: "stdio",
    source_root: nodeRoot,
    executable: path.basename(process.execPath),
    args: [fake],
    allowed_tools: ["Snapshot", "Move", "Shortcut"],
    forbidden_shortcuts: ["ctrl+t", "ctrl+n", "ctrl+shift+n"],
    request_timeout_ms: 5000
  }, null, 2));
  return root;
}

test("WindowsMcpClient lists tools and enforces allowlist", async (t) => {
  const root = await fixture(t);
  const client = await new WindowsMcpClient(root).init();
  const listed = await client.listTools();
  assert.equal(listed.server.name, "fake-windows-mcp");
  assert.deepEqual(listed.tools.map(x => [x.name,x.allowed]), [
    ["Snapshot",true],["Move",true],["Shell",false]
  ]);
  await assert.rejects(() => client.callTool("Shell", {}), /白名单/);
});

test("WindowsMcpClient smoke moves and restores cursor through MCP", async (t) => {
  const root = await fixture(t);
  const client = await new WindowsMcpClient(root).init();
  const result = await client.smokeCursorControl();
  assert.equal(result.ok, true);
  assert.deepEqual(result.before, {x:120,y:240});
  assert.deepEqual(result.after, {x:80,y:200});
  assert.deepEqual(result.restored, {x:120,y:240});
});

test("WindowsMcpClient side-effect tools do not require approval unless scoped to ChatGPT", async (t) => {
  const root = await fixture(t);
  const client = await new WindowsMcpClient(root).init();
  const moved = await client.callTool("Move", { loc: [1, 2] });
  assert.equal(moved.isError, false);
});

test("WindowsMcpClient requires approval only for ChatGPT-scoped side effects", async (t) => {
  const root = await fixture(t);
  const calls = [];
  const automationControl = {
    requestAction: async (action) => {
      calls.push(action);
      return { allowed: true, state: "allowed", mode: "approved_once" };
    }
  };
  const client = await new WindowsMcpClient(root, { automationControl }).init();
  await client.callTool("Move", { loc: [1, 2] });
  assert.equal(calls.length, 0);
  await client.callTool("Move", { loc: [3, 4] }, { approvalScope: "chatgpt" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, "windows-mcp");
  assert.equal(calls[0].kind, "Move");
  assert.equal(calls[0].summary, "ChatGPT 操作：Move");
  assert.equal(calls[0].details.approval_scope, "chatgpt");
});

test("WindowsMcpClient fails closed for ChatGPT-scoped side effects when automation control is missing", async (t) => {
  const root = await fixture(t);
  const client = await new WindowsMcpClient(root).init();
  await assert.rejects(
    () => client.callTool("Move", { loc: [1, 2] }, { approvalScope: "chatgpt" }),
    error => error?.code === "AUTOMATION_CONTROL_UNAVAILABLE"
  );
});

test("cursorFromSnapshot parses Windows-MCP snapshot cursor", () => {
  assert.deepEqual(cursorFromSnapshot({content:[{type:"text",text:"Cursor Position: (123, 456)"}]}), {x:123,y:456});
});

test("WindowsMcpClient blocks new-tab and new-window shortcuts before MCP execution", async (t) => {
  const root = await fixture(t);
  const client = await new WindowsMcpClient(root).init();
  await assert.rejects(
    () => client.callTool("Shortcut", { shortcut: "ctrl+t" }),
    error => error?.code === "WINDOWS_MCP_SHORTCUT_FORBIDDEN"
  );
  await assert.rejects(
    () => client.callTool("Shortcut", { shortcut: "Ctrl + Shift + N" }),
    error => error?.code === "WINDOWS_MCP_SHORTCUT_FORBIDDEN"
  );
});
