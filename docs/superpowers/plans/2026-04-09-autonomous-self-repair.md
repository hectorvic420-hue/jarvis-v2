# Autonomous Self-Repair v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Jarvis V2 fully autonomous — a watchdog PM2 process detects crashes and auto-repairs, infra errors (Chromium, disk, permissions) are fixed automatically, every successful repair commits to git, and the repair engine has broader code context.

**Architecture:** Four focused modules: `git_utils.ts` (commit helper), `infra_repair.ts` (pattern detection + shell fixes), modified `self_repair.ts` (integrates both, wider context, npm install), and `server/watchdog/watchdog.js` (pure JS PM2 process that monitors and repairs Jarvis when it's dead). Infra check always runs before code repair. Watchdog duplicates infra patterns as JS since it can't import TypeScript.

**Tech Stack:** TypeScript, Node.js, PM2, Claude API (SDK in self_repair, raw fetch in watchdog), SQLite (existing), git CLI

---

### Task 1: `src/shared/git_utils.ts` — commit helper

**Files:**
- Create: `src/shared/git_utils.ts`

- [ ] **Step 1: Create `src/shared/git_utils.ts`**

```typescript
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.env.JARVIS_ROOT ?? "/opt/jarvis/jarvis-v2";

export async function commitRepair(filePath: string, summary: string): Promise<string | null> {
  try {
    const relPath = path.relative(PROJECT_ROOT, filePath);
    await execAsync(`git add "${relPath}"`, { cwd: PROJECT_ROOT });
    await execAsync(
      `git commit -m "auto-repair(${relPath}): ${summary.replace(/["`]/g, "'").slice(0, 60)}"`,
      { cwd: PROJECT_ROOT }
    );
    const { stdout } = await execAsync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT });
    return stdout.trim();
  } catch (err) {
    console.error("[git_utils] commit failed (non-blocking):", (err as Error).message);
    return null;
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/git_utils.ts
git commit -m "feat: add git_utils commitRepair helper"
```

---

### Task 2: `src/tools/infra_repair.ts` — pattern detection and auto-fix

**Files:**
- Create: `src/tools/infra_repair.ts`

- [ ] **Step 1: Create `src/tools/infra_repair.ts`**

```typescript
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.env.JARVIS_ROOT ?? "/opt/jarvis/jarvis-v2";

export interface InfraIssue {
  type: "chromium" | "disk_full" | "permission" | "network";
  description: string;
  fix?: () => Promise<void>;
  suggestedCommand?: string;
}

const INFRA_PATTERNS: Array<{ patterns: RegExp[]; issue: () => InfraIssue }> = [
  {
    patterns: [/resources\.pak corruption/i, /V8 startup snapshot/i, /chrome.*FATAL/i],
    issue: () => ({
      type: "chromium",
      description: "Chromium installation corrupted",
      fix: async () => {
        const home = process.env.HOME ?? "/root";
        await execAsync(`rm -rf ${home}/.cache/ms-playwright/`, { timeout: 30_000 });
        await execAsync("npx playwright install chromium", {
          cwd: PROJECT_ROOT,
          timeout: 300_000,
        });
      },
    }),
  },
  {
    patterns: [/ENOSPC/i, /no space left on device/i],
    issue: () => ({
      type: "disk_full",
      description: "Disk is full — cleared /tmp and PM2 logs",
      fix: async () => {
        await execAsync("rm -rf /tmp/jarvis-screenshots/* 2>/dev/null || true");
        await execAsync("pm2 flush 2>/dev/null || true");
        await execAsync("find /tmp -name '*.tmp' -mtime +1 -delete 2>/dev/null || true");
      },
    }),
  },
  {
    patterns: [/EACCES/i, /permission denied/i],
    issue: () => ({
      type: "permission",
      description: "Permission denied on a file",
      suggestedCommand: "Check permissions with: ls -la <file> and fix with chmod/chown",
    }),
  },
  {
    patterns: [/ECONNREFUSED/i, /getaddrinfo ENOTFOUND/i, /network unreachable/i],
    issue: () => ({
      type: "network",
      description: "Network connectivity issue — cannot reach external services",
      suggestedCommand: "Check network with: ping 8.8.8.8 && curl https://api.anthropic.com",
    }),
  },
];

export function detectInfraIssue(logs: string): InfraIssue | null {
  for (const { patterns, issue } of INFRA_PATTERNS) {
    if (patterns.some((p) => p.test(logs))) {
      return issue();
    }
  }
  return null;
}

export async function runInfraFix(issue: InfraIssue): Promise<string> {
  if (issue.fix) {
    try {
      await issue.fix();
      return `✅ Infra fix aplicado: ${issue.description}`;
    } catch (err) {
      return `❌ Infra fix falló: ${(err as Error).message.slice(0, 200)}`;
    }
  }
  return `⚠️ ${issue.description}. ${issue.suggestedCommand ?? "Requiere intervención manual."}`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/infra_repair.ts
git commit -m "feat: add infra_repair pattern detection and auto-fix"
```

---

### Task 3: Modify `src/tools/self_repair.ts` — integrate git, infra, wider context

**Files:**
- Modify: `src/tools/self_repair.ts`

Changes: (1) add imports, (2) replace `extractFilesFromStack` + add `buildCodeContext`, (3) replace `runRepair`, (4) update `diagnose` case.

- [ ] **Step 1: Add two imports after the existing import block (after line 8)**

Add these two lines after `import db from "../memory/db.js";`:

```typescript
import { detectInfraIssue, runInfraFix } from "./infra_repair.js";
import { commitRepair }                   from "../shared/git_utils.js";
```

- [ ] **Step 2: Replace `extractFilesFromStack` and add `buildCodeContext` (lines 60–75)**

Replace the entire `extractFilesFromStack` function with:

```typescript
function extractFilesFromStack(logs: string): string[] {
  const srcRegex  = /\/opt\/jarvis\/jarvis-v2\/src\/([\w/.-]+\.ts)/g;
  const distRegex = /\/opt\/jarvis\/jarvis-v2\/dist\/([\w/.-]+\.js)/g;

  const files = new Set<string>();

  for (const match of logs.matchAll(srcRegex)) {
    files.add(`src/${match[1]}`);
  }
  for (const match of logs.matchAll(distRegex)) {
    const src = match[1].replace(/\.js$/, ".ts");
    files.add(`src/${src}`);
  }

  return [...files].slice(0, 3);
}

const CRITICAL_FILES = ["src/agent.ts", "src/index.ts", "src/llm.ts"];

function buildCodeContext(affectedFiles: string[]): string {
  const filesToRead = [...new Set([...affectedFiles, "src/agent.ts"])].slice(0, 4);
  for (const f of CRITICAL_FILES) {
    if (filesToRead.length >= 4) break;
    if (!filesToRead.includes(f)) filesToRead.push(f);
  }

  let context = "";
  for (const f of filesToRead) {
    const abs = path.join(PROJECT_ROOT, f);
    if (fs.existsSync(abs)) {
      context += `\n\n--- ${f} ---\n${fs.readFileSync(abs, "utf-8").slice(0, 6_000)}`;
    }
  }
  return context;
}
```

- [ ] **Step 3: Replace the entire `runRepair` function (lines 86–198)**

```typescript
async function runRepair(chatId: string): Promise<string> {
  const recentCount = getRepairsInLastHour();
  if (recentCount >= MAX_REPAIRS_PER_HOUR) {
    return `⚠️ Límite de auto-reparaciones alcanzado (${MAX_REPAIRS_PER_HOUR}/hora). Espera antes de intentar de nuevo.`;
  }

  const logs = readLogs(100);
  if (logs.startsWith("⚠️") || logs === "(log vacío)") {
    return "⚠️ No hay logs de error recientes. No hay nada que reparar.";
  }

  // ── Infra check first ────────────────────────────────────────────────────────
  const infraIssue = detectInfraIssue(logs);
  if (infraIssue) {
    const infraResult = await runInfraFix(infraIssue);
    if (infraIssue.fix) {
      try {
        await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
      } catch { /* best-effort */ }
      await notifyTelegram(chatId,
        `✅ *Auto-reparación de infra*\nTipo: \`${infraIssue.type}\`\n${infraResult}`
      );
    } else {
      await notifyTelegram(chatId, `⚠️ *Problema de infra detectado*\n${infraResult}`);
    }
    return infraResult;
  }

  // ── npm install if missing module ────────────────────────────────────────────
  if (logs.includes("Cannot find module")) {
    try {
      await execAsync("npm install", { cwd: PROJECT_ROOT, timeout: 120_000 });
    } catch (err) {
      return `❌ npm install falló: ${(err as Error).message.slice(0, 200)}`;
    }
  }

  // ── Identify affected files ──────────────────────────────────────────────────
  let affectedFiles = extractFilesFromStack(logs);
  if (affectedFiles.length === 0) affectedFiles = ["src/agent.ts"];

  const targetRelPath = affectedFiles[0];
  const targetAbsPath = path.join(PROJECT_ROOT, targetRelPath);

  if (!targetAbsPath.startsWith(path.join(PROJECT_ROOT, "src"))) {
    return `❌ Por seguridad, solo puedo editar archivos en src/. Detecté: ${targetRelPath}`;
  }
  if (!fs.existsSync(targetAbsPath)) {
    return `❌ Archivo no encontrado: ${targetAbsPath}`;
  }

  const originalCode = fs.readFileSync(targetAbsPath, "utf-8");
  const codeContext  = buildCodeContext(affectedFiles);

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let fixedCode: string;
  let fixSummary: string;
  try {
    const [fixMsg, summaryMsg] = await Promise.all([
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system:
          "You are fixing a bug in Jarvis V2, a TypeScript/Node.js Telegram bot. " +
          "Return ONLY the complete corrected TypeScript file for the PRIMARY file — " +
          "no explanation, no markdown fences, just raw TypeScript.",
        messages: [{
          role: "user",
          content:
            `ERROR LOGS (last 100 lines):\n${logs}\n\n` +
            `PRIMARY FILE TO FIX (${targetRelPath}):\n${originalCode}\n\n` +
            `CONTEXT FILES:${codeContext}\n\n` +
            "Fix the bug in the PRIMARY FILE. Return ONLY its complete corrected TypeScript.",
        }],
      }),
      anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 128,
        messages: [{
          role: "user",
          content:
            `Generate a git commit message suffix (under 60 chars, no quotes) describing this repair:\n` +
            `File: ${targetRelPath}\nError summary: ${logs.slice(0, 300)}`,
        }],
      }),
    ]);

    fixedCode  = (fixMsg.content[0]     as { type: string; text: string }).text.trim();
    fixSummary = (summaryMsg.content[0] as { type: string; text: string }).text.trim().slice(0, 60);
  } catch (err) {
    logRepair("repair_failed", targetRelPath, undefined, (err as Error).message);
    return `❌ Claude API falló al generar fix: ${(err as Error).message}`;
  }

  const backupPath = backupFile(targetAbsPath);
  fs.writeFileSync(targetAbsPath, fixedCode, "utf-8");

  // ── Compile check ────────────────────────────────────────────────────────────
  let compileOk = false;
  let compileError = "";
  try {
    await execAsync("npx tsc --noEmit", { cwd: PROJECT_ROOT, timeout: 60_000 });
    compileOk = true;
  } catch (err) {
    compileError = ((err as Error & { stderr?: string }).stderr ?? (err as Error).message).slice(0, 500);
  }

  if (!compileOk) {
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

  // ── Build and restart ────────────────────────────────────────────────────────
  try {
    await execAsync("npm run build", { cwd: PROJECT_ROOT, timeout: 120_000 });
    await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
  } catch (err) {
    fs.copyFileSync(backupPath, targetAbsPath);
    const buildErr = (err as Error).message.slice(0, 300);
    logRepair("repair_build_error", targetRelPath, backupPath, logs.slice(0, 300), buildErr);
    await notifyTelegram(chatId,
      `⚠️ *Auto-reparación: build falló*\n` +
      `Restauré el original de: \`${targetRelPath}\`\nError: \`${buildErr}\``
    );
    return `❌ Fix compiló pero el build falló. Restauré el original.\nError: ${buildErr}`;
  }

  // ── Git commit ───────────────────────────────────────────────────────────────
  const commitHash = await commitRepair(targetAbsPath, fixSummary);
  logRepair("repair_success", targetRelPath, backupPath, logs.slice(0, 300), fixSummary);

  await notifyTelegram(chatId,
    `✅ *Me reparé exitosamente*\n` +
    `Archivo: \`${targetRelPath}\`\n` +
    `Backup: \`${backupPath}\`\n` +
    `Commit: \`${commitHash ?? "sin git"}\`\n` +
    `Fix: ${fixSummary}`
  );

  return `✅ Reparación exitosa.\nArchivo: ${targetRelPath}\nCommit: ${commitHash ?? "sin git"}\nFix: ${fixSummary}`;
}
```

- [ ] **Step 4: Update `diagnose` case to use `buildCodeContext`**

Inside the `diagnose` case, find and replace this block:

```typescript
let codeContext = "";
for (const f of affectedFiles) {
  const abs = path.join(PROJECT_ROOT, f);
  if (fs.existsSync(abs)) {
    codeContext += `\n\n--- ${f} ---\n${fs.readFileSync(abs, "utf-8").slice(0, 3000)}`;
  }
}
```

With:

```typescript
const codeContext = buildCodeContext(affectedFiles);
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/tools/self_repair.ts
git commit -m "feat: self_repair integrates infra fix, git commit, wider code context"
```

---

### Task 4: `server/watchdog/watchdog.js` — standalone PM2 crash detector

**Files:**
- Create: `server/watchdog/watchdog.js`

Pure CommonJS JavaScript — no TypeScript dependency. Survives even when Jarvis's build is broken.

- [ ] **Step 1: Create `server/watchdog/watchdog.js`**

```javascript
"use strict";

