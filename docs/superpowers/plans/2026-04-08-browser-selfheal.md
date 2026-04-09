# Browser Control + Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Playwright browser automation (fill forms, login, screenshot) and autonomous self-healing (Claude API analyzes bugs, patches code, rebuilds, restarts) to Jarvis V2.

**Architecture:** Two new tools (`browser_control`, `self_repair`) registered in the existing tool registry. Browser sessions are held in a module-level Map keyed by chatId. Self-repair uses the existing `@anthropic-ai/sdk` to analyze PM2 logs and generate TypeScript fixes, validates with `tsc --noEmit`, then applies + restarts. Auto-trigger hooks into agent.ts circuit breaker.

**Tech Stack:** Playwright (Chromium), @anthropic-ai/sdk (already installed), better-sqlite3 (already installed), Express (Windows agent), Node.js child_process for shell commands.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/tools/browser_control.ts` | Create | Playwright sessions, all browser actions, screenshot store |
| `src/tools/self_repair.ts` | Create | Read logs, call Claude, validate TS, patch files, restart |
| `src/tools/index.ts` | Modify | Register both tools, add to system prompt |
| `src/memory/db.ts` | Modify | Add `self_repair_log` migration |
| `src/bot/telegram.ts` | Modify | Send screenshots as photos after agent responds |
| `src/agent.ts` | Modify | Auto-trigger self_repair on circuit breaker / MAX_ITERATIONS |
| `server/windows-agent/index.ts` | Create | Express server on Windows for headed browser |
| `server/windows-agent/package.json` | Create | Dependencies for Windows agent |
| `package.json` | Modify | Add `playwright` dependency |

---

## Task 1: Add Playwright dependency + DB migration

**Files:**
- Modify: `package.json`
- Modify: `src/memory/db.ts`

- [ ] **Step 1: Add playwright to package.json**

In `package.json`, add to `"dependencies"`:
```json
"playwright": "^1.43.0"
```

Final dependencies block (add the one line):
```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.81.0",
  "@google/generative-ai": "^0.24.1",
  "better-sqlite3": "^11.5.0",
  "dotenv": "^16.4.5",
  "express": "^5.2.1",
  "googleapis": "^171.4.0",
  "grammy": "^1.30.0",
  "groq-sdk": "^0.9.1",
  "mammoth": "^1.12.0",
  "openai": "^4.47.1",
  "pdf-parse": "^2.4.5",
  "playwright": "^1.43.0",
  "uuid": "^13.0.0",
  "xlsx": "^0.18.5",
  "zod": "^3.23.8"
}
```

- [ ] **Step 2: Add self_repair_log table to db.ts migration**

In `src/memory/db.ts`, append to the existing `db.exec(`` ` `` ... `` ` ``)` block (before the closing backtick):

```sql
  CREATE TABLE IF NOT EXISTS self_repair_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    action        TEXT NOT NULL,
    file_patched  TEXT,
    backup_path   TEXT,
    error_summary TEXT,
    fix_summary   TEXT
  );
```

- [ ] **Step 3: Install locally and verify DB**

```bash
cd c:/Users/ACER/Jarvis-V2
npm install
npx tsx -e "import './src/memory/db.js'; console.log('DB OK')"
```

Expected output: `DB OK` (no errors)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/memory/db.ts
git commit -m "feat: add playwright dep + self_repair_log DB table"
```

---

## Task 2: Create browser_control tool

**Files:**
- Create: `src/tools/browser_control.ts`

- [ ] **Step 1: Create the file**

Create `src/tools/browser_control.ts` with this full content:

