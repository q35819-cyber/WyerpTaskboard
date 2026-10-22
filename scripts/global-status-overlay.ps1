param([int]$PollMilliseconds = 1500)
$ErrorActionPreference = "Stop"
$StartupLog = Join-Path (Split-Path -Parent $PSScriptRoot) "data\runtime\automation-control\overlay-startup-error.log"
try { Remove-Item -LiteralPath $StartupLog -Force -ErrorAction SilentlyContinue } catch { # LOG-IGNORE: stale startup-log cleanup is best-effort
}
trap {
  try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $StartupLog)) | Out-Null
    [IO.File]::WriteAllText($StartupLog, ($_ | Out-String), (New-Object Text.UTF8Encoding($true)))
  } catch { # LOG-IGNORE: last-resort startup logger cannot recurse
  }
  exit 1
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http

$hookSource = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class WyerpInputHooks {
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;
    private const uint LLKHF_INJECTED = 0x10;
    private const uint LLMHF_INJECTED = 0x00000001;

    private delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private static readonly HookProc KeyboardProc = KeyboardCallback;
    private static readonly HookProc MouseProc = MouseCallback;
    private static IntPtr KeyboardHook = IntPtr.Zero;
    private static IntPtr MouseHook = IntPtr.Zero;
    private static readonly ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
    private static string LastMouseDown = null;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    public static bool Start() {
        IntPtr module = IntPtr.Zero;
        try {
            using (Process process = Process.GetCurrentProcess()) {
                module = GetModuleHandle(process.MainModule.ModuleName);
            }
        } catch { /* LOG-IGNORE: GetModuleHandle fallback may still allow SetWindowsHookEx with zero module */ }
        if (KeyboardHook == IntPtr.Zero) KeyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardProc, module, 0);
        if (MouseHook == IntPtr.Zero) MouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, module, 0);
        return KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero;
    }

    public static void Stop() {
        if (KeyboardHook != IntPtr.Zero) { UnhookWindowsHookEx(KeyboardHook); KeyboardHook = IntPtr.Zero; }
        if (MouseHook != IntPtr.Zero) { UnhookWindowsHookEx(MouseHook); MouseHook = IntPtr.Zero; }
        Clear();
    }

    public static bool TryDequeue(out string value) { return Queue.TryDequeue(out value); }
    public static string ConsumeLastMouseDown() { return Interlocked.Exchange(ref LastMouseDown, null); }

    public static void Clear() {
        string ignored;
        while (Queue.TryDequeue(out ignored)) {}
    }

    private static IntPtr KeyboardCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            KBDLLHOOKSTRUCT info = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
            bool injected = (info.flags & LLKHF_INJECTED) != 0;
            Queue.Enqueue("keyboard|" + (injected ? "1" : "0") + "|" + DateTime.UtcNow.Ticks);
        }
        return CallNextHookEx(KeyboardHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            MSLLHOOKSTRUCT info = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
            bool injected = (info.flags & LLMHF_INJECTED) != 0;
            string record = "mouse|" + (injected ? "1" : "0") + "|" + DateTime.UtcNow.Ticks + "|" + wParam.ToInt64() + "|" + info.pt.x + "|" + info.pt.y;
            Queue.Enqueue(record);
            if (wParam.ToInt64() == 0x0201) Interlocked.Exchange(ref LastMouseDown, record);
        }
        return CallNextHookEx(MouseHook, nCode, wParam, lParam);
    }
}
'@
Add-Type -TypeDefinition $hookSource -Language CSharp

$Root = Split-Path -Parent $PSScriptRoot
$ControlTokenPath = Join-Path $Root "data\runtime\automation-control\control-token.json"
$Base = "http://127.0.0.1:47831/api/automation-control"
$OverlayRuntimeLog = Join-Path $Root "data\runtime\automation-control\overlay-runtime-fallback.jsonl"
$script:lastPollFailureAt = 0
$script:pollFailureCount = 0
$script:summaryTask = $null
$script:summaryStartedAt = 0
$script:nextSummaryPollAt = 0
$script:inputPostTask = $null
$script:inputPostContent = $null
$script:inputPostMeta = $null
$script:pendingInput = $null
$script:autoHiddenForUnresponsive = $false
$script:httpClient = [System.Net.Http.HttpClient]::new()
$script:httpClient.Timeout = [TimeSpan]::FromSeconds(3)

