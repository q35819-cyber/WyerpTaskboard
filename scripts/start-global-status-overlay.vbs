Option Explicit
Dim fso, shell, scriptDir, rootDir, overlay, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
overlay = fso.BuildPath(scriptDir, "global-status-overlay.ps1")
cmd = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & overlay & Chr(34)
shell.Run cmd, 0, False