const { exec }      = require("child_process");
const { promisify } = require("util");
const fs            = require("fs");
const path          = require("path");

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_ROOT      = process.env.JARVIS_ROOT          ?? "/opt/jarvis/jarvis-v2";
const BOT_TOKEN         = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID     = process.env.TELEGRAM_OWNER_CHAT_ID;
const ANTHROPIC_KEY     = process.env.ANTHROPIC_API_KEY;
const RATE_LIMIT_FILE   = "/tmp/watchdog-repairs.json";
const MAX_REPAIRS_HOUR  = 3;
const CHECK_INTERVAL_MS = 30_000;

// ─── Rate limiter ──────────────────────────────────────────────────────────────
function getRepairsInLastHour() {
  try {
    if (!fs.existsSync(RATE_LIMIT_FILE)) return 0;
    const data   = JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, "utf-8"));
    const cutoff = Date.now() - 3_600_000;
    return (data.repairs ?? []).filter(t => t > cutoff).length;
  } catch { return 0; }
}

function recordRepair() {
  try {
    const cutoff = Date.now() - 3_600_000;
    let data = { repairs: [] };
    if (fs.existsSync(RATE_LIMIT_FILE)) {
      data = JSON.parse(fs.readFileSync(RATE_LIMIT_FILE, "utf-8"));
    }
    data.repairs = (data.repairs ?? []).filter(t => t > cutoff);
    data.repairs.push(Date.now());
    fs.writeFileSync(RATE_LIMIT_FILE, JSON.stringify(data));
  } catch {}
}

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function notifyTelegram(message) {
  if (!BOT_TOKEN || !OWNER_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: OWNER_CHAT_ID, text: message, parse_mode: "Markdown" }),
    });
  } catch {}
}

