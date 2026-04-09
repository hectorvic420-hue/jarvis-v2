#!/usr/bin/env bash
# scripts/build.sh — Compila TypeScript y prepara para producción
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

echo "🔨 Construyendo Jarvis v2..."

# 1. Instalar dependencias
echo "📦 Instalando dependencias..."
npm install

# 2. Compilar TypeScript
echo "⚙️  Compilando TypeScript..."
npm run build

# 3. Verificar que no hay errores
if [ ! -f "dist/index.js" ]; then
  echo "❌ Error: dist/index.js no fue generado"
  exit 1
fi

# 4. Crear directorio de landings si no existe (local)
mkdir -p "landings"
mkdir -p "data/db"

echo "✅ Build completado. Archivos en dist/"
echo ""
echo "Para ejecutar localmente:"
echo "  cp .env.example .env"
echo "  # editar .env con tus API keys"
echo "  npm run dev"
