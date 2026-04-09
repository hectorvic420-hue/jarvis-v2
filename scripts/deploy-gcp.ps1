# scripts/deploy-gcp.ps1 — Deploy a Google Cloud Run (Windows)
# Uso: .\scripts\deploy-gcp.ps1 [-Region "us-central1"] [-ProjectId "my-project"]

param(
    [string]$Region = $env:GCP_REGION ?? "us-central1",
    [string]$ProjectId = $env:GCP_PROJECT ?? "",
    [string]$ServiceName = "jarvis-v2",
    [string]$ImageName = "jarvis-v2"
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$M) Write-Host "==> $M" -ForegroundColor Cyan }
function Write-Info { param([string]$M) Write-Host "[INFO] $M" -ForegroundColor Green }
function Write-Err  { param([string]$M) Write-Host "[ERROR] $M" -ForegroundColor Red }

if (-not $ProjectId) {
    $ProjectId = gcloud config get-value project 2>$null
}
if (-not $ProjectId) {
    Write-Err "Define el proyecto: gcloud config set project TU-PROJECT-ID"
    Write-Err "O exporta: `$env:GCP_PROJECT='tu-project-id'"
    exit 1
}

$ProjectDir = Split-Path -Parent $PSScriptRoot
Push-Location $ProjectDir

Write-Step "Deploying to Google Cloud Run..."
Write-Info "Project: $ProjectId"
Write-Info "Region: $Region"
Write-Info "Service: $ServiceName"

# ── 1. Build ──────────────────────────────────────────────────────────────────
Write-Step "Building TypeScript..."
npm run build

# ── 2. Build Docker ───────────────────────────────────────────────────────────
Write-Step "Building Docker image..."
$ImageTag = "gcr.io/$ProjectId/$ImageName`:$Region"
docker build -t $ImageTag .

# ── 3. Push ───────────────────────────────────────────────────────────────────
Write-Step "Pushing to Container Registry..."
docker push $ImageTag

# ── 4. Deploy ─────────────────────────────────────────────────────────────────
Write-Step "Deploying to Cloud Run..."
gcloud run deploy $ServiceName `
    --image $ImageTag `
    --platform managed `
    --region $Region `
    --allow-unauthenticated `
    --port 8080 `
    --memory 1Gi `
    --cpu 1 `
    --min-instances 1 `
    --max-instances 10 `
    --set-env-vars "NODE_ENV=production"

$Url = gcloud run services describe $ServiceName --region $Region --format "value(status.url)"

Pop-Location

Write-Info ""
Write-Info "✅ Deploy completado!"
Write-Info "URL: $Url"
Write-Info ""
Write-Info "Verificar:"
Write-Info "  gcloud run services describe $ServiceName --region $Region"
Write-Info ""
Write-Info "Ver logs:"
Write-Info "  gcloud logs read 'resource.type=cloud_run_revision' --region $Region --limit 20"
