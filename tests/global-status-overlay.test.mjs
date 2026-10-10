import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("global control overlay exposes required control surfaces", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "scripts", "global-status-overlay.ps1"), "utf8");
  assert.match(content, /无人值守/);
  assert.match(content, /待确认 ChatGPT 操作/);
  assert.doesNotMatch(content, /APPROVAL REQUIRED/);
  assert.match(content, /⚠ 待确认 ChatGPT 操作 — 请允许或拒绝/);
  assert.match(content, /\$titlePanel\.BackColor/);
  assert.match(content, /Invoke-ControlPost "start"/);
  assert.match(content, /Invoke-ControlPost "pause"/);
  assert.match(content, /Invoke-ControlPost "decision"/);
  assert.doesNotMatch(content, /审批链路自测（无操作）/);
  assert.doesNotMatch(content, /control_noop_self_test/);
  assert.match(content, /NotifyIcon/);
  assert.match(content, /ShowBalloonTip/);
  assert.match(content, /Add_MouseMove/);
  assert.match(content, /unattended_available/);
  assert.doesNotMatch(content, /INTERACTION PAUSED/);
  assert.match(content, /后台代码和测试继续/);
  assert.match(content, /动作：/);
  assert.match(content, /last_completed_action/);
  assert.match(content, /Request-ManualStartProof/);
  assert.match(content, /ConsumeLastMouseDown/);
  assert.match(content, /manual-start-proof/);
  assert.match(content, /proof_id = \$script:pendingStartProofId/);
  assert.match(content, /启动失败：/);
  assert.match(content, /候选任务长时间未领取/);
  assert.doesNotMatch(content, /Wyerp Global Control/);
  assert.match(content, /Get-ActiveTaskText "开发AI"/);
  assert.match(content, /Get-ActiveTaskText "测试AI"/);
  assert.match(content, /\$RoleName \+ "："/);
  assert.match(content, /后台工程任务执行中/);
  assert.match(content, /异常待处理：\$anomalyText；下一步：/);

  assert.match(content, /SetWindowsHookEx/);
  assert.match(content, /LLKHF_INJECTED/);
  assert.match(content, /LLMHF_INJECTED/);
  assert.match(content, /wParam\.ToInt64\(\)/);
  assert.match(content, /info\.pt\.x/);
  assert.match(content, /info\.pt\.y/);
  assert.match(content, /0x0200/);
  assert.match(content, /mouse_move/);
  assert.match(content, /\$form\.Bounds\.Contains\(\$point\)/);
  assert.match(content, /Start-AsyncInputPost/);
  assert.match(content, /PostAsync/);
  assert.match(content, /WyerpTaskboardGlobalControl/);
  assert.match(content, /DateTime\.UtcNow\.Ticks/);
  assert.doesNotMatch(content, /TickCount64/);
  assert.match(content, /overlay-startup-error\.log/);
  assert.match(content, /ErrorActionPreference = "Stop"/);
  assert.match(content, /\$Base\/\$\{Path\}\?token=/);
  assert.doesNotMatch(content, /\$Base\/\$Path\?token=/);
  assert.match(content, /System\.Net\.Http\.HttpClient/);
  assert.match(content, /GetStringAsync/);
  assert.match(content, /summary_poll_ui_failsafe/);
  assert.match(content, /状态服务响应超时，已撤销置顶并隐藏到托盘/);
  assert.doesNotMatch(content, /Update-Ui \(Invoke-ControlGet "summary"\)/);
  assert.doesNotMatch(content, /\$result = Invoke-ControlPost "input-event"/);
  assert.doesNotMatch(content, /input_event_report_failed[\s\S]{0,800}Show-Console/);
  assert.match(content, /\[System\.Windows\.Forms\.Application\]::Run\(\$form\)/);
  assert.doesNotMatch(content, /\$form\.ShowDialog\(\)/);
});


test("Chat Wake status overlay translates user-visible runtime values and uses active task truth", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const content = await fs.readFile(path.join(root, "browser-extension", "chat-wake", "global-overlay.js"), "utf8");
  assert.match(content, /activeTaskText\("开发AI"/);
  assert.match(content, /activeTaskText\("测试AI"/);
  assert.match(content, /后台工程任务执行中/);
  assert.match(content, /等待核对/);
  assert.match(content, /双通道一致/);
  assert.match(content, /状态不一致，需复核/);
  assert.match(content, /浏览器调度连接已过期/);
  assert.match(content, /系统检测到异常，请查看总日志/);
  assert.match(content, /离线 " \+ age \+ "秒/);
  assert.doesNotMatch(content, /"dispatcher stale"/);
  assert.doesNotMatch(content, /activity\.ui_state \|\| status\?\.chatgpt_health\?\.chatgpt_bridge\?\.ui_state \|\| "unknown"/);
  assert.doesNotMatch(content, /status\?\.channels\?\.cross_check \|\| "pending"/);
});

test("global control PowerShell script parses cleanly in Windows PowerShell", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const scriptPath = path.join(root, "scripts", "global-status-overlay.ps1");
  const escaped = scriptPath.replaceAll("'", "''");
  const command = `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count -gt 0){$errors | ForEach-Object { Write-Error ($_.Message + ' @ line ' + $_.Extent.StartLineNumber) }; exit 1}`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout || ""}${result.stderr || ""}`);
});

test("global control PowerShell script is UTF-8 BOM encoded for Windows PowerShell 5", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const bytes = await fs.readFile(path.join(root, "scripts", "global-status-overlay.ps1"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("global control VBS launcher uses STA for WinForms", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const launcher = await fs.readFile(path.join(root, "scripts", "start-global-status-overlay.vbs"), "utf8");
  assert.match(launcher, /powershell\.exe -NoProfile -STA -ExecutionPolicy Bypass/);
});

test("taskboard service start launches the global control console and installer no longer owns Windows logon startup", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const service = await fs.readFile(path.join(root, "cli", "service.mjs"), "utf8");
  const installer = await fs.readFile(path.join(root, "scripts", "install-global-status-overlay.ps1"), "utf8");
  assert.match(service, /function launchGlobalControl\(\)/);
  assert.match(service, /schtasks\.exe/);
  assert.match(service, /WyerpTaskboard-Global-Status/);
  assert.match(service, /launchGlobalControl\(\)/);
  assert.match(installer, /Register-ScheduledTask/);
  assert.match(installer, /Unregister-ScheduledTask/);
  assert.match(installer, /New-ScheduledTaskPrincipal/);
  assert.match(installer, /LogonType Interactive/);
  assert.match(installer, /startup_mode="with_taskboard"/);
  assert.match(installer, /legacy_startup_shortcut_removed/);
  assert.doesNotMatch(installer, /CreateShortcut\(/);
});
