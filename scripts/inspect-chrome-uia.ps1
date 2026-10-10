$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$chrome = Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
[PSCustomObject]@{Pid=$chrome.Id;Title=$chrome.MainWindowTitle;Handle=$chrome.MainWindowHandle}
$root=[System.Windows.Automation.AutomationElement]::FromHandle($chrome.MainWindowHandle)
$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
$q=New-Object System.Collections.Queue;$q.Enqueue($root);$n=0
while($q.Count -gt 0 -and $n -lt 800){$el=$q.Dequeue();$n++;$name=$el.Current.Name;if($name){[PSCustomObject]@{N=$n;Name=$name;Type=$el.Current.ControlType.ProgrammaticName;Id=$el.Current.AutomationId}};$c=$walker.GetFirstChild($el);while($c){$q.Enqueue($c);$c=$walker.GetNextSibling($c)}}
