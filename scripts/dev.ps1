# scripts/dev.ps1 — Desarrollo local en Windows
# Uso: .\scripts\dev.ps1

param(
    [switch]$Build,
    [switch]$Install,
    [switch]$Port = $env:PORT ?? "8080"
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot

function Write-Step { param([string]$M) Write-Host "==> $M" -ForegroundColor Cyan }
function Write-Info { param([string]$M) Write-Host "[INFO] $M" -ForegroundColor Green }
function Write-Err  { param([string]$M) Write-Host "[ERROR] $M" -ForegroundColor Red }

Push-Location $ProjectDir

if ($Install) {
    Write-Step "Instalando dependencias..."
    npm install
}

if ($Build) {
    Write-Step "Compilando TypeScript..."
    npm run build
}

# Verificar .env
if (-not (Test-Path ".env")) {
    Write-Step "Creando .env desde .env.example..."
    Copy-Item ".env.example" ".env"
    Write-Info ".env creado. EDITALO antes de continuar:"
    Write-Info "  code .env"
    Write-Info "  # Agrega tus API keys: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, etc."
    Write-Host ""
    $open = Read-Host "Abrir .env en editor? (s/n)"
    if ($open -eq "s") { code .env }
    exit 0
}

Write-Step "Iniciando Jarvis v2 en puerto $Port..."
Write-Info "Presiona Ctrl+C para detener"
Write-Host ""

Pop-Location

npm run dev
