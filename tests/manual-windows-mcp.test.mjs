import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ManualWindowsMcpClient } from "../server/manual-windows-mcp-client.mjs";

async function fixture(t, { manualOnly = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wyerp-manual-mcp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "runtime", "task-scan"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "runtime", "chatgpt-health"), { recursive: true });
  await fs.mkdir(path.join(root, "data", "runtime", "chat-browser-wake"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "test" }), "utf8");

  const sentinelFiles = [
    path.join(root, "data", "runtime", "task-scan", "status.json"),
    path.join(root, "data", "runtime", "chatgpt-health", "status.json"),
    path.join(root, "data", "runtime", "chat-browser-wake", "state.json")
  ];
  for (const file of sentinelFiles) await fs.writeFile(file, JSON.stringify({ untouched: true }), "utf8");

  const pidFile = path.join(root, "manual-mcp.pid");
  const fake = path.join(root, "fake-manual-mcp.mjs");
  await fs.writeFile(fake, `
import fs from "node:fs";
import readline from "node:readline";
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
function send(v){process.stdout.write(JSON.stringify(v)+"\\n");}
rl.on("line",line=>{
 const m=JSON.parse(line);
 if(m.method==="initialize") return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:"2025-06-18",serverInfo:{name:"fake-manual-mcp",version:"1"}}});
 if(m.method==="tools/list") return send({jsonrpc:"2.0",id:m.id,result:{tools:[{name:"Snapshot"},{name:"Move"},{name:"PowerShell"}]}});
 if(m.method==="tools/call") return send({jsonrpc:"2.0",id:m.id,result:{content:[{type:"text",text:"ok:"+m.params.name}],isError:false}});
});
`, "utf8");

  await fs.writeFile(path.join(root, "config", "manual-windows-mcp.json"), JSON.stringify({
    version: 1,
    manual_only: manualOnly,
    enabled: true,
    transport: "stdio",
    source_root: path.dirname(process.execPath),
    executable: path.basename(process.execPath),
    args: [fake],
    allowed_tools: ["Snapshot", "Move"],
    forbidden_shortcuts: ["ctrl+t"],
    request_timeout_ms: 5000
  }, null, 2), "utf8");

  return { root, sentinelFiles, pidFile };
}

async function contents(files) {
  return Promise.all(files.map((file) => fs.readFile(file, "utf8")));
}

async function waitForProcessExit(pid, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("ManualWindowsMcpClient requires a dedicated manual_only config", async (t) => {
  const { root } = await fixture(t, { manualOnly: false });
  await assert.rejects(
    () => new ManualWindowsMcpClient(root).init(),
    (error) => error?.code === "MANUAL_MCP_CONFIG_NOT_MANUAL_ONLY"
  );
});

test("manual MCP lists only allowlisted tools and reports no automatic integration", async (t) => {
  const { root } = await fixture(t);
  const client = await new ManualWindowsMcpClient(root).init();
  const status = await client.status();
  assert.equal(status.server.name, "fake-manual-mcp");
  assert.equal(status.mode, "manual_only");
  assert.equal(status.automatic_task_integration, false);
  assert.equal(status.scheduler_integration, false);
  assert.equal(status.persistent_session, false);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => [tool.name, tool.allowed]), [
    ["Snapshot", true], ["Move", true], ["PowerShell", false]
  ]);
  await assert.rejects(() => client.callTool("PowerShell", {}), /白名单/);
});

test("manual MCP call leaves task scan, Chat Wake and health runtime state untouched and closes stdio session", async (t) => {
  const { root, sentinelFiles, pidFile } = await fixture(t);
  const before = await contents(sentinelFiles);
  const client = await new ManualWindowsMcpClient(root).init();
  const result = await client.callTool("Snapshot", {});
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /ok:Snapshot/);
  const after = await contents(sentinelFiles);
  assert.deepEqual(after, before);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.equal(Number.isInteger(pid) && pid > 0, true);
  assert.equal(await waitForProcessExit(pid), true);
});