function Write-OverlayFallback([string]$Event, [string]$Message, $Details = @{}) {
  try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $OverlayRuntimeLog)) | Out-Null
    $payload = [ordered]@{
      at = [DateTime]::UtcNow.ToString("o")
      level = "error"
      component = "global-overlay"
      event = $Event
      error_message = $Message
      details = $Details
    }
    [IO.File]::AppendAllText(
      $OverlayRuntimeLog,
      (($payload | ConvertTo-Json -Compress -Depth 8) + [Environment]::NewLine),
      (New-Object Text.UTF8Encoding($false))
    )
  } catch {
    # Last-resort logger failure cannot safely recurse.
  }
}

$script:dragging = $false
$script:dragStart = $null
$script:lastApprovalId = $null
$script:latestState = $null
$script:ignoreHumanInputUntil = 0
$script:inputHookReady = $false
$script:pendingStartProofId = $null
$createdNew = $false
$script:singleInstanceMutex = [System.Threading.Mutex]::new($true, "Local\WyerpTaskboardGlobalControl", [ref]$createdNew)
if (-not $createdNew) { exit 0 }

function Read-ControlToken {
  try {
    $value = Get-Content -LiteralPath $ControlTokenPath -Raw -Encoding UTF8 | ConvertFrom-Json
    return [string]$value.token
  } catch {
    Write-OverlayFallback "control_token_read_failed" $_.Exception.Message @{ path = $ControlTokenPath }
    return ""
  }
}

function Invoke-ControlGet([string]$Path) {
  $token = Read-ControlToken
  if (-not $token) { throw "control token unavailable" }
  $url = "$Base/${Path}?token=$([Uri]::EscapeDataString($token))"
  return Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 3
}

function Invoke-ControlPost([string]$Path, $Body = @{}) {
  $token = Read-ControlToken
  if (-not $token) { throw "control token unavailable" }
  $url = "$Base/${Path}?token=$([Uri]::EscapeDataString($token))"
  $json = $Body | ConvertTo-Json -Depth 8
  return Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $json -TimeoutSec 2
}
function Write-SystemEvent([string]$Level, [string]$Event, [string]$ErrorMessage = "", $Details = @{}) {
  try {
    $token = Read-ControlToken
    if (-not $token) { throw "control token unavailable" }
    $url = "$Base/log-event?token=$([Uri]::EscapeDataString($token))"
    $payload = @{
      level = $Level
      event = $Event
      error_message = if ($ErrorMessage) { $ErrorMessage } else { $null }
      details = $Details
    }
    $json = $payload | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $json -TimeoutSec 3 | Out-Null
  } catch {
    Write-OverlayFallback "system_log_delivery_failed" $_.Exception.Message @{ original_event = $Event; original_level = $Level }
  }
}


function Request-ManualStartProof {
  $eventValue = [WyerpInputHooks]::ConsumeLastMouseDown()
  if (-not $eventValue) { return $null }
  $parts = [string]$eventValue -split "\|"
  if ($parts.Count -lt 6 -or $parts[0] -ne "mouse" -or [int64]$parts[3] -ne 0x0201) { return $null }
  $eventTicks = [int64]$parts[2]
  $ageMs = ([DateTime]::UtcNow.Ticks - $eventTicks) / [TimeSpan]::TicksPerMillisecond
  if ($ageMs -lt 0 -or $ageMs -gt 1200 -or $parts[1] -eq "1") { return $null }
  try {
    $proof = Invoke-ControlPost "manual-start-proof" @{ injected = $false; input_type = "mouse" }
    return [string]$proof.proof_id
  } catch {
    Write-SystemEvent "warning" "manual_start_proof_failed" $_.Exception.Message
    return $null
  }
}
function Begin-ControlInteraction {
  $script:ignoreHumanInputUntil = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 1500
  [WyerpInputHooks]::Clear()
}

function Get-ControlUrl([string]$Path) {
  $token = Read-ControlToken
  if (-not $token) { throw "control token unavailable" }
  return "$Base/${Path}?token=$([Uri]::EscapeDataString($token))"
}

