#!/usr/bin/env bash
# scripts/restart.sh — Reinicia el servicio de Jarvis en el servidor
# Uso: ./scripts/restart.sh [--server user@host] [--logs] [--status]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

SERVER_HOST="${SERVER_HOST:-tu-servidor.com}"
SERVER_USER="${SERVER_USER:-root}"
SERVER_PATH="${SERVER_PATH:-/opt/jarvis}"
SHOW_LOGS=false
SHOW_STATUS=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server) SERVER_HOST="$2"; shift 2 ;;
    --logs) SHOW_LOGS=true; SHOW_STATUS=true; shift ;;
    --status) SHOW_STATUS=true; shift ;;
    *) shift ;;
  esac
done

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }

CMD="
  cd $SERVER_PATH

  # PM2
  if command -v pm2 &>/dev/null; then
    pm2 restart jarvis && pm2 save
    echo '[OK] PM2 restarted'
  # systemd
  elif [ -f /etc/systemd/system/jarvis.service ]; then
    sudo systemctl restart jarvis
    echo '[OK] systemd restarted'
  # node directo
  else
    pkill -f 'node.*dist/index.js' 2>/dev/null || true
    sleep 1
    nohup node dist/index.js > /var/log/jarvis.log 2>&1 &
    echo \"[OK] node started (PID: \$!)\"
  fi
"

info "Reiniciando Jarvis en $SERVER_HOST..."
ssh "$SERVER_USER@$SERVER_HOST" "$CMD"

if [ "$SHOW_STATUS" = true ]; then
  echo ""
  info "Estado del servicio:"
  ssh "$SERVER_USER@$SERVER_HOST" "
    if command -v pm2 &>/dev/null; then
      pm2 status
    elif [ -f /etc/systemd/system/jarvis.service ]; then
      sudo systemctl status jarvis --no-pager
    else
      ps aux | grep 'node.*dist/index' | grep -v grep
    fi
  "
fi

if [ "$SHOW_LOGS" = true ]; then
  echo ""
  info "Logs recientes:"
  ssh "$SERVER_USER@$SERVER_HOST" "
    if command -v pm2 &>/dev/null; then
      pm2 logs jarvis --lines 30 --nostream
    elif [ -f /var/log/jarvis.log ]; then
      tail -30 /var/log/jarvis.log
    else
      echo 'Logs no disponibles en esta configuración'
    fi
  "
fi

info "Listo!"
