param(
  [string]$Url = "http://127.0.0.1:47831",
  [string]$DesktopPath = [Environment]::GetFolderPath("Desktop"),
  [string]$StartMenuProgramsPath = (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),
  [switch]$DesktopOnly,
  [switch]$StartMenuOnly
)

$ErrorActionPreference = "Stop"

if ($DesktopOnly -and $StartMenuOnly) { throw "DesktopOnly 与 StartMenuOnly 不能同时使用" }
if (-not [Uri]::IsWellFormedUriString($Url, [UriKind]::Absolute)) { throw "Url 必须是绝对地址" }

$shortcutName = "WyerpTaskboard任务看板.url"
$content = @"
[InternetShortcut]
URL=$Url
IconFile=C:\Windows\System32\SHELL32.dll
IconIndex=220
"@

function Write-Shortcut([string]$DirectoryPath) {
  if ([string]::IsNullOrWhiteSpace($DirectoryPath)) { return $null }
  [IO.Directory]::CreateDirectory($DirectoryPath) | Out-Null
  $target = Join-Path $DirectoryPath $shortcutName
  [IO.File]::WriteAllText($target, $content, [Text.UTF8Encoding]::new($false))
  return $target
}

$created = @()
if (-not $StartMenuOnly) { $target = Write-Shortcut $DesktopPath; if ($target) { $created += $target } }
if (-not $DesktopOnly) { $target = Write-Shortcut $StartMenuProgramsPath; if ($target) { $created += $target } }

[pscustomobject]@{ status = "created"; url = $Url; shortcuts = $created } | ConvertTo-Json -Depth 3