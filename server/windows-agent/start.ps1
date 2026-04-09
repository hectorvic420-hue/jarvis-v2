$env:PORT = "3001"
$env:WINDOWS_AGENT_SECRET = "jarvis-windows-secret"
Set-Location "C:\Users\ACER\Jarvis-V2\server\windows-agent"
$proc = Start-Process -FilePath "node_modules\.bin\tsx.cmd" -ArgumentList "index.ts" -WorkingDirectory "C:\Users\ACER\Jarvis-V2\server\windows-agent" -PassThru -WindowStyle Hidden
Start-Sleep 3
if ($proc.HasExited) {
    Write-Host "Process exited with code: $($proc.ExitCode)"
} else {
    Write-Host "Process running with PID: $($proc.Id)"
}