function Start-AsyncSummaryPoll {
  if ($script:summaryTask) { return }
  try {
    $url = Get-ControlUrl "summary"
    $script:summaryStartedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $script:summaryTask = $script:httpClient.GetStringAsync($url)
  } catch {
    Write-OverlayFallback "summary_poll_start_failed" $_.Exception.Message @{}
    $script:summaryTask = $null
    $script:nextSummaryPollAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [Math]::Max(1000, $PollMilliseconds)
  }
}

function Complete-AsyncSummaryPoll {
  if (-not $script:summaryTask) { return }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (-not $script:summaryTask.IsCompleted) {
    if (($now - $script:summaryStartedAt) -ge 4500 -and -not $script:autoHiddenForUnresponsive) {
      $script:autoHiddenForUnresponsive = $true
      $form.TopMost = $false
      $form.Hide()
      $notify.BalloonTipTitle = "Wyerp 控制台已自动隐藏"
      $notify.BalloonTipText = "状态服务响应超时，已撤销置顶并隐藏到托盘，避免挡住操作。"
      $notify.ShowBalloonTip(5000)
      Write-OverlayFallback "summary_poll_ui_failsafe" "summary poll exceeded 4500ms" @{ elapsed_ms = ($now - $script:summaryStartedAt) }
    }
    return
  }
  try {
    $json = $script:summaryTask.GetAwaiter().GetResult()
    $summary = $json | ConvertFrom-Json
    $script:pollFailureCount = 0
    Update-Ui $summary
  } catch {
    $script:pollFailureCount += 1
    $nowPollError = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if (($nowPollError - $script:lastPollFailureAt) -ge 30000) {
      $script:lastPollFailureAt = $nowPollError
      Write-OverlayFallback "summary_poll_failed" $_.Exception.Message @{ failure_count = $script:pollFailureCount }
    }
    $title.Text = "Wyerp 总控制台 - 服务离线"
    $title.ForeColor = [System.Drawing.Color]::Salmon
    $status.Text = "Cannot reach automation control hub."
    if ($script:pollFailureCount -ge 2 -and -not $script:autoHiddenForUnresponsive) {
      $script:autoHiddenForUnresponsive = $true
      $form.TopMost = $false
      $form.Hide()
      $notify.BalloonTipTitle = "Wyerp 控制台已自动隐藏"
      $notify.BalloonTipText = "连续状态轮询失败，已隐藏到托盘；后台任务不受影响。"
      $notify.ShowBalloonTip(5000)
    }
  } finally {
    $script:summaryTask = $null
    $script:nextSummaryPollAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + [Math]::Max(1000, $PollMilliseconds)
  }
}

function Start-AsyncInputPost($InputInfo) {
  if ($script:inputPostTask -or -not $InputInfo) { return $false }
  try {
    $url = Get-ControlUrl "input-event"
    $json = @{
      injected = [bool]$InputInfo.injected
      input_type = [string]$InputInfo.input_type
    } | ConvertTo-Json -Compress
    $script:inputPostContent = [System.Net.Http.StringContent]::new($json, [System.Text.Encoding]::UTF8, "application/json")
    $script:inputPostMeta = $InputInfo
    $script:inputPostTask = $script:httpClient.PostAsync($url, $script:inputPostContent)
    return $true
  } catch {
    Write-OverlayFallback "input_event_post_start_failed" $_.Exception.Message @{ input_type = [string]$InputInfo.input_type; injected = [bool]$InputInfo.injected }
    $script:inputPostTask = $null
    if ($script:inputPostContent) { $script:inputPostContent.Dispose(); $script:inputPostContent = $null }
    return $false
  }
}