```typescript
import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { Tool } from "../shared/types.js";

// ─── Screenshot store ─────────────────────────────────────────────────────────
// telegram.ts reads this after runAgent() to send the photo
export const screenshotStore = new Map<string, string>();

// ─── Session management ───────────────────────────────────────────────────────

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// Clean up stale sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [chatId, s] of sessions.entries()) {
    if (now - s.lastUsed > SESSION_TIMEOUT_MS) {
      s.browser.close().catch(() => {});
      sessions.delete(chatId);
      console.log(`[browser_control] Session closed (timeout) for ${chatId}`);
    }
  }
}, 60_000);

async function getOrCreateSession(chatId: string, headed = false): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  // Check if Windows agent mode is requested
  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? [] : ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const session: BrowserSession = { browser, context, page, lastUsed: Date.now() };
  sessions.set(chatId, session);
  console.log(`[browser_control] New session for ${chatId} (headless=${!headed})`);
  return session;
}

// ─── Windows Agent proxy ──────────────────────────────────────────────────────

async function callWindowsAgent(
  params: Record<string, unknown>
): Promise<string> {
  const agentUrl = process.env.WINDOWS_AGENT_URL;
  const secret   = process.env.WINDOWS_AGENT_SECRET ?? "";

  const res = await fetch(`${agentUrl}/browser`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return `❌ Windows agent error ${res.status}: ${text}`;
  }

  const json = (await res.json()) as {
    success: boolean;
    result: string;
    screenshot_path?: string;
  };

  return json.result;
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function navigate(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const title = await page.title();
  return `✅ Navegué a: ${url}\nTítulo: ${title}`;
}

async function clickElement(page: Page, selector: string): Promise<string> {
  // Try CSS selector first, then visible text
  try {
    await page.click(selector, { timeout: 10_000 });
    return `✅ Clic en: ${selector}`;
  } catch {
    await page.getByText(selector).first().click({ timeout: 10_000 });
    return `✅ Clic en texto: "${selector}"`;
  }
}

async function fillField(page: Page, selector: string, value: string): Promise<string> {
  await page.fill(selector, value, { timeout: 10_000 });
  return `✅ Rellené campo "${selector}" con valor`;
}

async function takeScreenshot(page: Page, chatId: string): Promise<string> {
  const screenshotsDir = "/tmp/jarvis-screenshots";
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

  const filePath = path.join(screenshotsDir, `screenshot-${chatId}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  screenshotStore.set(chatId, filePath);
  return `📸 Screenshot tomado`;
}

async function getText(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const el = page.locator(selector).first();
    const text = await el.textContent({ timeout: 10_000 });
    return `📄 Texto en "${selector}":\n${text?.trim() ?? "(vacío)"}`;
  }
  const text = await page.evaluate(() => document.body.innerText);
  return `📄 Texto de la página:\n${text.slice(0, 2000)}`;
}