// ─── PM2 logs ─────────────────────────────────────────────────────────────────
function readPm2Logs(lines = 100) {
  try {
    const logPath = path.join(process.env.HOME ?? "/root", ".pm2/logs/jarvis-v2-error.log");
    if (!fs.existsSync(logPath)) return "";
    const content = fs.readFileSync(logPath, "utf-8");
    return content.split("\n").slice(-lines).join("\n");
  } catch { return ""; }
}

// ─── Stack trace parser ───────────────────────────────────────────────────────
function extractFilesFromStack(logs) {
  const srcRegex  = /\/opt\/jarvis\/jarvis-v2\/src\/([\w/.-]+\.ts)/g;
  const distRegex = /\/opt\/jarvis\/jarvis-v2\/dist\/([\w/.-]+\.js)/g;
  const files = new Set();
  for (const m of logs.matchAll(srcRegex))  files.add(`src/${m[1]}`);
  for (const m of logs.matchAll(distRegex)) files.add(`src/${m[1].replace(/\.js$/, ".ts")}`);
  return [...files].slice(0, 3);
}

// ─── Infra patterns (mirrors infra_repair.ts) ─────────────────────────────────
const INFRA_PATTERNS = [
  {
    patterns: [/resources\.pak corruption/i, /V8 startup snapshot/i, /chrome.*FATAL/i],
    type: "chromium",
    async fix() {
      const home = process.env.HOME ?? "/root";
      await execAsync(`rm -rf ${home}/.cache/ms-playwright/`, { timeout: 30_000 });
      await execAsync("npx playwright install chromium", { cwd: PROJECT_ROOT, timeout: 300_000 });
    },
  },
  {
    patterns: [/ENOSPC/i, /no space left on device/i],
    type: "disk_full",
    async fix() {
      await execAsync("rm -rf /tmp/jarvis-screenshots/* 2>/dev/null || true");
      await execAsync("pm2 flush 2>/dev/null || true");
      await execAsync("find /tmp -name '*.tmp' -mtime +1 -delete 2>/dev/null || true");
    },
  },
];

