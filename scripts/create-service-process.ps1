param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$EntryPath,
  [Parameter(Mandatory=$true)][string]$RootDir,
  [Parameter(Mandatory=$true)][string]$HostValue,
  [Parameter(Mandatory=$true)][int]$PortValue,
  [Parameter(Mandatory=$true)][string]$InstanceToken,
  [Parameter(Mandatory=$true)][string]$InstanceFile
)
$ErrorActionPreference = 'Stop'
function Quote-Arg([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}
$argsList = @(
  $EntryPath,
  '--root', $RootDir,
  '--host', $HostValue,
  '--port', [string]$PortValue,
  '--instance-token', $InstanceToken,
  '--instance-file', $InstanceFile
)
$commandLine = (Quote-Arg $NodeExe) + ' ' + (($argsList | ForEach-Object { Quote-Arg ([string]$_) }) -join ' ')
$startupClass = [wmiclass]'Win32_ProcessStartup'
$startup = $startupClass.CreateInstance()
$startup.ShowWindow = 0
$processClass = [wmiclass]'Win32_Process'
$result = $processClass.Create($commandLine, $RootDir, $startup)
if ([int]$result.ReturnValue -ne 0 -or -not $result.ProcessId) {
  throw "Win32_Process.Create failed: returnValue=$($result.ReturnValue)"
}
@{ pid = [int]$result.ProcessId; returnValue = [int]$result.ReturnValue } | ConvertTo-Json -Compress