async function loginSequence(
  page: Page,
  username: string,
  password: string,
  userSelector: string,
  passSelector: string,
  submitSelector: string
): Promise<string> {
  await page.fill(userSelector, username, { timeout: 10_000 });
  await page.fill(passSelector, password, { timeout: 10_000 });
  await page.click(submitSelector, { timeout: 10_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  const url   = page.url();
  const title = await page.title();
  return `✅ Login ejecutado\nURL actual: ${url}\nTítulo: ${title}`;
}

async function selectOption(page: Page, selector: string, value: string): Promise<string> {
  await page.selectOption(selector, value, { timeout: 10_000 });
  return `✅ Seleccioné "${value}" en ${selector}`;
}

async function scrollPage(page: Page, direction: "down" | "up" = "down"): Promise<string> {
  await page.evaluate((dir) => {
    window.scrollBy(0, dir === "down" ? 600 : -600);
  }, direction);
  return `✅ Scroll ${direction}`;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const browserControlTool: Tool = {
  name: "browser_control",
  description:
    "Controla un navegador web: navega a URLs, hace clic, rellena formularios, toma screenshots, ejecuta login. " +
    "Úsalo para: llenar formularios, entrar a páginas, hacer login, confirmar acciones en sitios web. " +
    "Las sesiones del navegador se mantienen abiertas entre comandos del mismo chat.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "fill", "screenshot", "get_text", "login", "select", "scroll", "close"],
        description: "Acción a ejecutar en el navegador",
      },
      url: {
        type: "string",
        description: "URL para navegar (acción: navigate)",
      },
      selector: {
        type: "string",
        description: "Selector CSS o texto visible del elemento (acciones: click, fill, get_text, select)",
      },
      value: {
        type: "string",
        description: "Valor a escribir o seleccionar (acciones: fill, select)",
      },
      username: {
        type: "string",
        description: "Nombre de usuario para login",
      },
      password: {
        type: "string",
        description: "Contraseña para login",
      },
      user_selector: {
        type: "string",
        description: "Selector del campo usuario (default: input[name='email'],input[type='email'],#email,#username)",
      },
      pass_selector: {
        type: "string",
        description: "Selector del campo contraseña (default: input[type='password'])",
      },
      submit_selector: {
        type: "string",
        description: "Selector del botón submit (default: [type='submit'],button[type='submit'])",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Dirección del scroll (default: down)",
      },
      mode: {
        type: "string",
        enum: ["server", "windows"],
        description: "Modo de ejecución: server (headless, default) o windows (headed en PC)",
      },
    },
    required: ["action"],
  },

  async execute(params, chatId) {
    const {
      action,
      url,
      selector,
      value,
      username,
      password,
      user_selector = "input[name='email'],input[type='email'],#email,#username,input[name='user']",
      pass_selector = "input[type='password']",
      submit_selector = "[type='submit'],button[type='submit'],button:has-text('Login'),button:has-text('Entrar'),button:has-text('Iniciar')",
      direction = "down",
      mode,
    } = params as Record<string, string>;

    // Route to Windows agent if requested and configured
    const windowsUrl = process.env.WINDOWS_AGENT_URL;
    if (mode === "windows" || (!mode && windowsUrl)) {
      if (!windowsUrl) return "❌ WINDOWS_AGENT_URL no configurado. Usa mode='server' o configura la variable.";
      return await callWindowsAgent(params);
    }

    try {
      if (action === "close") {
        const s = sessions.get(chatId);
        if (s) {
          await s.browser.close();
          sessions.delete(chatId);
          screenshotStore.delete(chatId);
        }
        return "✅ Navegador cerrado.";
      }

      const session = await getOrCreateSession(chatId);
      const { page } = session;

      switch (action) {
        case "navigate":
          if (!url) return "❌ Parámetro 'url' requerido para navigate";
          return await navigate(page, url);

        case "click":
          if (!selector) return "❌ Parámetro 'selector' requerido para click";
          return await clickElement(page, selector);

        case "fill":
          if (!selector) return "❌ Parámetro 'selector' requerido para fill";
          if (value === undefined) return "❌ Parámetro 'value' requerido para fill";
          return await fillField(page, selector, value);

        case "screenshot":
          return await takeScreenshot(page, chatId);

        case "get_text":
          return await getText(page, selector);

        case "login":
          if (!username || !password) return "❌ Parámetros 'username' y 'password' requeridos para login";
          return await loginSequence(page, username, password, user_selector, pass_selector, submit_selector);

        case "select":
          if (!selector || !value) return "❌ Parámetros 'selector' y 'value' requeridos para select";
          return await selectOption(page, selector, value);

        case "scroll":
          return await scrollPage(page, direction as "up" | "down");

        default:
          return `❌ Acción desconocida: ${action}`;
      }
    } catch (err) {
      return `❌ Error en browser_control (${action}): ${(err as Error).message}`;
    }
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd c:/Users/ACER/Jarvis-V2
npx tsc --noEmit
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/tools/browser_control.ts
git commit -m "feat: add browser_control tool with Playwright"
```

---

## Task 3: Create Windows agent

**Files:**
- Create: `server/windows-agent/package.json`
- Create: `server/windows-agent/index.ts`

- [ ] **Step 1: Create package.json**

Create `server/windows-agent/package.json`:

```json
{
  "name": "jarvis-windows-agent",
  "version": "1.0.0",
  "description": "Local agent for headed browser control on Windows",
  "scripts": {
    "start": "npx tsx index.ts"
  },
  "dependencies": {
    "express": "^5.2.1",
    "playwright": "^1.43.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "tsx": "^4.9.3",
    "typescript": "^5.4.5"
  }
}
```

- [ ] **Step 2: Create index.ts**

Create `server/windows-agent/index.ts`:

```typescript
import express from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

const app  = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const SECRET = process.env.WINDOWS_AGENT_SECRET ?? "jarvis-windows-secret";

app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.status(401).json({ success: false, result: "Unauthorized" });
    return;
  }
  next();
});

// ─── Session management ───────────────────────────────────────────────────────
interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();

async function getOrCreateSession(chatId: string): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) { existing.lastUsed = Date.now(); return existing; }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();
  const session: BrowserSession = { browser, context, page, lastUsed: Date.now() };
  sessions.set(chatId, session);
  return session;
}

// ─── Browser endpoint ─────────────────────────────────────────────────────────
app.post("/browser", async (req, res) => {
  const params = req.body as Record<string, string>;
  const { action, url, selector, value, username, password,
    user_selector = "input[type='email'],#email,#username",
    pass_selector = "input[type='password']",
    submit_selector = "[type='submit']",
    direction = "down",
  } = params;

  const chatId = params.chat_id ?? "default";

  try {
    if (action === "close") {
      const s = sessions.get(chatId);
      if (s) { await s.browser.close(); sessions.delete(chatId); }
      res.json({ success: true, result: "✅ Navegador cerrado." });
      return;
    }

    const { page } = await getOrCreateSession(chatId);

    let result = "";

    switch (action) {
      case "navigate":
        await page.goto(url!, { waitUntil: "domcontentloaded", timeout: 30_000 });
        result = `✅ Navegué a: ${url}\nTítulo: ${await page.title()}`;
        break;

      case "click":
        try {
          await page.click(selector!, { timeout: 10_000 });
        } catch {
          await page.getByText(selector!).first().click({ timeout: 10_000 });
        }
        result = `✅ Clic en: ${selector}`;
        break;

      case "fill":
        await page.fill(selector!, value!, { timeout: 10_000 });
        result = `✅ Rellené campo "${selector}"`;
        break;

      case "screenshot": {
        const dir = path.join(process.env.TEMP ?? "C:/Temp", "jarvis-screenshots");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: filePath });
        result = `📸 Screenshot en: ${filePath}`;
        res.json({ success: true, result, screenshot_path: filePath });
        return;
      }

      case "get_text":
        result = selector
          ? `📄 ${await page.locator(selector).first().textContent({ timeout: 10_000 })}`
          : `📄 ${(await page.evaluate(() => document.body.innerText)).slice(0, 2000)}`;
        break;

      case "login":
        await page.fill(user_selector, username!, { timeout: 10_000 });
        await page.fill(pass_selector, password!, { timeout: 10_000 });
        await page.click(submit_selector, { timeout: 10_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
        result = `✅ Login ejecutado. URL: ${page.url()}`;
        break;

      case "select":
        await page.selectOption(selector!, value!, { timeout: 10_000 });
        result = `✅ Seleccioné "${value}"`;
        break;

      case "scroll":
        await page.evaluate((dir) => { window.scrollBy(0, dir === "down" ? 600 : -600); }, direction);
        result = `✅ Scroll ${direction}`;
        break;

      default:
        res.json({ success: false, result: `❌ Acción desconocida: ${action}` });
        return;
    }

    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, result: `❌ Error (${action}): ${(err as Error).message}` });
  }
});

