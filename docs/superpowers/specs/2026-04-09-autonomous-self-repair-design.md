
# Spec: Autonomous Self-Repair v2 — Jarvis V2

**Date:** 2026-04-09  
**Status:** Approved  

---

## Objetivo

Mejorar la autonomía de Jarvis V2 resolviendo 4 limitaciones del sistema actual de auto-reparación:

1. No puede detectar su propio crash (no está vivo para llamarse)
2. No puede instalar dependencias faltantes
3. No puede reparar errores de infraestructura (Chromium, disco, permisos)
4. Los fixes no quedan en git (solo en disco con backup)
5. Diagnóstico con contexto de código limitado

---

## Arquitectura

### Archivos nuevos/modificados

```
src/tools/self_repair.ts        MODIFICADO — git commit + npm install + visión ampliada
src/tools/infra_repair.ts       NUEVO — detección y fix de errores de infraestructura
src/shared/git_utils.ts         NUEVO — commit local post-repair
server/watchdog/watchdog.js     NUEVO — proceso PM2 independiente, detecta crashes
ecosystem.config.js             NUEVO — registra jarvis-v2 + jarvis-watchdog en PM2
```

### Flujo general

```
Jarvis cae (o error en herramienta)
    └→ Watchdog detecta via pm2 jlist cada 30s
         ├→ Lee ~/.pm2/logs/jarvis-v2-error.log (100 líneas)
         ├→ ¿Error de infra conocido? → ejecuta script predefinido → pm2 restart
         ├→ ¿Error de código? → Claude API → fix TypeScript → tsc → build → git commit → pm2 restart
         └→ ¿Error desconocido? → notifica Telegram con diagnóstico + comando sugerido
```

---

## Sección 1: Watchdog (`server/watchdog/watchdog.js`)

- Proceso Node.js puro (sin TypeScript) para evitar dependencia del build de Jarvis
- Registrado en PM2 como proceso independiente `jarvis-watchdog`
- Loop cada 30 segundos:
  1. `pm2 jlist` → parsea estado de `jarvis-v2`
  2. Si `status === "online"` → no hace nada
  3. Si `status === "stopped"` / `"errored"` / proceso ausente:
     - Lee logs de error de PM2
     - Llama `detectInfraIssue(logs)` — si hay fix predefinido, lo ejecuta
     - Si no → llama Claude API directamente via `fetch` (no SDK, para evitar deps)
     - Claude genera fix TypeScript → escribe archivo → `tsc --noEmit` → `npm run build` → `pm2 restart jarvis-v2`
     - `git commit` local con mensaje generado por Claude
     - Notifica Telegram
- Rate limit: máximo 3 reparaciones/hora via archivo JSON en `/tmp/watchdog-repairs.json`
- El watchdog sobrevive al crash de Jarvis — PM2 lo reinicia si cae

### `ecosystem.config.js`

```js
module.exports = {
  apps: [
    { name: "jarvis-v2", script: "dist/index.js", cwd: "/opt/jarvis/jarvis-v2" },
    { name: "jarvis-watchdog", script: "server/watchdog/watchdog.js", cwd: "/opt/jarvis/jarvis-v2", watch: false }
  ]
};
```

---

## Sección 2: Infra Repair (`src/tools/infra_repair.ts`)

### Patrones predefinidos con fix automático

| Patrón en logs | Diagnóstico | Fix |
|---|---|---|
| `resources.pak corruption` / `V8 startup snapshot` | Chromium corrupto | `rm -rf ~/.cache/ms-playwright/ && npx playwright install chromium` |
| `ENOSPC` / `No space left on device` | Disco lleno | Limpia `/tmp`, logs viejos PM2, `/tmp/jarvis-screenshots/` |
| `EACCES` / `permission denied` | Permisos | `chmod` del archivo específico |
| `ECONNREFUSED` / `getaddrinfo ENOTFOUND` | Red caída | Solo notificación (fuera del control de Jarvis) |
| Cualquier otro | Desconocido | Notifica Telegram con diagnóstico Claude + comando sugerido |

### API exportada

```typescript
detectInfraIssue(logs: string): InfraIssue | null
runInfraFix(issue: InfraIssue, chatId: string): Promise<string>
```

### Integración con `self_repair.ts`

Antes de intentar reparar código, `runRepair()` llama `detectInfraIssue(logs)`:
- Si retorna issue → ejecuta `runInfraFix()` → reinicia PM2 → retorna
- Si retorna null → continúa con flujo de repair de código existente

---

## Sección 3: Git Utils (`src/shared/git_utils.ts`)

```typescript
commitRepair(filePath: string, summary: string): Promise<string | null>
// Retorna commit hash o null si git no está disponible
```

Flujo interno:
1. `git add <filePath>`
2. `git commit -m "auto-repair(<archivo>): <summary>"`
3. Retorna hash del commit
4. Si git falla por cualquier razón → log silencioso, no bloquea el repair

El `summary` es generado por Claude durante el repair (no string genérico).  
Ejemplo: `auto-repair(src/tools/whatsapp.ts): fix undefined chatId in sendMessage`

---

## Sección 4: Mejoras a `self_repair.ts`

### Visión ampliada de código

Lógica actual: lee solo archivos del stack trace (máx 3, 3,000 chars cada uno).

Nueva lógica:
- Si stack trace da 0 archivos → lee los 5 archivos más modificados recientemente en `src/`
- Siempre incluye `src/agent.ts` como contexto base
- Límite por archivo: 3,000 → 6,000 chars

### npm install condicional

- Si el error menciona `Cannot find module` → ejecutar `npm install` antes del repair
- Solo en este caso específico (no en todos los repairs)

### git commit post-repair

- Después de `pm2 restart` exitoso → llama `commitRepair(filePath, claudeSummary)`
- El mensaje del commit incluye el resumen que Claude genera del fix
- Hash del commit se incluye en la notificación de Telegram y en el response

---

## Limitaciones que permanecen (fuera de scope)

- No hace `git push` — el push sigue siendo manual (decisión deliberada: evitar contaminar `main` con código AI sin revisión)
- No puede recuperarse de OOM kills del kernel (fuera del control de PM2/watchdog)
- No repara el watchdog si el watchdog mismo tiene un bug de código

---

## Variables de entorno requeridas

Sin cambios — usa las existentes:
```
ANTHROPIC_API_KEY
TELEGRAM_BOT_TOKEN  
JARVIS_ROOT=/opt/jarvis/jarvis-v2
BACKUPS_DIR=/opt/jarvis/backups
```

---

## Criterios de éxito

1. Si Jarvis cae por un bug TypeScript, el watchdog lo detecta en ≤60s y lo repara sin intervención humana
2. Si Chromium se corrompe de nuevo, Jarvis lo detecta y lo reinstala automáticamente
3. Cada repair exitoso genera un git commit local con mensaje descriptivo
4. Si el error es desconocido, el usuario recibe diagnóstico por Telegram en ≤90s