function Complete-AsyncInputPost {
  if (-not $script:inputPostTask -or -not $script:inputPostTask.IsCompleted) { return }
  try {
    $response = $script:inputPostTask.GetAwaiter().GetResult()
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { throw "input-event HTTP $([int]$response.StatusCode)" }
    $result = $body | ConvertFrom-Json
    if ($result.takeover) {
      $notify.BalloonTipTitle = "Wyerp 已暂停交互自动化"
      $notify.BalloonTipText = if ($result.classification -eq "human") { "检测到人工操作：已暂停鼠标/键盘/GPT交互并取消无人值守；后台代码和测试继续。" } else { "检测到来源不明的注入输入：已暂停交互自动化并取消无人值守；后台代码和测试继续。" }
      $notify.ShowBalloonTip(5000)
      $script:nextSummaryPollAt = 0
    }
    $response.Dispose()
  } catch {
    Write-OverlayFallback "input_event_report_failed" $_.Exception.Message @{
      input_type = [string]$script:inputPostMeta.input_type
      injected = [bool]$script:inputPostMeta.injected
    }
  } finally {
    $script:inputPostTask = $null
    $script:inputPostMeta = $null
    if ($script:inputPostContent) { $script:inputPostContent.Dispose(); $script:inputPostContent = $null }
  }
  if ($script:pendingInput) {
    $next = $script:pendingInput
    $script:pendingInput = $null
    [void](Start-AsyncInputPost $next)
  }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "Wyerp 总控制台"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Width = 500
$form.Height = 375
$form.BackColor = [System.Drawing.Color]::FromArgb(24,24,28)
$form.Opacity = 0.97
$form.MinimumSize = New-Object System.Drawing.Size(500,375)

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $area.Right - $form.Width - 12
$form.Top = $area.Top + 12

$titlePanel = New-Object System.Windows.Forms.Panel
$titlePanel.SetBounds(0,0,500,38)
$titlePanel.BackColor = [System.Drawing.Color]::FromArgb(36,36,42)
$form.Controls.Add($titlePanel)

$title = New-Object System.Windows.Forms.Label
$title.AutoSize = $false
$title.SetBounds(12,8,390,24)
$title.Font = New-Object System.Drawing.Font("Segoe UI",11,[System.Drawing.FontStyle]::Bold)
$title.ForeColor = [System.Drawing.Color]::White
$title.Text = "Wyerp 总控制台"
$titlePanel.Controls.Add($title)

$minButton = New-Object System.Windows.Forms.Button
$minButton.Text = "—"
$minButton.SetBounds(420,5,32,28)
$minButton.FlatStyle = "Flat"
$minButton.ForeColor = [System.Drawing.Color]::Gainsboro
$minButton.BackColor = [System.Drawing.Color]::FromArgb(50,50,56)
$titlePanel.Controls.Add($minButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = "×"
$closeButton.SetBounds(456,5,32,28)
$closeButton.FlatStyle = "Flat"
$closeButton.ForeColor = [System.Drawing.Color]::Gainsboro
$closeButton.BackColor = [System.Drawing.Color]::FromArgb(70,40,40)
$titlePanel.Controls.Add($closeButton)

$status = New-Object System.Windows.Forms.Label
$status.AutoSize = $false
$status.SetBounds(14,48,470,88)
$status.Font = New-Object System.Drawing.Font("Microsoft YaHei UI",10)
$status.ForeColor = [System.Drawing.Color]::White
$status.Text = "正在连接..."
$form.Controls.Add($status)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = "启动"
$startButton.SetBounds(14,145,90,34)
$startButton.FlatStyle = "Flat"
$startButton.BackColor = [System.Drawing.Color]::FromArgb(62,72,92)
$startButton.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($startButton)

$pauseButton = New-Object System.Windows.Forms.Button
$pauseButton.Text = "暂停"
$pauseButton.SetBounds(112,145,90,34)
$pauseButton.FlatStyle = "Flat"
$pauseButton.BackColor = [System.Drawing.Color]::FromArgb(72,62,62)
$pauseButton.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($pauseButton)

$unattended = New-Object System.Windows.Forms.CheckBox
$unattended.Text = "无人值守"
$unattended.SetBounds(220,151,210,24)
$unattended.ForeColor = [System.Drawing.Color]::White
$unattended.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($unattended)

$approvalBox = New-Object System.Windows.Forms.GroupBox
$approvalBox.Text = "待确认 ChatGPT 操作"
$approvalBox.SetBounds(14,190,470,120)
$approvalBox.ForeColor = [System.Drawing.Color]::White
$form.Controls.Add($approvalBox)

$approvalText = New-Object System.Windows.Forms.Label
$approvalText.AutoSize = $false
$approvalText.SetBounds(10,20,330,88)
$approvalText.Font = New-Object System.Drawing.Font("Microsoft YaHei UI",9.5)
$approvalText.ForeColor = [System.Drawing.Color]::White
$approvalText.Text = "当前没有待确认操作。"
$approvalBox.Controls.Add($approvalText)

$allowButton = New-Object System.Windows.Forms.Button
$allowButton.Text = "允许"
$allowButton.SetBounds(350,28,100,32)
$allowButton.Enabled = $false
$approvalBox.Controls.Add($allowButton)

$rejectButton = New-Object System.Windows.Forms.Button
$rejectButton.Text = "拒绝"
$rejectButton.SetBounds(350,68,100,32)
$rejectButton.Enabled = $false
$approvalBox.Controls.Add($rejectButton)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Wyerp 总控制台"
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$showItem = $menu.Items.Add("显示控制台")
$startItem = $menu.Items.Add("启动自动化")
$pauseItem = $menu.Items.Add("暂停自动化")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("退出控制台")
$notify.ContextMenuStrip = $menu

function Show-Console {
  $form.Show()
  $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
  $form.TopMost = $true
  $script:autoHiddenForUnresponsive = $false
  $form.Activate()
}

function Get-ActionText($Value) {
  switch ([string]$Value) {
    "Click" { return "点击" }
    "Move" { return "移动鼠标" }
    "Type" { return "输入" }
    "Shortcut" { return "快捷键" }
    "App" { return "应用操作" }
    "SmokeCursorControl" { return "光标检测" }
    "chatgpt_navigate_session" { return "切换ChatGPT会话" }
    "retry" { return "重试" }
    "continue" { return "继续" }
    "retry_or_continue" { return "重试或继续" }
    "stop_and_continue" { return "停止并继续" }
    default { return $(if ($Value) { "系统操作（$Value）" } else { "—" }) }
  }
}
function Get-ResultText($Value) {
  switch ([string]$Value) {
    "success" { return "成功" }
    "succeeded" { return "成功" }
    "failed" { return "失败" }
    "safety_blocked" { return "安全阻止" }
    "user_takeover" { return "人工接管" }
    "allowed" { return "已允许" }
    "rejected" { return "已拒绝" }
    "cancelled" { return "已取消" }
    "unknown" { return "结果未知" }
    default { return $(if ($Value) { "系统结果（技术值：$Value）" } else { "—" }) }
  }
}
function Get-SourceText($Value) {
  switch ([string]$Value) {
    "windows-mcp" { return "Windows MCP" }
    "chatgpt-mcp-executor" { return "ChatGPT MCP执行器" }
    "browser" { return "浏览器监控" }
    "human_input" { return "人工输入" }
    "platform_safety" { return "平台安全门禁" }
    default { return $(if ($Value) { "系统来源（$Value）" } else { "—" }) }
  }
}
function Get-AnomalyText($Value) {
  switch ([string]$Value) {
    "candidate_unleased_stalled" { return "候选任务长时间未领取" }
    "extension_runtime_outdated" { return "浏览器扩展版本过旧" }
    "extension_contract_mismatch" { return "浏览器扩展版本配置不一致" }
    "processing_delayed" { return "ChatGPT 处理延迟" }
    "execution_error" { return "ChatGPT 执行错误" }
    "generating_stalled" { return "ChatGPT 生成疑似停滞" }
    "dispatcher_stale" { return "浏览器调度连接已过期" }
    "approval_required" { return "等待用户授权" }
    "version_contract_not_current" { return "运行组件版本不一致" }
    default { return $(if ($Value) { "系统检测到异常（技术码：$Value）" } else { "无" }) }
  }
}
function Get-ActiveTaskText($RoleName, $Items) {
  $list = @($Items | Where-Object { $_ })
  if ($list.Count -eq 0) { return ($RoleName + "：空闲") }
  $parts = @($list | Select-Object -First 3 | ForEach-Object {
    $name = if ($_.name) { [string]$_.name } else { [string]$_.task_id }
    "$($_.task_id) / $name"
  })
  return ($RoleName + "：" + ($parts -join "；"))
}
function Update-Ui($summary) {
  $control = $summary.control
  $runtime = $summary.runtime
  $script:latestState = $control

  $runText = if ($control.user_takeover) { "交互已暂停" } elseif ($control.running) { "运行中" } else { "已暂停" }
  $modeText = if ($control.approval_mode -eq "unattended") { "无人值守" } else { "人工审批" }
  $developerTasks = @($(if ($runtime.active_tasks) { $runtime.active_tasks.developer } else { @() }))
  $testTasks = @($(if ($runtime.active_tasks) { $runtime.active_tasks.test } else { @() }))
  $developerTaskText = Get-ActiveTaskText "开发AI" $developerTasks
  $testTaskText = Get-ActiveTaskText "测试AI" $testTasks
  $hasEngineeringTask = ($developerTasks.Count + $testTasks.Count) -gt 0
  $anomalies = @($runtime.anomalies)
  $anomalyText = if ($anomalies.Count -gt 0) { (($anomalies | Select-Object -First 3 | ForEach-Object { Get-AnomalyText $_ }) -join "；") } else { "无" }
  $hookText = if ($script:inputHookReady) { "正常" } else { "异常" }
  $flowText = if ($control.in_flight_action) {
    "执行中：$(Get-ActionText $control.in_flight_action.kind)"
  } elseif ($anomalies.Count -gt 0) {
    "异常待处理：$anomalyText；下一步：查看异常详情并按提示处理"
  } elseif ($hasEngineeringTask) {
    "后台工程任务执行中"
  } elseif ($control.last_completed_action) {
    "最近结果：$(Get-ResultText $control.last_completed_action.result) / $(Get-SourceText $control.last_completed_action.error_source)"
  } else {
    "空闲"
  }
  $status.Text = "状态：$runText / $modeText`r`n$developerTaskText`r`n$testTaskText`r`n动作：$flowText`r`n输入检测：$hookText`r`n异常：$anomalyText`r`n更新时间：$($runtime.captured_at)"

  $pending = $control.pending_action
  $titlePanel.BackColor = [System.Drawing.Color]::FromArgb(36,36,42)
  $form.Opacity = 0.97
  if ($control.user_takeover) {
    $title.Text = "Wyerp 总控制台 - 人工接管 / 交互已暂停"
    $title.ForeColor = [System.Drawing.Color]::Orange
  } elseif ($pending) {
    $title.Text = "Wyerp 总控制台 - 等待授权"
    $title.ForeColor = [System.Drawing.Color]::White
    $titlePanel.BackColor = [System.Drawing.Color]::FromArgb(145,70,10)
    $form.Opacity = 1.0
  } elseif (-not $control.running) {
    $title.Text = "Wyerp 总控制台 - 已暂停"
    $title.ForeColor = [System.Drawing.Color]::Khaki
  } elseif ($anomalies.Count -gt 0) {
    $title.Text = "Wyerp 总控制台 - 异常"
    $title.ForeColor = [System.Drawing.Color]::Salmon
  } else {
    $title.Text = "Wyerp 总控制台 - 运行中"
    $title.ForeColor = [System.Drawing.Color]::LightGreen
  }

  $unattended.Enabled = [bool]$control.unattended_available
  $unattended.Checked = [bool]$control.unattended
  $unattended.Text = if ($control.unattended_available) { "无人值守" } else { "无人值守 (测试未通过)" }
  $startButton.Enabled = (-not [bool]$control.running) -or [bool]$control.user_takeover
  $pauseButton.Enabled = [bool]$control.running

  if ($pending) {
    $approvalBox.Text = "⚠ 待确认 ChatGPT 操作 — 请允许或拒绝"
    $approvalBox.BackColor = [System.Drawing.Color]::FromArgb(82,46,18)
    $approvalText.ForeColor = [System.Drawing.Color]::White
    $allowButton.BackColor = [System.Drawing.Color]::FromArgb(42,92,42)
    $allowButton.ForeColor = [System.Drawing.Color]::White
    $rejectButton.BackColor = [System.Drawing.Color]::FromArgb(115,48,48)
    $rejectButton.ForeColor = [System.Drawing.Color]::White
    $approvalText.Text = "来源：$(Get-SourceText $pending.source)`r`n动作：$(Get-ActionText $pending.kind)`r`n说明：$($pending.summary)"
    $allowButton.Enabled = $true
    $rejectButton.Enabled = $true
    if ($script:lastApprovalId -ne $pending.id) {
      $script:lastApprovalId = $pending.id
      $notify.BalloonTipTitle = "Wyerp 等待操作确认"
      $notify.BalloonTipText = [string]$pending.summary
      $notify.ShowBalloonTip(5000)
      Show-Console
      [System.Media.SystemSounds]::Exclamation.Play()
    }
  } else {
    $approvalBox.Text = "待确认 ChatGPT 操作"
    $approvalBox.BackColor = $form.BackColor
    $approvalText.ForeColor = [System.Drawing.Color]::Gainsboro
    $allowButton.BackColor = [System.Drawing.SystemColors]::Control
    $allowButton.ForeColor = [System.Drawing.SystemColors]::ControlText
    $rejectButton.BackColor = [System.Drawing.SystemColors]::Control
    $rejectButton.ForeColor = [System.Drawing.SystemColors]::ControlText
    $approvalText.Text = "当前没有待确认操作。"
    $allowButton.Enabled = $false
    $rejectButton.Enabled = $false
    $script:lastApprovalId = $null
  }
}

$startButton.Add_MouseDown({ $script:pendingStartProofId = Request-ManualStartProof; Begin-ControlInteraction })
$pauseButton.Add_MouseDown({ Begin-ControlInteraction })
$unattended.Add_MouseDown({ Begin-ControlInteraction })
$allowButton.Add_MouseDown({ Begin-ControlInteraction })
$rejectButton.Add_MouseDown({ Begin-ControlInteraction })
$startItem.Add_MouseDown({ $script:pendingStartProofId = Request-ManualStartProof; Begin-ControlInteraction })
$pauseItem.Add_MouseDown({ Begin-ControlInteraction })

$startButton.Add_Click({
  try { Update-Ui (Invoke-ControlPost "start" @{ proof_id = $script:pendingStartProofId }) } catch { Write-SystemEvent "error" "start_button_failed" $_.Exception.Message; [System.Windows.Forms.MessageBox]::Show($form, ("启动失败：" + $_.Exception.Message), "Wyerp 总控制台", "OK", "Warning") | Out-Null } finally { $script:pendingStartProofId = $null }
})
$pauseButton.Add_Click({
  try { Update-Ui (Invoke-ControlPost "pause" @{ reason = "user_pause_from_global_console" }) } catch { Write-SystemEvent "error" "pause_button_failed" $_.Exception.Message }
})
$unattended.Add_Click({
  try {
    $target = [bool]$unattended.Checked
    $result = Invoke-ControlPost "unattended" @{ enabled = $target }
    Update-Ui $result
  } catch {
    Write-SystemEvent "error" "unattended_toggle_failed" $_.Exception.Message @{ requested = [bool]$unattended.Checked }
    [System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, "无人值守", "OK", "Warning") | Out-Null
    $unattended.Checked = [bool]$script:latestState.unattended
  }
})
$allowButton.Add_Click({
  try {
    $id = [string]$script:latestState.pending_action.id
    if ($id) { Update-Ui (Invoke-ControlPost "decision" @{ approval_id = $id; decision = "allow" }) }
  } catch { Write-SystemEvent "error" "approval_allow_failed" $_.Exception.Message }
})
$rejectButton.Add_Click({
  try {
    $id = [string]$script:latestState.pending_action.id
    if ($id) { Update-Ui (Invoke-ControlPost "decision" @{ approval_id = $id; decision = "reject" }) }
  } catch { Write-SystemEvent "error" "approval_reject_failed" $_.Exception.Message }
})
$minButton.Add_Click({ $form.Hide() })
$closeButton.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show($form, "退出控制台前会先暂停自动化。是否继续？", "Wyerp", "YesNo", "Warning")
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    try { Invoke-ControlPost "pause" @{ reason = "global_console_exit" } | Out-Null } catch { Write-SystemEvent "error" "exit_pause_failed" $_.Exception.Message }
    $notify.Visible = $false
    $form.Close()
  }
})
$showItem.Add_Click({ Show-Console })
$startItem.Add_Click({ try { Update-Ui (Invoke-ControlPost "start" @{ proof_id = $script:pendingStartProofId }) } catch { Write-SystemEvent "error" "tray_start_failed" $_.Exception.Message; $notify.BalloonTipTitle = "无法启动自动化"; $notify.BalloonTipText = $_.Exception.Message; $notify.ShowBalloonTip(4000) } finally { $script:pendingStartProofId = $null } })
$pauseItem.Add_Click({ try { Update-Ui (Invoke-ControlPost "pause" @{ reason = "user_pause_from_tray" }) } catch { Write-SystemEvent "error" "tray_pause_failed" $_.Exception.Message } })
$exitItem.Add_Click({ $closeButton.PerformClick() })
$notify.Add_DoubleClick({ Show-Console })

