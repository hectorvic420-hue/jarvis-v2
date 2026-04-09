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
const PORT              = process.env.PORT ?? 8080;
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;

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
    await execAsync(`git add "${relPath}"`, { cwd: PROJECT_ROOT, timeout: 30_000 });
    await execAsync(
      `git commit -m "watchdog-repair(${relPath}): ${summary.replace(/["`]/g, "'").slice(0, 60)}"`,
      { cwd: PROJECT_ROOT, timeout: 30_000 }
    );
    const { stdout } = await execAsync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, timeout: 10_000 });
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
    let infraOk = false;
    try {
      await infra.fix();
      infraOk = true;
    } catch (err) {
      await notifyTelegram(`❌ *Watchdog:* infra fix (${infra.type}) falló: ${err.message.slice(0, 200)}`);
    }
    if (infraOk) {
      try {
        await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
      } catch {}
      recordRepair();
      await notifyTelegram(`✅ *Watchdog:* reparé infra (${infra.type}) y reinicié Jarvis.`);
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

// ─── Agent health check ───────────────────────────────────────────────────────
let lastErrorRateNotification = 0;

async function checkAgentHealth() {
  try {
    const res = await fetch(`http://localhost:${PORT}/health`, { timeout: 10_000 });
    if (!res.ok) {
      console.log(`[watchdog] Health check falló: status ${res.status}`);
      await notifyTelegram(`⚠️ *Health check falló:* HTTP ${res.status}`);
      return;
    }

    const data = await res.json();
    if (data.status !== "ok") {
      console.log(`[watchdog] Health check falló: status ${data.status}`);
      await notifyTelegram(`⚠️ *Health check falló:* status ${data.status}`);
      return;
    }

    const { lastRuns } = data;
    if (lastRuns && lastRuns.errors_1h > 10 && lastRuns.total_1h > 0) {
      const errorRate = lastRuns.errors_1h / lastRuns.total_1h;
      if (errorRate > 0.5) {
        const now = Date.now();
        if (now - lastErrorRateNotification > 3_600_000) {
          lastErrorRateNotification = now;
          await notifyTelegram(`⚠️ *Jarvis tiene >50% tasa de error en la última hora*\nErrores: ${lastRuns.errors_1h}/${lastRuns.total_1h}`);
        }
      }
    }
  } catch (err) {
    console.log(`[watchdog] Health check falló: ${err.message}`);
    await notifyTelegram(`⚠️ *Health check falló:* ${err.message.slice(0, 100)}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────
console.log("[watchdog] Started — checking jarvis-v2 every 30s");
checkOnce();
setInterval(checkOnce, CHECK_INTERVAL_MS);

console.log("[watchdog] Health check every 5 minutes");
checkAgentHealth();
setInterval(checkAgentHealth, HEALTH_INTERVAL_MS);