app.listen(PORT, () => {
  console.log(`🖥️  Jarvis Windows Agent running on port ${PORT}`);
  console.log(`   Secret configured: ${SECRET !== "jarvis-windows-secret" ? "✅" : "⚠️  using default"}`);
});
```

- [ ] **Step 3: Commit**

```bash
git add server/windows-agent/
git commit -m "feat: add Windows headed browser agent"
```

---

## Task 4: Create self_repair tool

**Files:**
- Create: `src/tools/self_repair.ts`

- [ ] **Step 1: Create the file**

Create `src/tools/self_repair.ts`:

```typescript
import Anthropic            from "@anthropic-ai/sdk";
import { exec }             from "child_process";
import { promisify }        from "util";
import * as fs              from "fs";
import * as path            from "path";
import db                   from "../memory/db.js";
import { Tool }             from "../shared/types.js";

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_ROOT  = process.env.JARVIS_ROOT  ?? "/opt/jarvis/jarvis-v2";
const BACKUPS_DIR   = process.env.BACKUPS_DIR  ?? "/opt/jarvis/backups";
const PM2_LOG       = path.join(process.env.HOME ?? "", ".pm2/logs/jarvis-v2-error.log");
const MAX_REPAIRS_PER_HOUR = 3;

// ─── Rate limiter ─────────────────────────────────────────────────────────────
function getRepairsInLastHour(): number {
  const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM self_repair_log WHERE timestamp > ? AND action LIKE 'repair%'`)
    .get(oneHourAgo) as { cnt: number };
  return row.cnt;
}

function logRepair(action: string, filePath?: string, backupPath?: string, errorSummary?: string, fixSummary?: string): void {
  db.prepare(`
    INSERT INTO self_repair_log (action, file_patched, backup_path, error_summary, fix_summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(action, filePath ?? null, backupPath ?? null, errorSummary ?? null, fixSummary ?? null);
}

// ─── Telegram notification (no grammy dep needed) ─────────────────────────────
async function notifyTelegram(chatId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || chatId === "system") return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch {
    // Silent fail — don't block repair because notification failed
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readLogs(lines = 100): string {
  try {
    if (!fs.existsSync(PM2_LOG)) return "⚠️ Archivo de log PM2 no encontrado.";
    const content = fs.readFileSync(PM2_LOG, "utf-8");
    const all     = content.split("\n");
    return all.slice(-lines).join("\n") || "(log vacío)";
  } catch (err) {
    return `❌ Error leyendo logs: ${(err as Error).message}`;
  }
}

function extractFilesFromStack(logs: string): string[] {
  // Match: at ... (/opt/jarvis/jarvis-v2/src/...ts) or dist/...js
  const srcRegex  = /\/opt\/jarvis\/jarvis-v2\/src\/([\w/.-]+\.ts)/g;
  const distRegex = /\/opt\/jarvis\/jarvis-v2\/dist\/([\w/.-]+\.js)/g;

  const files = new Set<string>();

  for (const match of logs.matchAll(srcRegex)) {
    files.add(`src/${match[1]}`);
  }
  for (const match of logs.matchAll(distRegex)) {
    // Convert dist/tools/foo.js → src/tools/foo.ts
    const src = match[1].replace(/\.js$/, ".ts");
    files.add(`src/${src}`);
  }

  return [...files].slice(0, 3); // limit to 3 files
}

function backupFile(absolutePath: string): string {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const filename   = path.basename(absolutePath);
  const backupPath = path.join(BACKUPS_DIR, `${filename}-${Date.now()}.bak`);
  fs.copyFileSync(absolutePath, backupPath);
  return backupPath;
}

// ─── Core repair logic ────────────────────────────────────────────────────────
async function runRepair(chatId: string): Promise<string> {
  // Rate limit
  const recentCount = getRepairsInLastHour();
  if (recentCount >= MAX_REPAIRS_PER_HOUR) {
    return `⚠️ Límite de auto-reparaciones alcanzado (${MAX_REPAIRS_PER_HOUR}/hora). Espera antes de intentar de nuevo.`;
  }

  // 1. Read logs
  const logs = readLogs(100);
  if (logs.startsWith("⚠️") || logs === "(log vacío)") {
    return "⚠️ No hay logs de error recientes. No hay nada que reparar.";
  }

  // 2. Find affected files
  const affectedFiles = extractFilesFromStack(logs);
  if (affectedFiles.length === 0) {
    // Fallback: try agent.ts since it's the main loop
    affectedFiles.push("src/agent.ts");
  }

  const targetRelPath = affectedFiles[0];
  const targetAbsPath = path.join(PROJECT_ROOT, targetRelPath);

  if (!targetAbsPath.startsWith(path.join(PROJECT_ROOT, "src"))) {
    return `❌ Por seguridad, solo puedo editar archivos en src/. Detecté: ${targetRelPath}`;
  }

  if (!fs.existsSync(targetAbsPath)) {
    return `❌ Archivo no encontrado: ${targetAbsPath}`;
  }

  const originalCode = fs.readFileSync(targetAbsPath, "utf-8");

  // 3. Call Claude API
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let fixedCode: string;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system:
        "You are fixing a bug in Jarvis V2, a TypeScript/Node.js Telegram bot. " +
        "You will receive error logs and the source file content. " +
        "Return ONLY the complete corrected TypeScript file content with no explanation, no markdown fences, no comments about the fix. " +
        "Just the raw TypeScript code.",
      messages: [
        {
          role: "user",
          content:
            `ERROR LOGS (last 100 lines):\n${logs}\n\n` +
            `SOURCE FILE (${targetRelPath}):\n${originalCode}\n\n` +
            "Fix the bug. Return ONLY the complete corrected TypeScript file.",
        },
      ],
    });

    fixedCode = (message.content[0] as { type: string; text: string }).text.trim();
  } catch (err) {
    logRepair("repair_failed", targetRelPath, undefined, (err as Error).message);
    return `❌ Claude API falló al generar fix: ${(err as Error).message}`;
  }

  // 4. Backup + write
  const backupPath = backupFile(targetAbsPath);
  fs.writeFileSync(targetAbsPath, fixedCode, "utf-8");

  // 5. TypeScript compile check
  let compileOk = false;
  let compileError = "";
  try {
    await execAsync("npx tsc --noEmit", {
      cwd: PROJECT_ROOT,
      timeout: 60_000,
    });
    compileOk = true;
  } catch (err) {
    compileError = (err as Error & { stderr?: string }).stderr ?? (err as Error).message;
    compileError = compileError.slice(0, 500);
  }

  if (!compileOk) {
    // Rollback
    fs.copyFileSync(backupPath, targetAbsPath);
    logRepair("repair_compile_error", targetRelPath, backupPath, logs.slice(0, 300), compileError);
    await notifyTelegram(chatId,
      `⚠️ *Intento de auto-reparación fallido*\n` +
      `Archivo: \`${targetRelPath}\`\n` +
      `El fix no compiló. Restauré el original.\n` +
      `Error TS: \`${compileError.slice(0, 200)}\``
    );
    return `❌ Fix generado pero no compila. Restauré el original.\nError: ${compileError.slice(0, 300)}`;
  }

  // 6. Build + restart
  try {
    await execAsync("npm run build", { cwd: PROJECT_ROOT, timeout: 120_000 });
    await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
  } catch (err) {
    // Build failed — rollback
    fs.copyFileSync(backupPath, targetAbsPath);
    const buildErr = (err as Error).message.slice(0, 300);
    logRepair("repair_build_error", targetRelPath, backupPath, logs.slice(0, 300), buildErr);
    await notifyTelegram(chatId,
      `⚠️ *Auto-reparación: build falló*\n` +
      `Restauré el original de: \`${targetRelPath}\`\n` +
      `Error: \`${buildErr}\``
    );
    return `❌ Fix compiló pero el build falló. Restauré el original.\nError: ${buildErr}`;
  }

  // 7. Success
  const fixSummary = `Patched ${targetRelPath}`;
  logRepair("repair_success", targetRelPath, backupPath, logs.slice(0, 300), fixSummary);

  await notifyTelegram(chatId,
    `✅ *Me reparé exitosamente*\n` +
    `Archivo: \`${targetRelPath}\`\n` +
    `Backup: \`${backupPath}\`\n` +
    `Estado: reiniciando...`
  );

  return `✅ Reparación exitosa.\nArchivo: ${targetRelPath}\nBackup guardado en: ${backupPath}`;
}

