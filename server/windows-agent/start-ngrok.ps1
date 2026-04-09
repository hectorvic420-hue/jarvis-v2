$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
Set-Location "C:\Users\ACER\Jarvis-V2\server\windows-agent"
ngrok http 3001 --log=stdout
Read-Host "Press Enter to exit"
