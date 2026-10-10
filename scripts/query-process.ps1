param(
  [Parameter(Mandatory=$true)][int]$PidValue
)
$ErrorActionPreference = "Stop"
Add-Type @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CommandLineNative {
    [DllImport("shell32.dll", SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(
        [MarshalAs(UnmanagedType.LPWStr)] string lpCmdLine,
        out int pNumArgs
    );
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);
    public static string[] Split(string commandLine) {
        if (commandLine == null) return Array.Empty<string>();
        int argc;
        IntPtr argv = CommandLineToArgvW(commandLine, out argc);
        if (argv == IntPtr.Zero) throw new Win32Exception();
        try {
            var result = new string[argc];
            for (int i = 0; i < argc; i++) {
                IntPtr p = Marshal.ReadIntPtr(argv, i * IntPtr.Size);
                result[i] = Marshal.PtrToStringUni(p);
            }
            return result;
        } finally {
            LocalFree(argv);
        }
    }
}
"@
$proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PidValue)
if (-not $proc) {
  [pscustomobject]@{ exists=$false; pid=$PidValue } | ConvertTo-Json -Compress
  exit 0
}
$argv = [CommandLineNative]::Split([string]$proc.CommandLine)
[pscustomobject]@{
  exists = $true
  pid = [int]$proc.ProcessId
  executablePath = [string]$proc.ExecutablePath
  commandLine = [string]$proc.CommandLine
  argv = @($argv)
} | ConvertTo-Json -Compress -Depth 4
