import { exec } from "child_process";
import os from "os";
import { promisify } from "util";
import { Tool } from "../shared/types.js";

const execAsync = promisify(exec);
const MAX_OUTPUT_CHARS = 3000;
const CMD_TIMEOUT_MS = 30000;

const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /curl\s+\|\s*bash/i,
  /wget\s+\|\s*sh/i,
  /chmod\s+777/i,
  /\>\s*\/etc/i,
  /dd\s+if=/i,
  /mkfs/i,
  /:\(\)\s*\{.*:\|:&.*\}/i,
  /base64\s+-d\s*\|\s*bash/i,
];

function validateCommand(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(lower)) {
      return false;
    }
  }

  if (/\|\s*(bash|sh|zsh|exec)/i.test(lower)) {
    return false;
  }

  return true;
}

const ALLOWED_COMMANDS: RegExp[] = [
  /^ls(\s+[-\w./]+)*$/,
  /^cat\s+[\w./-]+$/,
  /^pwd$/,
  /^echo\s+["'][^"']*["']$/,
  /^echo\s+[^\s;|`$]+$/,
  /^df\s*$/,
  /^free\s*$/,
  /^uptime$/,
  /^whoami$/,
  /^uname(\s+-[a-z]+)?$/,
  /^ps(\s+-[efww]+)*$/,
  /^top\s+-bn1$/,
  /^pm2\s+(list|status|logs|restart|stop|start|reload|monit)(\s+[\w-]+)*$/,
  /^node\s+--version$/,
  /^npm\s+(list|outdated|audit|run)(\s+[\w-]+)*$/,
  /^git\s+(status|log|diff|branch|remote)(\s+[-a-z]+)*$/,
  /^curl\s+--max-time\s+\d+\s+https?:\/\/[^\s;|`$]+$/,
];

function isCommandAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd.trim()));
}

export async function runCommand(command: string): Promise<string> {
  if (!validateCommand(command)) {
    return "❌ Comando bloqueado por seguridad. Solo se permiten comandos de lectura y diagnóstico.";
  }

  if (!isCommandAllowed(command)) {
    return `⚠️ Comando no permitido: "${command}"\nComandos permitidos: ls, cat, pwd, echo, df, free, uptime, whoami, pm2, git, npm.`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
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
