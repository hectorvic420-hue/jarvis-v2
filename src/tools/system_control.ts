import { exec } from "child_process";
import os from "os";
import { promisify } from "util";
import { Tool } from "../shared/types.js";
import { validateCommand } from "../security/commandValidator.js";

const execAsync = promisify(exec);
const MAX_OUTPUT_CHARS = 3000;
const CMD_TIMEOUT_MS = 30000;

export async function runCommand(command: string): Promise<string> {
  const validation = validateCommand(command);

  if (validation.isErr()) {
    const err = validation.error;
    switch (err.code) {
      case 'DANGEROUS_CHARS':
      case 'SENSITIVE_FILE':
      case 'CURL_OUTPUT_BLOCKED':
        return `❌ Comando bloqueado por seguridad: ${err.message}`;
      case 'COMMAND_NOT_ALLOWED':
        return `⚠️ ${err.message}\nComandos permitidos: ls, cat, pwd, echo, df, free, uptime, whoami, pm2, git, npm, curl.`;
      case 'INVALID_FORMAT':
      case 'TOO_MANY_ARGS':
        return `⚠️ ${err.message}`;
      default:
        return `❌ Comando inválido: ${err.message}`;
    }
  }

  try {
    const { stdout, stderr } = await execAsync(validation.value, {
      timeout: CMD_TIMEOUT_MS,
      cwd: process.env.JARVIS_WORK_DIR || process.cwd(),
    });
    const output = (stdout + (stderr ? "\n[stderr]\n" + stderr : "")).trim();
    return output.length > MAX_OUTPUT_CHARS
      ? output.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncado]"
      : output || "(sin salida)";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err ?? "error desconocido");
    return `❌ Error ejecutando comando: ${msg}`;
  }
}

export function getSystemInfo(): string {
  const cpus = os.cpus();
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const uptimeSec = os.uptime();

  return [
    `🖥️ *Información del Sistema*`,
    `OS: ${os.type()} ${os.release()} (${os.arch()})`,
    `CPU: ${cpus[0]?.model ?? "?"} (${cpus.length} núcleos)`,
    `RAM: ${((memTotal - memFree) / 1024 ** 3).toFixed(2)}GB / ${(memTotal / 1024 ** 3).toFixed(2)}GB`,
    `Uptime: ${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`,
    `Node.js: ${process.version}`
  ].join("\n");
}

// ─── Tool exports ─────────────────────────────────────────────────────────────

export const systemControlTool: Tool = {
  name: "system_control",
  description:
    "Ejecuta comandos seguros del sistema operativo y obtiene información del servidor (CPU, RAM, uptime).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run_command", "get_info"],
        description: "run_command: ejecuta un comando; get_info: retorna métricas del sistema",
      },
      command: { type: "string", description: "Comando a ejecutar (solo para run_command)" },
    },
    required: ["action"],
  },
  async execute(params, _chatId) {
    const { action, command } = params as Record<string, string>;
    switch (action) {
      case "run_command":
        if (!command) return "❌ Falta parámetro: command";
        return runCommand(command);
      case "get_info":
        return getSystemInfo();
      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};

export const heartbeatTool: Tool = {
  name: "heartbeat",
  description: "Verifica que el agente está activo y retorna el estado básico del sistema.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(_params, _chatId) {
    return `✅ JARVIS activo\n${getSystemInfo()}`;
  },
};
