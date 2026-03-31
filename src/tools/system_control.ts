import { Tool } from "../shared/types.js";
import { execSync, exec } from "child_process";
import fs   from "fs";
import os   from "os";
import path from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

const MAX_OUTPUT_CHARS = 3_000;
const CMD_TIMEOUT_MS   = 30_000;

// ─── Allowlist de comandos seguros ────────────────────────────────────────────
// Solo se permiten comandos en esta lista para evitar ejecución arbitraria

const ALLOWED_COMMANDS: RegExp[] = [
  /^ls(\s|$)/,
  /^cat\s+[\w./\-]+$/,
  /^pwd$/,
  /^echo\s/,
  /^df(\s|$)/,
  /^free(\s|$)/,
  /^uptime$/,
  /^whoami$/,
  /^uname(\s|$)/,
  /^ps(\s|$)/,
  /^top\s+-bn1$/,
  /^pm2\s+(list|status|logs|restart|stop|start|reload)(\s|$)/,
  /^node\s+--version$/,
  /^npm\s+(list|outdated|audit)(\s|$)/,
  /^git\s+(status|log|diff|branch)(\s|$)/,
  /^curl\s+--max-time\s+\d+\s+https?:\/\//,
];

function isCommandAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd.trim()));
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function runCommand(command: string): Promise<string> {
  if (!isCommandAllowed(command)) {
    return (
      `⛔ Comando no permitido: \`${command}\`\n\n` +
      `Comandos permitidos: ls, cat, pwd, echo, df, free, uptime, whoami, uname, ` +
      `ps, top -bn1, pm2 (list/status/logs/restart/stop/start/reload), ` +
      `node --version, npm (list/outdated/audit), git (status/log/diff/branch), curl https`
    );
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: CMD_TIMEOUT_MS,
      cwd:     process.env.JARVIS_WORK_DIR || process.cwd(),
    });

    const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
    const truncated =
      output.length > MAX_OUTPUT_CHARS
        ? output.slice(0, MAX_OUTPUT_CHARS) + `\n...[truncado a ${MAX_OUTPUT_CHARS} chars]`
        : output;

    return `\`\`\`\n${truncated || "(sin salida)"}\n\`\`\``;
  } catch (err: any) {
    return `❌ Error ejecutando comando:\n\`\`\`\n${err.message as string}\n\`\`\``;
  }
}

function getSystemInfo(): string {
  const cpus   = os.cpus();
  const memTotal  = os.totalmem();
  const memFree   = os.freemem();
  const memUsed   = memTotal - memFree;
  const memPct    = ((memUsed / memTotal) * 100).toFixed(1);
  const loadAvg   = os.loadavg().map((v) => v.toFixed(2)).join(", ");
  const uptimeSec = os.uptime();
  const uptimeStr = `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`;

  return [
    `💻 *Información del sistema*`,
    `OS: ${os.type()} ${os.release()} (${os.arch()})`,
    `Hostname: ${os.hostname()}`,
    `CPU: ${cpus[0]?.model ?? "?"} (${cpus.length} núcleos)`,
    `RAM: ${(memUsed / 1024 ** 3).toFixed(2)}GB / ${(memTotal / 1024 ** 3).toFixed(2)}GB (${memPct}%)`,
    `Carga: ${loadAvg}`,
    `Uptime: ${uptimeStr}`,
    `Node.js: ${process.version}`,
    `PID: ${process.pid}`,
  ].join("\n");
}

function readFile(filePath: string): string {
  const resolved = path.resolve(filePath);

  // Evitar lectura de archivos sensibles
  const BLOCKED = ["/etc/shadow", "/etc/passwd", ".env", "id_rsa", ".pem"];
  if (BLOCKED.some((b) => resolved.includes(b))) {
    return `⛔ Lectura de \`${filePath}\` no permitida.`;
  }

  if (!fs.existsSync(resolved)) return `❌ Archivo no encontrado: ${filePath}`;

  const stat = fs.statSync(resolved);
  if (stat.size > 100_000) return `❌ Archivo demasiado grande (${(stat.size / 1024).toFixed(0)}KB, máx 100KB)`;

  const content = fs.readFileSync(resolved, "utf-8");
  const truncated =
    content.length > MAX_OUTPUT_CHARS
      ? content.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncado]"
      : content;

  return `📄 *${path.basename(resolved)}*\n\`\`\`\n${truncated}\n\`\`\``;
}

