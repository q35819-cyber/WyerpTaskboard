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
$count=0
while($queue.Count -gt 0 -and $count -lt 5000){
  $el=$queue.Dequeue(); $count++
  $name=$el.Current.Name; $type=$el.Current.ControlType.ProgrammaticName
  if($name -match 'Developer|开发|Load unpacked|加载已解压|扩展'){
    [PSCustomObject]@{Name=$name;Type=$type;AutomationId=$el.Current.AutomationId;Class=$el.Current.ClassName}
  }
  $child=$walker.GetFirstChild($el)
  while($child){$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
}