// ─── Tool definition ──────────────────────────────────────────────────────────
export const selfRepairTool: Tool = {
  name: "self_repair",
  description:
    "Permite a JARVIS diagnosticarse y repararse de forma autónoma. " +
    "Lee logs de PM2, analiza errores con IA, genera un fix TypeScript, valida la compilación y reinicia el servicio. " +
    "Úsalo cuando: Jarvis falle, tenga bucles, o necesite repararse.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["diagnose", "repair", "read_logs", "rollback", "list_backups"],
        description:
          "diagnose: analiza logs y explica el problema | " +
          "repair: ciclo completo de auto-reparación | " +
          "read_logs: ver últimos N líneas de log | " +
          "rollback: restaurar último backup | " +
          "list_backups: ver backups disponibles",
      },
      lines: {
        type: "number",
        description: "Número de líneas de log a leer (solo para read_logs, default 50)",
      },
      file: {
        type: "string",
        description: "Ruta relativa del archivo a restaurar (solo para rollback, ej: src/tools/whatsapp.ts)",
      },
    },
    required: ["action"],
  },

  async execute(params, chatId) {
    const { action, lines = 50, file } = params as { action: string; lines?: number; file?: string };

    switch (action) {
      case "read_logs":
        return `📋 *Últimas ${lines} líneas de log PM2:*\n\`\`\`\n${readLogs(lines as number)}\n\`\`\``;

      case "diagnose": {
        const logs = readLogs(100);
        if (logs.startsWith("⚠️")) return logs;

        const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        const affectedFiles = extractFilesFromStack(logs);

        let codeContext = "";
        for (const f of affectedFiles) {
          const abs = path.join(PROJECT_ROOT, f);
          if (fs.existsSync(abs)) {
            codeContext += `\n\n--- ${f} ---\n${fs.readFileSync(abs, "utf-8").slice(0, 3000)}`;
          }
        }

        const msg = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          messages: [{
            role: "user",
            content:
              `Error logs:\n${logs}\n${codeContext}\n\n` +
              "In 2-3 sentences: what is the bug, what file, and what is the fix? Respond in Spanish.",
          }],
        });

        return `🔍 *Diagnóstico:*\n${(msg.content[0] as { text: string }).text}`;
      }

      case "repair":
        return await runRepair(chatId);

      case "rollback": {
        if (!file) return "❌ Parámetro 'file' requerido para rollback (ej: src/tools/whatsapp.ts)";

        const absPath = path.join(PROJECT_ROOT, file);
        if (!absPath.startsWith(path.join(PROJECT_ROOT, "src"))) {
          return "❌ Solo puedo restaurar archivos dentro de src/";
        }

        if (!fs.existsSync(BACKUPS_DIR)) return "❌ No hay backups disponibles aún.";

        const baseName = path.basename(file);
        const backups  = fs.readdirSync(BACKUPS_DIR)
          .filter(f => f.startsWith(baseName) && f.endsWith(".bak"))
          .sort()
          .reverse();

        if (backups.length === 0) return `❌ No hay backup para: ${file}`;

        const latest = path.join(BACKUPS_DIR, backups[0]);
        fs.copyFileSync(latest, absPath);

        try {
          await execAsync("npm run build", { cwd: PROJECT_ROOT, timeout: 120_000 });
          await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
        } catch (err) {
          return `⚠️ Archivo restaurado pero build falló: ${(err as Error).message.slice(0, 200)}`;
        }

        return `✅ Restaurado desde: ${backups[0]}\nServicio reiniciado.`;
      }

      case "list_backups": {
        if (!fs.existsSync(BACKUPS_DIR)) return "📂 No hay backups aún.";
        const files = fs.readdirSync(BACKUPS_DIR).sort().reverse().slice(0, 20);
        if (files.length === 0) return "📂 No hay backups aún.";
        return `📂 *Backups disponibles:*\n${files.map(f => `• ${f}`).join("\n")}`;
      }

      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd c:/Users/ACER/Jarvis-V2
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/self_repair.ts
git commit -m "feat: add self_repair tool with Claude-powered autonomous healing"
```

---

## Task 5: Register tools in index.ts + update system prompt

**Files:**
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Add imports**

In `src/tools/index.ts`, add these two import lines after the existing imports (after `landingBuilderTool` import):

```typescript
import { browserControlTool } from "./browser_control.js";
import { selfRepairTool }     from "./self_repair.js";
```

- [ ] **Step 2: Register in the tools Record**

In the `export const tools: Record<string, Tool>` object, add the two new entries:

```typescript
  [browserControlTool.name]: browserControlTool,
  [selfRepairTool.name]:      selfRepairTool,