function writeFile(filePath: string, content: string): string {
  const resolved = path.resolve(filePath);
  const BLOCKED  = ["/etc", "/usr", "/bin", "/sbin", "/boot"];
  if (BLOCKED.some((b) => resolved.startsWith(b))) {
    return `⛔ Escritura en \`${filePath}\` no permitida.`;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf-8");
  return `✅ Archivo guardado: ${resolved}`;
}

function listDirectory(dirPath: string): string {
  const resolved = path.resolve(dirPath || ".");
  if (!fs.existsSync(resolved)) return `❌ Directorio no encontrado: ${dirPath}`;

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  if (!entries.length) return `📁 Directorio vacío: ${resolved}`;

  const lines = [`📁 *${resolved}* (${entries.length} entradas)`];
  for (const e of entries.slice(0, 50)) {
    const icon = e.isDirectory() ? "📂" : "📄";
    lines.push(`${icon} ${e.name}`);
  }
  if (entries.length > 50) lines.push(`...y ${entries.length - 50} más`);
  return lines.join("\n");
}

async function pm2Status(): Promise<string> {
  try {
    const { stdout } = await execAsync("pm2 jlist", { timeout: 10_000 });
    const processes = JSON.parse(stdout) as Array<Record<string, any>>;

    if (!processes.length) return "📋 No hay procesos PM2 activos.";

    const lines = [`📋 *PM2 (${processes.length} procesos)*`];
    for (const p of processes) {
      const mem  = p["monit"]?.["memory"] as number ?? 0;
      const cpu  = p["monit"]?.["cpu"] as number ?? 0;
      const icon = p["pm2_env"]?.["status"] === "online" ? "🟢" : "🔴";
      lines.push(
        `${icon} [${p["pm_id"] as number}] ${p["name"] as string} | ` +
        `CPU: ${cpu}% | RAM: ${(mem / 1024 ** 2).toFixed(1)}MB | ` +
        `Restarts: ${p["pm2_env"]?.["restart_time"] as number ?? 0}`
      );
    }
    return lines.join("\n");
  } catch {
    return "❌ PM2 no disponible o sin procesos.";
  }
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const systemControlTool: Tool = {
  name: "system_control",
  description:
    "Control del sistema: ejecuta comandos seguros (allowlist), obtiene info del sistema, " +
    "lee/escribe archivos, lista directorios y consulta estado de procesos PM2.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["run_command", "system_info", "read_file", "write_file", "list_dir", "pm2_status"],
      },
      command:   { type: "string",  description: "Comando a ejecutar (allowlist)" },
      file_path: { type: "string",  description: "Ruta del archivo" },
      content:   { type: "string",  description: "Contenido a escribir en el archivo" },
      dir_path:  { type: "string",  description: "Ruta del directorio a listar" },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, command, file_path, content, dir_path } = params as Record<string, any>;

    switch (action) {
      case "run_command":
        if (!command) return "❌ Falta parámetro: command";
        return runCommand(command as string);
      case "system_info":
        return getSystemInfo();
      case "read_file":
        if (!file_path) return "❌ Falta parámetro: file_path";
        return readFile(file_path as string);
      case "write_file":
        if (!file_path || content === undefined) return "❌ Faltan: file_path, content";
        return writeFile(file_path as string, content as string);
      case "list_dir":
        return listDirectory(dir_path as string ?? ".");
      case "pm2_status":
        return pm2Status();
      default:
        return `❌ Acción desconocida: ${action as string}`;
    }
  },
};
