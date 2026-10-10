$ErrorActionPreference='Stop'
$ws = New-Object -ComObject WScript.Shell
$chrome = Get-Process chrome | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
$null=$ws.AppActivate($chrome.Id)
Start-Sleep -Milliseconds 300
Set-Clipboard -Value 'chrome://extensions/'
$ws.SendKeys('^t')
Start-Sleep -Milliseconds 250
$ws.SendKeys('^l')
$ws.SendKeys('^v')
$ws.SendKeys('{ENTER}')
Start-Sleep -Seconds 2
(Get-Process -Id $chrome.Id).MainWindowTitle