```

- [ ] **Step 3: Add to system prompt**

In `src/tools/index.ts`, in the `SYSTEM_PROMPT` constant, find the section for `### system_control` and add these two sections after it:

```typescript
  `### browser_control\n` +
  `Úsala para CUALQUIER cosa relacionada con controlar un navegador web:\n` +
  `- Navegar a URLs, hacer clic en botones/links\n` +
  `- Rellenar formularios y campos de texto\n` +
  `- Hacer login en sitios web\n` +
  `- Tomar screenshots de páginas web\n` +
  `- Extraer texto de páginas\n` +
  `Palabras clave: "entra a", "abre la página", "rellena el formulario", "haz login en", "screenshot de", "llena los datos en", "confirma en la web"\n\n` +

  `### self_repair\n` +
  `Úsala para diagnosticar y reparar errores del propio sistema Jarvis:\n` +
  `- Leer logs de error del servidor\n` +
  `- Diagnosticar bugs en el código\n` +
  `- Ejecutar reparación autónoma (read + fix + build + restart)\n` +
  `- Ver o restaurar backups de código\n` +
  `Palabras clave: "repárate", "hay un error en tu código", "diagnostica", "ver logs", "auto-reparar", "rollback"\n\n` +
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd c:/Users/ACER/Jarvis-V2
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts
git commit -m "feat: register browser_control and self_repair in tool registry"
```

---

## Task 6: Handle screenshots in Telegram bot

**Files:**
- Modify: `src/bot/telegram.ts`

- [ ] **Step 1: Add InputFile import**

In `src/bot/telegram.ts`, add `InputFile` to the grammy import:

```typescript
import { Bot, Context, session, SessionFlavor, InputFile } from "grammy";
```

- [ ] **Step 2: Import screenshotStore**

After the existing imports in `src/bot/telegram.ts`, add:

```typescript
import { screenshotStore } from "../tools/browser_control.js";
```

- [ ] **Step 3: Add sendAgentResponse helper**

After the `sendLong` function (around line 75), add this new helper:

```typescript
async function sendAgentResponse(ctx: BotCtx, response: string, chatId: string): Promise<void> {
  // Check if browser_control tool saved a screenshot for this chat
  const screenshotPath = screenshotStore.get(chatId);
  if (screenshotPath) {
    screenshotStore.delete(chatId);
    try {
      await ctx.replyWithPhoto(new InputFile(screenshotPath));
    } catch (err) {
      console.error("[BOT] Error enviando screenshot:", (err as Error).message);
    }
  }
  await sendLong(ctx, response);
}
```

- [ ] **Step 4: Replace sendLong with sendAgentResponse in the message:text handler**

In the `bot.on("message:text", ...)` handler, find the line:
```typescript
      await sendLong(ctx, response);
