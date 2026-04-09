# scripts/deploy.ps1 — Deploy a servidor GCP desde Windows (PowerShell)
# Uso: .\scripts\deploy.ps1 -ServerHost "user@host" [-SkipBuild] [-SkipRestart]
# Requiere: rsync (via Git Bash o WSL), SSH

param(
    [string]$ServerHost = $env:SERVER_HOST,
    [string]$ServerUser = $env:SERVER_USER ?? "root",
    [string]$ServerPath = $env:SERVER_PATH ?? "/opt/jarvis",
    [switch]$SkipBuild,
    [switch]$SkipRestart
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Info { param([string]$Msg) Write-Host "[INFO] $Msg" -ForegroundColor Green }
function Write-Err  { param([string]$Msg) Write-Host "[ERROR] $Msg" -ForegroundColor Red }

if (-not $ServerHost) {
    Write-Err "Define ServerHost: .\scripts\deploy.ps1 -ServerHost 'user@host'"
    exit 1
}

Write-Step "Deploy a $ServerHost"
Write-Step "Ruta remota: $ServerPath"

$ProjectDir = Split-Path -Parent $PSScriptRoot

# ── 1. Build ──────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Info "Compilando TypeScript..."
    Push-Location $ProjectDir
    npm install
    npm run build
    Pop-Location
    Write-Info "Build OK"
} else {
    Write-Info "Build omitido"
}

# ── 2. Verificar directorio remoto ────────────────────────────────────────────
Write-Info "Verificando directorio remoto..."
ssh $ServerUser@$ServerHost "mkdir -p $ServerPath/{dist,data/db,landings}"

# ── 3. Rsync ──────────────────────────────────────────────────────────────────
Write-Info "Sincronizando archivos..."
# Excluye node_modules, .git, .env, archivos temporales
rsync -avz --progress `
    --exclude 'node_modules' `
    --exclude '.git' `
    --exclude '.env' `
    --exclude '.env.local' `
    --exclude 'dist/node_modules' `
    --exclude '*.log' `
    --exclude '.DS_Store' `
    --exclude 'landings/*.html' `
    --delete `
    "$ProjectDir/" "$ServerUser@$ServerHost`:$ServerPath/"

# ── 4. Dependencias remotas ───────────────────────────────────────────────────
Write-Info "Instalando dependencias en servidor..."
ssh $ServerUser@$ServerHost "cd $ServerPath && npm install --production"

# ── 5. Verificar .env ─────────────────────────────────────────────────────────
$envExists = ssh $ServerUser@$ServerHost "test -f $ServerPath/.env && echo 'yes' || echo 'no'"
if ($envExists -eq "no") {
    Write-Host "[WARN] .env no existe en servidor. Crea uno manualmente:" -ForegroundColor Yellow
    Write-Host "  ssh $ServerUser@$ServerHost 'nano $ServerPath/.env'" -ForegroundColor Yellow
}

# ── 6. Reiniciar ─────────────────────────────────────────────────────────────
if (-not $SkipRestart) {
    Write-Info "Reiniciando servicio..."
    ssh $ServerUser@$ServerHost @"
        cd $ServerPath
        if command -v pm2 &>/dev/null; then
            pm2 restart jarvis --update-env || pm2 start dist/index.js --name jarvis
            pm2 save
        elif [ -f /etc/systemd/system/jarvis.service ]; then
            sudo systemctl restart jarvis
        else
            pkill -f 'node.*dist/index.js' 2>/dev/null || true
            sleep 1
            nohup node dist/index.js >> /opt/jarvis/logs/jarvis.log 2>&1 &
            echo "PID: \$!"
        fi
"@
    Write-Info "Servicio reiniciado"
} else {
    Write-Info "Reinicio omitido"
}

Write-Info ""
Write-Info "✅ Deploy completado!"
Write-Info "Verificar: ssh $ServerUser@$ServerHost 'pm2 logs jarvis --lines 20'"
