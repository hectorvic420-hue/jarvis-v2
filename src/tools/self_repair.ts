import Anthropic            from "@anthropic-ai/sdk";
import { exec }             from "child_process";
import { promisify }        from "util";
import * as fs              from "fs";
import * as path            from "path";
import db                   from "../memory/db.js";
import { detectInfraIssue, runInfraFix } from "./infra_repair.js";
import { commitRepair }                   from "../shared/git_utils.js";
import { Tool }             from "../shared/types.js";
import { PathValidator, PathTraversalError } from "../security/pathValidator.js";
import { RateLimiter }      from "../security/rateLimiter.js";

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────
const PROJECT_ROOT  = process.env.JARVIS_ROOT  ?? "/opt/jarvis/jarvis-v2";
const BACKUPS_DIR   = process.env.BACKUPS_DIR  ?? "/opt/jarvis/backups";
const PM2_LOG       = path.join(process.env.HOME ?? "", ".pm2/logs/jarvis-v2-error.log");
const MAX_REPAIRS_PER_HOUR = 3;

const pathValidator = new PathValidator({
  projectRoot: PROJECT_ROOT,
  allowedExtensions: ['.ts', '.js', '.json'],
  allowNonExistent: true,   // Permitimos crear archivos nuevos
  followSymlinks: false,
});

const repairLimiter = new RateLimiter(); // Usa store en memoria

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

async function extractFilesFromStack(logs: string): Promise<string[]> {
  const srcRegex  = /\/opt\/jarvis\/jarvis-v2\/src\/([\w/.-]+\.ts)/g;
  const distRegex = /\/opt\/jarvis\/jarvis-v2\/dist\/([\w/.-]+\.js)/g;

  const rawFiles = new Set<string>();

  for (const match of logs.matchAll(srcRegex)) {
    rawFiles.add(`src/${match[1]}`);
  }
  for (const match of logs.matchAll(distRegex)) {
    const src = match[1].replace(/\.js$/, ".ts");
    rawFiles.add(`src/${src}`);
  }

  // Validar cada archivo extraído contra PathValidator
  const validFiles: string[] = [];
  for (const file of rawFiles) {
    const validation = pathValidator.validate(file);
    if (validation.isOk()) {
      validFiles.push(file);
    } else {
      console.warn(`[SECURITY] Archivo inválido detectado en logs: ${file} — ${validation.error.message}`);
      if (validation.error instanceof PathTraversalError) {
        await notifyTelegram("admin", `🚨 Intento de path traversal detectado en logs: ${file}`);
      }
    }
  }

  return validFiles.slice(0, 3);
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

function backupFile(absolutePath: string): string {
  // Validar que el archivo a respaldar es válido dentro del proyecto
  const fileValidation = pathValidator.validate(path.relative(PROJECT_ROOT, absolutePath));
  if (fileValidation.isErr()) {
    throw new Error(`Archivo inválido para backup: ${fileValidation.error.message}`);
  }

  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const filename   = path.basename(absolutePath);
  const backupPath = path.join(BACKUPS_DIR, `${filename}-${Date.now()}.bak`);
  fs.copyFileSync(absolutePath, backupPath);
  return backupPath;
}

// ─── Core repair logic ────────────────────────────────────────────────────────
async function runRepair(chatId: string): Promise<string> {
  // Rate limiting — máximo 3 reparaciones por hora por usuario
  const rateCheck = await repairLimiter.checkLimit(chatId, 'self_repair');
  if (rateCheck.isErr()) {
    const retryAfterSeconds = (rateCheck as any).error.retryAfterSeconds as number;
    await notifyTelegram(chatId,
      `⏳ Rate limit: Máximo 3 reparaciones por hora. Reintenta en ${retryAfterSeconds}s.`
    );
    return `⏳ Límite de reparaciones alcanzado. Espera ${Math.ceil(retryAfterSeconds / 60)} minutos.`;
  }

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
    if (infraResult.startsWith("✅")) {
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
  let affectedFiles = await extractFilesFromStack(logs);
  if (affectedFiles.length === 0) affectedFiles = ["src/agent.ts"];

  const targetRelPath = affectedFiles[0];

  // Validación con PathValidator (reemplaza el check de startsWith)
  const pathValidation = pathValidator.validate(targetRelPath);
  if (pathValidation.isErr()) {
    console.error(`[SECURITY] Validación de path falló: ${pathValidation.error.message}`);
    return `❌ Error de seguridad: ${pathValidation.error.message}`;
  }

  const targetAbsPath = pathValidation.value;

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
        const affectedFiles = await extractFilesFromStack(logs);

        const codeContext = buildCodeContext(affectedFiles);

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