function detectInfraIssue(logs) {
  for (const p of INFRA_PATTERNS) {
    if (p.patterns.some(r => r.test(logs))) return p;
  }
  return null;
}

// ─── Claude API (raw fetch — no SDK dependency) ───────────────────────────────
async function callClaude(system, userMsg, maxTokens = 8192) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system,
      messages:   [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.content[0].text;
}

// ─── Git commit ───────────────────────────────────────────────────────────────
async function commitFix(relPath, summary) {
  try {
    await execAsync(`git add "${relPath}"`, { cwd: PROJECT_ROOT });
    await execAsync(
      `git commit -m "watchdog-repair(${relPath}): ${summary.replace(/["`]/g, "'").slice(0, 60)}"`,
      { cwd: PROJECT_ROOT }
    );
    const { stdout } = await execAsync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT });
    return stdout.trim();
  } catch { return null; }
}

// ─── Main repair ──────────────────────────────────────────────────────────────
async function repairJarvis(logs) {
  if (getRepairsInLastHour() >= MAX_REPAIRS_HOUR) {
    await notifyTelegram("⚠️ *Watchdog:* límite de reparaciones alcanzado (3/hora). Intervención manual requerida.");
    return;
  }

  // Infra check first
  const infra = detectInfraIssue(logs);
  if (infra) {
    try {
      await infra.fix();
      await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
      recordRepair();
      await notifyTelegram(`✅ *Watchdog:* reparé infra (${infra.type}) y reinicié Jarvis.`);
    } catch (err) {
      await notifyTelegram(`❌ *Watchdog:* infra fix falló: ${err.message.slice(0, 200)}`);
    }
    return;
  }

  // npm install if missing module
  if (logs.includes("Cannot find module")) {
    try { await execAsync("npm install", { cwd: PROJECT_ROOT, timeout: 120_000 }); } catch {}
  }

  // Code fix
  let affectedFiles = extractFilesFromStack(logs);
  if (affectedFiles.length === 0) affectedFiles = ["src/agent.ts"];

  const targetRelPath = affectedFiles[0];
  const targetAbsPath = path.join(PROJECT_ROOT, targetRelPath);
  if (!fs.existsSync(targetAbsPath)) {
    await notifyTelegram(`❌ *Watchdog:* no encontré archivo a reparar: ${targetRelPath}`);
    return;
  }

  const originalCode = fs.readFileSync(targetAbsPath, "utf-8");
  let agentContext = "";
  const agentAbs = path.join(PROJECT_ROOT, "src/agent.ts");
  if (fs.existsSync(agentAbs) && agentAbs !== targetAbsPath) {
    agentContext = `\n\n--- src/agent.ts ---\n${fs.readFileSync(agentAbs, "utf-8").slice(0, 6_000)}`;
  }

  let fixedCode, fixSummary;
  try {
    [fixedCode, fixSummary] = await Promise.all([
      callClaude(
        "You are fixing a bug in Jarvis V2, a TypeScript/Node.js Telegram bot. " +
        "Return ONLY the complete corrected TypeScript file — no explanation, no markdown fences, just raw TypeScript.",
        `ERROR LOGS:\n${logs}\n\nPRIMARY FILE (${targetRelPath}):\n${originalCode}\n\nCONTEXT:${agentContext}\n\nFix the PRIMARY FILE. Return ONLY its complete corrected TypeScript.`
      ),
      callClaude(
        "Generate a short git commit message suffix (under 60 chars, no quotes) describing the fix.",
        `File: ${targetRelPath}\nError: ${logs.slice(0, 400)}`,
        128
      ),
    ]);
    fixedCode  = fixedCode.trim();
    fixSummary = fixSummary.trim().slice(0, 60);
  } catch (err) {
    await notifyTelegram(`❌ *Watchdog:* Claude API falló: ${err.message.slice(0, 200)}`);
    return;
  }

  // Backup
  const backupsDir = process.env.BACKUPS_DIR ?? "/opt/jarvis/backups";
  fs.mkdirSync(backupsDir, { recursive: true });
  const backupPath = path.join(backupsDir, `${path.basename(targetAbsPath)}-${Date.now()}.bak`);
  fs.copyFileSync(targetAbsPath, backupPath);
  fs.writeFileSync(targetAbsPath, fixedCode, "utf-8");

  // Compile check
  try {
    await execAsync("npx tsc --noEmit", { cwd: PROJECT_ROOT, timeout: 60_000 });
  } catch (err) {
    fs.copyFileSync(backupPath, targetAbsPath);
    await notifyTelegram(`❌ *Watchdog:* fix no compila, restauré original.\n\`${(err.stderr ?? err.message).slice(0, 200)}\``);
    return;
  }

  // Build + restart
  try {
    await execAsync("npm run build",        { cwd: PROJECT_ROOT, timeout: 120_000 });
    await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000  });
  } catch (err) {
    fs.copyFileSync(backupPath, targetAbsPath);
    await notifyTelegram(`❌ *Watchdog:* build falló, restauré original.\n\`${err.message.slice(0, 200)}\``);
    return;
  }

  recordRepair();
  const hash = await commitFix(targetRelPath, fixSummary);
  await notifyTelegram(
    `✅ *Watchdog auto-reparó Jarvis*\n` +
    `Archivo: \`${targetRelPath}\`\n` +
    `Commit: \`${hash ?? "sin git"}\`\n` +
    `Fix: ${fixSummary}`
  );
}

