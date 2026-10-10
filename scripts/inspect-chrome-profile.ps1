$items = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
  $cmd = [string]$_.CommandLine
  [pscustomobject]@{
    Pid = $_.ProcessId
    UserDataDir = if ($cmd -match '--user-data-dir=(?:"([^"]+)"|([^ ]+))') { if($matches[1]){$matches[1]}else{$matches[2]} } else { $null }
    ProfileDirectory = if ($cmd -match '--profile-directory=(?:"([^"]+)"|([^ ]+))') { if($matches[1]){$matches[1]}else{$matches[2]} } else { $null }
    LoadExtension = if ($cmd -match '--load-extension=(?:"([^"]+)"|([^ ]+))') { if($matches[1]){$matches[1]}else{$matches[2]} } else { $null }
  }
}
$items | Where-Object { $_.UserDataDir -or $_.ProfileDirectory -or $_.LoadExtension } | ConvertTo-Json -Depth 3