```
(the one inside the normal agent flow try block, after the `result.warning` check)

Replace it with:
```typescript
      await sendAgentResponse(ctx, response, chatId);
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd c:/Users/ACER/Jarvis-V2
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bot/telegram.ts
git commit -m "feat: send browser screenshots as Telegram photos"
```

---

## Task 7: Auto-trigger self_repair in agent.ts

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Add self_repair import**

At the top of `src/agent.ts`, after the existing imports, add:

```typescript
import { selfRepairTool } from "./tools/self_repair.js";
```

- [ ] **Step 2: Add auto-trigger helper function**

After the `isFatalError` function (around line 50), add:

```typescript
/**
 * Fires self-repair in background if tool errors look like fixable code bugs.
 * Does NOT await — repair happens async, notifies via Telegram.
 */
function maybeAutoRepair(
  lastToolErrors: Map<string, string>,
  userId: string
): void {
  if (lastToolErrors.size === 0) return;

  // Don't trigger repair for auth/config errors — those need human intervention
  const allErrors = [...lastToolErrors.values()].join(" ");
  if (isFatalError(allErrors)) return;

  // Only trigger if there are real runtime errors (not "comando no permitido")
  const hasRuntimeError = [...lastToolErrors.values()].some(
    e => e.includes("TypeError") || e.includes("Error:") || e.includes("Cannot read") || e.includes("undefined")
  );
  if (!hasRuntimeError) return;

  console.log("[AGENT] Auto-triggering self_repair for user", userId);
  selfRepairTool.execute({ action: "repair" }, userId).catch(err => {
    console.error("[AGENT] Auto-repair failed:", err.message);
  });
}
```

- [ ] **Step 3: Call maybeAutoRepair at circuit breaker exit points**

In `src/agent.ts`, find the MAX_LOOP_BREAKS circuit breaker block that returns the final error:

```typescript
        if (loopBreaks >= MAX_LOOP_BREAKS) {
          return {
            response:  `⚠️ No puedo completar esta tarea: '${toolName}' fue llamada ${currentCount} veces sin éxito.${errInfo}\n\n${lastErr ? "Causa: " + lastErr : "Reformula tu solicitud con más detalle."}`,
```

Before that `return {`, add:
```typescript
          maybeAutoRepair(lastToolErrors, String(userId));
```

Do the same for the other two `loopBreaks >= MAX_LOOP_BREAKS` return blocks (consecutive same args and alternating loop). Each block gets `maybeAutoRepair(lastToolErrors, String(userId));` added right before its `return {`.

- [ ] **Step 4: Call maybeAutoRepair at MAX_ITERATIONS exit**

Find the final return at the bottom of the while loop:

```typescript
  console.error(`[AGENT] MAX_ITERATIONS (${MAX_ITERATIONS}) alcanzado`);
  return {
    response:  "⚠️ Límite de iteraciones alcanzado...",
```

Before that `return {`, add:
```typescript
  maybeAutoRepair(lastToolErrors, String(userId));
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd c:/Users/ACER/Jarvis-V2
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent.ts
git commit -m "feat: auto-trigger self_repair on circuit breaker and max iterations"
```

---

## Task 8: Build and push to GitHub

- [ ] **Step 1: Full build locally**

```bash
cd c:/Users/ACER/Jarvis-V2
npm run build
```

Expected: `dist/` updated, no TypeScript errors.

- [ ] **Step 2: Push to GitHub**

```bash
git push origin main
```

---

## Task 9: Deploy on server

SSH into the server and run:

- [ ] **Step 1: Pull latest code**

```bash
cd /opt/jarvis/jarvis-v2
git pull origin main
```

- [ ] **Step 2: Install dependencies (includes playwright)**

```bash
npm install
```

- [ ] **Step 3: Install Playwright Chromium with system dependencies**

```bash
npx playwright install chromium --with-deps
```

Expected: downloads Chromium + required system libs. May take 2-3 minutes.

- [ ] **Step 4: Create backups directory**

```bash
mkdir -p /opt/jarvis/backups
```

- [ ] **Step 5: Add new env vars to .env**

```bash
echo "BACKUPS_DIR=/opt/jarvis/backups" >> /opt/jarvis/jarvis-v2/.env
# WINDOWS_AGENT_URL — leave blank for now (server-only mode)
# WINDOWS_AGENT_SECRET — leave blank for now
```

- [ ] **Step 6: Build and restart**

```bash
npm run build && export $(grep -v '^#' .env | xargs) && pm2 restart jarvis-v2 --update-env
```

- [ ] **Step 7: Verify running**

```bash
pm2 status
pm2 logs jarvis-v2 --lines 20
```

Expected: `jarvis-v2` status `online`, no startup errors.

---

## Task 10: Test via Telegram

- [ ] **Test 1: Browser navigate + screenshot**

Send in Telegram:
```
entra a https://example.com y toma un screenshot
```
Expected: Jarvis navega, responde confirmación, y envía una foto (screenshot) en el chat.

- [ ] **Test 2: Login flow**

Send in Telegram:
```
entra a https://github.com/login y haz login con usuario test@test.com y contraseña test123
```
Expected: Jarvis ejecuta la secuencia de login y reporta la URL resultante.

- [ ] **Test 3: Self-repair read_logs**

Send in Telegram:
```
lee los últimos 30 líneas de logs de error
```
Expected: Jarvis devuelve los logs de PM2.

- [ ] **Test 4: Self-repair diagnose**

Send in Telegram:
```
diagnostica si hay algún error en tu código
```
Expected: Jarvis lee logs, llama Claude, responde con diagnóstico en español.

- [ ] **Test 5: List backups**

Send in Telegram:
```
muéstrame los backups de código disponibles
```
Expected: lista de archivos .bak (o "No hay backups aún" si nunca se ha reparado).

- [ ] **Test 6: Windows agent (opcional — solo si tienes la PC disponible)**

```bash
# En Windows PC, en server/windows-agent/
npm install
WINDOWS_AGENT_SECRET=tu-secreto npx tsx index.ts
```

En .env del servidor: `WINDOWS_AGENT_URL=http://TU-IP-LOCAL:3001`

Send in Telegram:
```
abre google.com en modo windows y toma un screenshot
```
Expected: Chrome visible en la PC, screenshot enviado a Telegram.
