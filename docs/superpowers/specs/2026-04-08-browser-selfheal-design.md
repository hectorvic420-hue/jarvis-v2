# Jarvis V2 — Browser Control + Self-Healing Design
**Date:** 2026-04-08  
**Status:** Approved

---

## Overview

Two new capabilities for Jarvis V2:
1. **Browser Control** — Playwright-based automation to fill forms, navigate, click, login to sites, triggered from Telegram
2. **Self-Healing** — Autonomous bug detection, Claude API-powered code repair, TypeScript validation, server restart, and Telegram notification

---

## Feature 1: Browser Control

### Architecture

New tool: `src/tools/browser_control.ts`

Uses **Playwright** with Chromium. Two execution modes:

- **Server (headless):** Playwright headless Chromium on Linux GCP. Always available. Default mode.
- **PC Windows (headed):** Lightweight local agent (`server/windows-agent/index.ts`) running on Windows PC, port 3001, authenticated via `WINDOWS_AGENT_SECRET` token. Jarvis commands it via HTTP. User sees Chrome moving in real time.

Mode selection: if `WINDOWS_AGENT_URL` env var is set, Jarvis routes browser commands to the Windows agent. Otherwise, uses server headless.

### Session Management

Browser instances are stored in a `Map<chatId, BrowserSession>`. Sessions persist between tool calls so multi-step flows work (login → navigate → fill → submit). Sessions auto-close after 10 minutes of inactivity.

### Tool Actions

| Action | Description |
|--------|-------------|
| `navigate` | Go to a URL |
| `click` | Click element by CSS selector or visible text |
| `fill` | Fill a form field |
| `screenshot` | Take screenshot, return file path for Telegram to send |
| `get_text` | Extract text content from page or element |
| `login` | Sequence: fill username + fill password + click submit |
| `select` | Choose dropdown option |
| `scroll` | Scroll page up/down |
| `close` | Close browser session for this chat |

### Parameters

```typescript
{
  action: "navigate" | "click" | "fill" | "screenshot" | "get_text" | "login" | "select" | "scroll" | "close",
  url?: string,           // for navigate
  selector?: string,      // CSS selector or text for click/fill/get_text
  value?: string,         // for fill/select
  username?: string,      // for login
  password?: string,      // for login
  submit_selector?: string, // for login (default: [type=submit])
  mode?: "server" | "windows", // override default mode
}
```

### Windows Agent (`server/windows-agent/index.ts`)

- Express server, port 3001
- Auth: `Authorization: Bearer <WINDOWS_AGENT_SECRET>`
- Single endpoint: `POST /browser` — accepts same action params, executes with Playwright headed
- Configured as a Windows startup script or run manually
- Returns `{ success, result, screenshot_base64? }`

### Environment Variables (new)

```
WINDOWS_AGENT_URL=http://localhost:3001   # optional, enables PC mode
WINDOWS_AGENT_SECRET=<token>             # shared secret
```

---

## Feature 2: Self-Healing

### Architecture

New tool: `src/tools/self_repair.ts`

Uses `ANTHROPIC_API_KEY` (already configured) to call Claude API as the "repair brain."

### Repair Cycle (autonomous)

```
1. Read PM2 error logs — last 100 lines from ~/.pm2/logs/jarvis-v2-error.log
2. Identify affected source file(s) from stack traces
3. Read source file content
4. Call Claude API (claude-sonnet-4-6):
   - System: "You are fixing Jarvis V2, a TypeScript/Node.js bot. Return ONLY valid TypeScript code."
   - User: logs + source code + "Fix the bug. Return the complete corrected file."
5. Write fix to /tmp/jarvis-fix-<timestamp>.ts
6. Compile check: tsc --noEmit on the temp file
7. If valid:
   a. Backup original to /opt/jarvis/backups/<filename>-<timestamp>.bak
   b. Write fix to source path
   c. cd /opt/jarvis/jarvis-v2 && npm run build
   d. pm2 restart jarvis-v2
   e. Notify Telegram: "✅ Me reparé. Archivo: X. Backup: Y"
8. If invalid:
   a. Discard fix
   b. Notify Telegram: "⚠️ Intenté repararme pero el fix no compila. Error: Z"
```

### Safety Mechanisms

- **Rate limit:** Max 3 auto-repairs per hour. State stored in SQLite (`self_repair_log` table).
- **Backup always:** Every repair creates a timestamped backup before overwriting.
- **Scope restriction:** Only files inside `/opt/jarvis/jarvis-v2/src/` can be modified.
- **Compile gate:** `tsc --noEmit` must pass before applying any change.
- **No recursion:** `self_repair` tool is excluded from the tools list passed to the LLM during a repair session (prevents Jarvis from calling self_repair inside a self_repair).

### Auto-Trigger Integration

In `agent.ts`, when `loopBreaks >= MAX_LOOP_BREAKS` OR `MAX_ITERATIONS` is reached AND the error involves a tool failure (not a user request issue), Jarvis automatically invokes `self_repair` with action `diagnose` first, then `repair` if diagnosis finds a fixable bug.

Condition to auto-trigger:
- `lastToolErrors` map has entries (real tool failures occurred)
- Not a user input/auth error (those are fatal, not fixable)

### Tool Actions (manual from Telegram)

| Action | Description |
|--------|-------------|
| `diagnose` | Read logs, analyze with Claude, return explanation of what's wrong |
| `repair` | Full autonomous repair cycle |
| `read_logs` | Return last N lines of PM2 error log |
| `rollback` | Restore last backup for a given file |
| `list_backups` | Show available backups |

### Parameters

```typescript
{
  action: "diagnose" | "repair" | "read_logs" | "rollback" | "list_backups",
  lines?: number,       // for read_logs, default 50
  file?: string,        // for rollback, relative path e.g. "src/tools/whatsapp.ts"
  backup_path?: string, // for rollback, specific backup to restore
}
```

### SQLite Table

```sql
CREATE TABLE IF NOT EXISTS self_repair_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,         -- "repair_success" | "repair_failed" | "compile_error"
  file_patched TEXT,
  backup_path TEXT,
  error_summary TEXT,
  fix_summary TEXT
);
```

### Environment Variables (new)

```
# Uses existing ANTHROPIC_API_KEY
BACKUPS_DIR=/opt/jarvis/backups   # where to store .bak files
```

---

## Deployment Notes

### Server Setup

```bash
# Install Playwright + Chromium on Linux server
npm install playwright
npx playwright install chromium --with-deps
```

### Windows Agent Setup

```bash
# On Windows PC, in server/windows-agent/
npm install
node index.js   # or add to Windows startup
```

### New env vars to add to server .env

```
WINDOWS_AGENT_URL=   # leave empty for server-only mode
WINDOWS_AGENT_SECRET=
BACKUPS_DIR=/opt/jarvis/backups
```

---

## Files Created/Modified

| File | Action |
|------|--------|
| `src/tools/browser_control.ts` | Create |
| `src/tools/self_repair.ts` | Create |
| `src/tools/index.ts` | Add both tools to registry + system prompt |
| `src/agent.ts` | Add auto-trigger for self_repair on MAX_ITERATIONS/circuit breaker |
| `src/memory/db.ts` | Add `self_repair_log` table |
| `server/windows-agent/index.ts` | Create |
| `server/windows-agent/package.json` | Create |
| `src/bot/telegram.ts` | Handle screenshot responses (send as photo) |
