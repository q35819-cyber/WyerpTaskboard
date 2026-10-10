param(
  [Parameter(Mandatory=$true)]
  [string]$PathValue
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) {
  throw "config file missing: $PathValue"
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $PathValue /inheritance:r /grant:r "${identity}:(F)" "*S-1-5-32-544:(F)" "*S-1-5-18:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "icacls failed with exit code $LASTEXITCODE"
}
[ordered]@{
  ok = $true
  path = (Resolve-Path -LiteralPath $PathValue).Path
  identity = $identity
} | ConvertTo-Json -Depth 3 -Compress