// ─── Check loop ───────────────────────────────────────────────────────────────
async function checkOnce() {
  let pm2Status;
  try {
    const { stdout } = await execAsync("pm2 jlist");
    const procs = JSON.parse(stdout);
    const jarvis = procs.find(p => p.name === "jarvis-v2");
    pm2Status = jarvis?.pm2_env?.status;
  } catch { return; }

  if (pm2Status === "online") return;

  console.log(`[watchdog] ${new Date().toISOString()} jarvis-v2 status=${pm2Status} — repairing`);
  const logs = readPm2Logs(100);
  await repairJarvis(logs);
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("[watchdog] Started — checking jarvis-v2 every 30s");
checkOnce();
setInterval(checkOnce, CHECK_INTERVAL_MS);
```

- [ ] **Step 2: Commit**

```bash
git add server/watchdog/watchdog.js
git commit -m "feat: add watchdog process for crash detection and auto-repair"
```

---

### Task 5: `ecosystem.config.js` + deploy to server

**Files:**
- Create: `ecosystem.config.js`

- [ ] **Step 1: Create `ecosystem.config.js` at project root**

```javascript
module.exports = {
  apps: [
    {
      name:   "jarvis-v2",
      script: "dist/index.js",
      cwd:    "/opt/jarvis/jarvis-v2",
      watch:  false,
      env: {
        NODE_ENV: "production",
        PORT:     "8080",
      },
    },
    {
      name:          "jarvis-watchdog",
      script:        "server/watchdog/watchdog.js",
      cwd:           "/opt/jarvis/jarvis-v2",
      watch:         false,
      restart_delay: 5000,
    },
  ],
};
```

- [ ] **Step 2: Commit and push**

```bash
git add ecosystem.config.js
git commit -m "feat: add ecosystem.config.js with jarvis-v2 and jarvis-watchdog"
git push origin main
```

- [ ] **Step 3: Get your Telegram chat ID**

Send any message to `@userinfobot` on Telegram. It will reply with your numeric chat ID (e.g. `123456789`).

- [ ] **Step 4: Deploy on server**

SSH into the server and run:

```bash
cd /opt/jarvis/jarvis-v2

# Pull latest
git pull origin main

# Build TypeScript
npm run build

# Add TELEGRAM_OWNER_CHAT_ID to .env (replace with your actual ID from step 3)
echo "TELEGRAM_OWNER_CHAT_ID=123456789" >> .env

# Reload env and restart jarvis-v2
export $(grep -v '^#' .env | xargs)
pm2 restart jarvis-v2 --update-env

# Start watchdog (new process)
pm2 start ecosystem.config.js --only jarvis-watchdog

# Save process list so both survive reboots
pm2 save

# Verify
pm2 list
```

Expected output: two rows — `jarvis-v2 online` and `jarvis-watchdog online`.

- [ ] **Step 5: Smoke test — simulate a crash**

On the server:

```bash
# Stop jarvis-v2 to simulate crash
pm2 stop jarvis-v2

# Watch watchdog detect it (within 30s)
pm2 logs jarvis-watchdog --lines 30
```

Expected log line: `[watchdog] YYYY-MM-DDTHH:mm:ss.mmmZ jarvis-v2 status=stopped — repairing`

After ~30s:

```bash
pm2 list
```

Expected: `jarvis-v2` back to `online`. You should also receive a Telegram message.

---

## Deployment checklist

- [ ] `TELEGRAM_OWNER_CHAT_ID` added to `.env` on server
- [ ] `pm2 list` shows `jarvis-v2` and `jarvis-watchdog` both `online`
- [ ] `pm2 save` run so both processes survive server reboots
- [ ] Crash simulation test passed (stop + auto-restart within 30s)
- [ ] Telegram notification received during test
