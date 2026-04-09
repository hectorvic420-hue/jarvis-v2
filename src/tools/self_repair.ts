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

function backupFile(absolutePath: string): string {
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const filename   = path.basename(absolutePath);
  const backupPath = path.join(BACKUPS_DIR, `${filename}-${Date.now()}.bak`);
  fs.copyFileSync(absolutePath, backupPath);
  return backupPath;
}

// ─── Core repair logic ────────────────────────────────────────────────────────
async function runRepair(chatId: string): Promise<string> {
  const recentCount = getRepairsInLastHour();
  if (recentCount >= MAX_REPAIRS_PER_HOUR) {
    return `⚠️ Límite de auto-reparaciones alcanzado (${MAX_REPAIRS_PER_HOUR}/hora). Espera antes de intentar de nuevo.`;
  }

  const logs = readLogs(100);
  if (logs.startsWith("⚠️") || logs === "(log vacío)") {
    return "⚠️ No hay logs de error recientes. No hay nada que reparar.";
  }

  const affectedFiles = extractFilesFromStack(logs);
  if (affectedFiles.length === 0) {
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

  const backupPath = backupFile(targetAbsPath);
  fs.writeFileSync(targetAbsPath, fixedCode, "utf-8");

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

  try {
    await execAsync("npm run build", { cwd: PROJECT_ROOT, timeout: 120_000 });
    await execAsync("pm2 restart jarvis-v2", { cwd: PROJECT_ROOT, timeout: 30_000 });
  } catch (err) {
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
