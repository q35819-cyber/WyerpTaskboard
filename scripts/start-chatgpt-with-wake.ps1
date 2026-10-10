$ErrorActionPreference = 'Stop'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$extension = 'D:\WyerpTaskboard\browser-extension\chat-wake'
if (-not (Test-Path $chrome)) { throw "Chrome not found: $chrome" }
if (-not (Test-Path (Join-Path $extension 'manifest.json'))) { throw "Wake extension missing: $extension" }
Start-Process -FilePath $chrome -ArgumentList @("--load-extension=$extension","https://chatgpt.com/")
