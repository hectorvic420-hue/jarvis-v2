#!/usr/bin/env bash
# scripts/deploy-gcp.sh — Deploy a Google Cloud Run
# Uso: ./scripts/deploy-gcp.sh [--region us-central1] [--project my-project]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

REGION="${REGION:-us-central1}"
PROJECT_ID="${PROJECT_ID:-}"
IMAGE_NAME="jarvis-v2"
SERVICE_NAME="jarvis-v2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --project) PROJECT_ID="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(gcloud config get-value project 2>/dev/null)
fi

if [ -z "$PROJECT_ID" ]; then
  echo "Error: Define PROJECT_ID o ejecuta: gcloud config set project TU-PROJECT-ID"
  exit 1
fi

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }

info "Deploying to Google Cloud Run..."
info "Project: $PROJECT_ID"
info "Region: $REGION"
info "Service: $SERVICE_NAME"

# ── 1. Build ──────────────────────────────────────────────────────────────────
info "Building..."
npm run build

# ── 2. Build Docker image ─────────────────────────────────────────────────────
info "Building Docker image..."
docker build -t gcr.io/$PROJECT_ID/$IMAGE_NAME:$REGION .

# ── 3. Push to Container Registry ─────────────────────────────────────────────
info "Pushing to Container Registry..."
docker push gcr.io/$PROJECT_ID/$IMAGE_NAME:$REGION

# ── 4. Deploy to Cloud Run ────────────────────────────────────────────────────
info "Deploying to Cloud Run..."
gcloud run deploy $SERVICE_NAME \
  --image gcr.io/$PROJECT_ID/$IMAGE_NAME:$REGION \
  --platform managed \
  --region $REGION \
  --allow-unauthenticated \
  --port 8080 \
  --memory 1Gi \
  --cpu 1 \
  --min-instances 1 \
  --max-instances 10 \
  --set-env-vars NODE_ENV=production \
  --add-cloudsql-instances $PROJECT_ID:$REGION:jarvis-db

info ""
info "✅ Deploy completado!"
gcloud run services describe $SERVICE_NAME --region $REGION --format 'value(status.url)'
