#!/usr/bin/env bash
# scripts/setup-server.sh — Configura el servidor GCP por primera vez
# Uso: ./scripts/setup-server.sh --server user@host
#
# Ejecutar UNA SOLA VEZ al crear el servidor.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

if [ -z "$2" ]; then
  echo "Uso: $0 --server user@host"
  echo ""
  echo "Este script:"
  echo "  1. Crea el usuario 'jarvis' (opcional, usa root si prefieres)"
  echo "  2. Instala Node.js 20 LTS"
  echo "  3. Crea directorios /opt/jarvis"
  echo "  4. Instala PM2"
  echo "  5. Configura systemd (opcional)"
  echo "  6. Configura firewall (ufw)"
  echo "  7. Crea el servicio systemd"
  exit 1
fi

SERVER="$2"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
step()    { echo -e "${YELLOW}==>${NC} $1"; }

step "Conectando a $SERVER..."

# ── 1. Actualizar sistema + instalar Node.js ───────────────────────────────────
info "Actualizando sistema e instalando Node.js 20..."
ssh "$SERVER" "
  apt-get update && apt-get upgrade -y
  apt-get install -y curl git ufw

  # Node.js 20
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs

  # Verificar
  node -v
  npm -v

  # PM2
  npm install -g pm2
  pm2 install promise-timeout
"

# ── 2. Crear estructura de directorios ─────────────────────────────────────────
info "Creando estructura de directorios..."
ssh "$SERVER" "mkdir -p /opt/jarvis/{dist,data/db,landings,logs}"

# ── 3. Copiar archivo .env.example como base ──────────────────────────────────
info "Crea tu .env en el servidor:"
info "  ssh $SERVER 'nano /opt/jarvis/.env'"
info "  (copia las variables de .env.example y completa los valores)"

# ── 4. Configurar systemd ─────────────────────────────────────────────────────
info "Configurando systemd..."
ssh "$SERVER" "cat > /etc/systemd/system/jarvis.service << 'EOF'
[Unit]
Description=JARVIS v2 - David Academy AI Agent
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=root
WorkingDirectory=/opt/jarvis
ExecStart=/usr/bin/node /opt/jarvis/dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:/opt/jarvis/logs/jarvis.log
StandardError=append:/opt/jarvis/logs/jarvis-error.log
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF"

ssh "$SERVER" "systemctl daemon-reload"

# ── 5. Firewall ────────────────────────────────────────────────────────────────
info "Configurando firewall (开放 22, 80, 443)..."
ssh "$SERVER" "
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
  ufw status numbered
"

# ── 6. Permitir login root por SSH (opcional, para primera config) ─────────────
info ""
info "✅ Servidor configurado. Pasos siguientes:"
info ""
info "1. Deploy inicial:"
info "   export SERVER_HOST=$SERVER"
info "   export SERVER_USER=root"
info "   ./scripts/deploy.sh"
info ""
info "2. Crear .env en el servidor:"
info "   ssh $SERVER 'nano /opt/jarvis/.env'"
info ""
info "3. Reiniciar:"
info "   ./scripts/restart.sh"
info ""
info "4. Habilitar auto-start:"
info "   ssh $SERVER 'systemctl enable jarvis'"
