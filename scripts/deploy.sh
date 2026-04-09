#!/usr/bin/env bash
# scripts/deploy.sh — Compila y despliega a servidor GCP
# Uso: ./scripts/deploy.sh [--server user@host] [--skip-build] [--skip-restart]
#
# Requiere: rsync, ssh
# Configurar SERVER_HOST y SERVER_USER en .env o variables de entorno

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# ── Argumentos ─────────────────────────────────────────────────────────────────
SERVER_HOST="${SERVER_HOST:-tu-servidor.com}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_PATH="${SERVER_PATH:-/opt/jarvis}"
SKIP_BUILD=false
SKIP_RESTART=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_HOST="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=true; shift ;;
    --skip-restart) SKIP_RESTART=true; shift ;;
    *) echo "Opción desconocida: $1"; exit 1 ;;
  esac
done

# ── Colores ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ── Validaciones ───────────────────────────────────────────────────────────────
if [ -z "$SERVER_HOST" ]; then
  error "Define SERVER_HOST (export SERVER_HOST=user@host) o usa --server"
fi

info "Deploy a $SERVER_HOST"
info "Ruta remota: $SERVER_PATH"

# ── 1. Build ──────────────────────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  info "Compilando TypeScript..."
  npm install
  npm run build
  info "Build OK"
else
  info "Build omitido (--skip-build)"
fi

# ── 2. Crear directorio remoto si no existe ───────────────────────────────────
info "Verificando directorio remoto..."
ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $SERVER_PATH/{dist,data/db,landings}"

# ── 3. Rsync: copiar archivos (excluye node_modules, .git, .env) ───────────────
info "Sincronizando archivos..."
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.env' \
  --exclude 'dist/node_modules' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  --exclude 'landings/*.html' \
  --delete \
  "$PROJECT_DIR/" "$SERVER_USER@$SERVER_HOST:$SERVER_PATH/"

# ── 4. Instalar dependencias remotas ─────────────────────────────────────────
info "Instalando dependencias en servidor..."
ssh "$SERVER_USER@$SERVER_HOST" "cd $SERVER_PATH && npm install --production"

# ── 5. Crear .env en servidor si no existe ───────────────────────────────────
info "Verificando .env en servidor..."
ssh "$SERVER_USER@$SERVER_HOST" "test -f $SERVER_PATH/.env" || {
  warn ".env no existe en servidor. Crea uno manualmente:"
  warn "  ssh $SERVER_USER@$SERVER_HOST 'cat > $SERVER_PATH/.env << EOF"
  warn "  (copia tu .env.local)"
  warn "  EOF'"
}

# ── 6. Reiniciar servicio ─────────────────────────────────────────────────────
if [ "$SKIP_RESTART" = false ]; then
  info "Reiniciando servicio..."
  ssh "$SERVER_USER@$SERVER_HOST" "
    cd $SERVER_PATH
    # Opción A: PM2
    if command -v pm2 &>/dev/null; then
      pm2 restart jarvis --update-env || pm2 start dist/index.js --name jarvis
      pm2 save
    # Opción B: systemd
    elif [ -f /etc/systemd/system/jarvis.service ]; then
      sudo systemctl restart jarvis
      sudo systemctl status jarvis --no-pager
    # Opción C: node directo
    else
      pkill -f 'node dist/index.js' || true
      nohup node dist/index.js > /var/log/jarvis.log 2>&1 &
      echo \"PID: \$!\"
    fi
  "
  info "Servicio reiniciado"
else
  info "Reinicio omitido (--skip-restart)"
fi

info ""
info "✅ Deploy completado!"
info "   Servidor: $SERVER_HOST"
info "   Ruta: $SERVER_PATH"
info ""
info "Verificar logs:"
info "   ssh $SERVER_USER@$SERVER_HOST 'pm2 logs jarvis --lines 50'"
info "   ssh $SERVER_USER@$SERVER_HOST 'journalctl -u jarvis -n 50'"
