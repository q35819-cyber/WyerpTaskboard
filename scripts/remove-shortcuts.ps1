param(
  [string]$DesktopPath = [Environment]::GetFolderPath("Desktop"),
  [string]$StartMenuProgramsPath = (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  [switch]$DesktopOnly,
  [switch]$StartMenuOnly
)

$ErrorActionPreference = "Stop"
if ($DesktopOnly -and $StartMenuOnly) { throw "DesktopOnly 与 StartMenuOnly 不能同时使用" }
$shortcutName = "WyerpTaskboard任务看板.url"
$removed = @()

function Remove-Shortcut([string]$DirectoryPath) {
  if ([string]::IsNullOrWhiteSpace($DirectoryPath)) { return }
  $target = Join-Path $DirectoryPath $shortcutName
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force; $script:removed += $target }
}

if (-not $StartMenuOnly) { Remove-Shortcut $DesktopPath }
if (-not $DesktopOnly) { Remove-Shortcut $StartMenuProgramsPath }

[pscustomobject]@{ status = "removed"; shortcuts = $removed } | ConvertTo-Json -Depth 3