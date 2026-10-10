Option Explicit
Dim shell, executable, command, i, argument, exitCode

If WScript.Arguments.Count < 1 Then WScript.Quit 2

Set shell = CreateObject("WScript.Shell")
executable = WScript.Arguments(0)
command = Chr(34) & executable & Chr(34)

For i = 1 To WScript.Arguments.Count - 1
  argument = Replace(WScript.Arguments(i), Chr(34), Chr(34) & Chr(34))
  command = command & " " & Chr(34) & argument & Chr(34)
Next

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
