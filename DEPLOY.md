# JARVIS v2 — Comandos Rápidos de Deployment

## 🖥️ Desarrollo Local (Windows)

```powershell
# Primera vez
.\scripts\dev.ps1 -Install

# Iniciar desarrollo
.\scripts\dev.ps1

# Solo compilar
.\scripts\dev.ps1 -Build
```

## ☁️ Deploy a Google Cloud Run

### Requisitos previos
```powershell
# 1. Instalar Google Cloud SDK
# https://cloud.google.com/sdk/docs/install?hl=es

# 2. Autenticarse
gcloud auth login

# 3. Configurar proyecto
gcloud config set project TU-PROJECT-ID

# 4. Habilitar Cloud Run API
gcloud services enable run.googleapis.com
```

### Deploy (PowerShell)
```powershell
$env:GCP_PROJECT = "tu-project-id"
$env:GCP_REGION = "us-central1"

.\scripts\deploy-gcp.ps1
```

### Deploy (Bash)
```bash
export GCP_PROJECT="tu-project-id"
export GCP_REGION="us-central1"
chmod +x scripts/deploy-gcp.sh
./scripts/deploy-gcp.sh
```

### Cloud Build (CI/CD automático)
```bash
# Crear trigger en Cloud Console:
# Repository: GitHub
# Branch: main
# cloudbuild.yaml como build config

# O manual:
gcloud builds submit --config=cloudbuild.yaml --region=us-central1
```

## 🌐 Deploy a Servidor (VPS/SSH)

```bash
chmod +x scripts/deploy.sh
export SERVER_HOST="tu-usuario@tu-servidor.com"
export SERVER_USER="root"
./scripts/deploy.sh
```

## 🪟 PowerShell (Windows → Servidor)

```powershell
.\scripts\deploy.ps1 -ServerHost "root@tu-servidor.com"
```

## 🔧 En Cloud Run (Logs)

```bash
# Ver logs
gcloud logs read 'resource.type=cloud_run_revision' --region us-central1 --limit 50

# Ver servicio
gcloud run services describe jarvis-v2 --region us-central1

# Actualizar variables de entorno
gcloud run services update jarvis-v2 \
  --region us-central1 \
  --set-env-vars "ANTHROPIC_API_KEY=sk-ant-xxx,PUBLIC_URL=https://tu-dominio.com"
```

## ⚙️ Configuración Requerida

### 1. Secret Manager (API Keys)
```bash
# Crear secrets
echo -n "sk-ant-xxx" | gcloud secrets create ANTHROPIC_API_KEY --data-file=-
echo -n "https://tu-dominio.com" | gcloud secrets create PUBLIC_URL --data-file=-

# Otorgar acceso a Cloud Run
gcloud secrets add-iam-policy-binding ANTHROPIC_API_KEY \
  --member="serviceAccount:tu-project@appspot.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

### 2. Variables de entorno obligatorias para Cloud Run
```
NODE_ENV=production
PORT=8080
PUBLIC_URL=https://tu-dominio.com
LANDINGS_DIR=/tmp/landings
DB_DIR=/tmp/data/db
```

### 3. Cloud SQL (Base de datos)
```bash
# Crear instancia
gcloud sql instances create jarvis-db \
  --database-version=POSTGRES_15 \
  --region=us-central1 \
  --tier=db-f1-micro

# Crear base de datos
gcloud sql databases create jarvis --instance=jarvis-db

# Obtener connection string
gcloud sql instances describe jarvis-db --format="value(connectionName)"
```

## 📋 Checklist Post-Deploy

- [ ] `gcloud auth login` completado
- [ ] Proyecto configurado en gcloud
- [ ] Cloud Run API habilitada
- [ ] Secret Manager con API keys
- [ ] Cloud SQL creado (si usas base de datos)
- [ ] `.env` configurado en Secret Manager
- [ ] Deploy exitoso: `gcloud run services describe jarvis-v2`
- [ ] Telegram bot respondiendo
- [ ] WhatsApp webhook configurado
