$ErrorActionPreference='SilentlyContinue'
$main = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -notmatch '--type=' } | Select-Object ProcessId,CommandLine
$hkcu = Get-ItemProperty -Path 'HKCU:\Software\Policies\Google\Chrome'
$hklm = Get-ItemProperty -Path 'HKLM:\Software\Policies\Google\Chrome'
[PSCustomObject]@{ Main=$main; HKCU=$hkcu; HKLM=$hklm } | ConvertTo-Json -Depth 6