$titlePanel.Add_MouseDown({
  param($sender,$e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragging = $true
    $script:dragStart = New-Object System.Drawing.Point($e.X,$e.Y)
  }
})
$titlePanel.Add_MouseMove({
  param($sender,$e)
  if ($script:dragging -and $script:dragStart) {
    $screen = $form.PointToScreen((New-Object System.Drawing.Point($e.X,$e.Y)))
    $form.Location = New-Object System.Drawing.Point(($screen.X-$script:dragStart.X),($screen.Y-$script:dragStart.Y))
  }
})
$titlePanel.Add_MouseUp({ $script:dragging = $false })

$script:inputHookReady = [WyerpInputHooks]::Start()
if (-not $script:inputHookReady) { Write-SystemEvent "error" "input_hook_start_failed" "low-level input hook failed to start" }
$inputTimer = New-Object System.Windows.Forms.Timer
$inputTimer.Interval = 200
$inputTimer.Add_Tick({
  Complete-AsyncInputPost
  $selectedInput = $null
  $drained = 0
  $eventValue = $null
  while ([WyerpInputHooks]::TryDequeue([ref]$eventValue)) {
    $drained += 1
    if ($drained -gt 200) { break }
    if (-not $script:latestState -or -not [bool]$script:latestState.running -or [bool]$script:latestState.user_takeover) { continue }
    $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($nowMs -lt $script:ignoreHumanInputUntil) { continue }
    $parts = [string]$eventValue -split "\|"
    if ($parts.Count -lt 2) { continue }
    $inputType = [string]$parts[0]
    $injected = $parts[1] -eq "1"
    $reportedInputType = $inputType
    if ($inputType -eq "mouse" -and $parts.Count -ge 6) {
      $mouseMessage = [int64]$parts[3]
      $mouseX = [int]$parts[4]
      $mouseY = [int]$parts[5]
      $point = New-Object System.Drawing.Point($mouseX,$mouseY)
      if ($form.Visible -and $form.Bounds.Contains($point)) { continue }
      if ($mouseMessage -eq 0x0200) { $reportedInputType = "mouse_move" }
    }
    $candidateInput = [pscustomobject]@{ injected = $injected; input_type = $reportedInputType }
    if (-not $injected) { $selectedInput = $candidateInput; break }
    $selectedInput = $candidateInput
  }
  if ($selectedInput) {
    if ($script:inputPostTask) { $script:pendingInput = $selectedInput }
    else { [void](Start-AsyncInputPost $selectedInput) }
  }
})
$inputTimer.Start()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
  Complete-AsyncSummaryPoll
  Complete-AsyncInputPost
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if (-not $script:summaryTask -and $now -ge $script:nextSummaryPollAt) { Start-AsyncSummaryPoll }
})
$form.Add_FormClosed({
  $timer.Stop()
  $inputTimer.Stop()
  [WyerpInputHooks]::Stop()
  try { $script:httpClient.CancelPendingRequests() } catch { # LOG-IGNORE: shutdown cleanup only
  }
  try { $script:httpClient.Dispose() } catch { # LOG-IGNORE: shutdown cleanup only
  }
  $notify.Visible = $false
  $notify.Dispose()
  try { $script:singleInstanceMutex.ReleaseMutex() } catch { # LOG-IGNORE: shutdown cleanup only
  }
  try { $script:singleInstanceMutex.Dispose() } catch { # LOG-IGNORE: shutdown cleanup only
  }
})
$timer.Start()
$script:nextSummaryPollAt = 0
[System.Windows.Forms.Application]::Run($form)
