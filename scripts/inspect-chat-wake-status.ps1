$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$ws = New-Object -ComObject WScript.Shell
$chrome = Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $chrome) { throw 'No Chrome main window' }
$null = $ws.AppActivate($chrome.Id)
Start-Sleep -Milliseconds 300
$ws.SendKeys('^t')
Start-Sleep -Milliseconds 200
$ws.SendKeys('chrome://extensions')
$ws.SendKeys('{ENTER}')
Start-Sleep -Seconds 2
$root = [System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$queue = New-Object System.Collections.Queue
$queue.Enqueue($root)
$out=@()
$count=0
while($queue.Count -gt 0 -and $count -lt 8000){
  $el=$queue.Dequeue(); $count++
  $name=[string]$el.Current.Name
  if($name -match 'WyerpTaskboard|0\.4\.2|Service Worker|Errors|Inspect views|Invalid|background\.js'){
    $out += [PSCustomObject]@{Name=$name;Type=$el.Current.ControlType.ProgrammaticName;AutomationId=$el.Current.AutomationId}
  }
  $child=$walker.GetFirstChild($el)
  while($child){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
}
$out | ConvertTo-Json -Depth 3