import { exec } from "child_process";
import os from "os";
import { promisify } from "util";

const execAsync = promisify(exec);
const MAX_OUTPUT_CHARS = 3000;
const CMD_TIMEOUT_MS = 30000;

const ALLOWED_COMMANDS: RegExp[] = [
  /^ls(\s|$)/,
  /^cat\s+[\w./-]+$/,
  /^pwd$/,
  /^echo\s/,
  /^df(\s|$)/,
  /^free(\s|$)/,
  /^uptime$/,
  /^whoami$/,
  /^uname(\s|$)/,
  /^ps(\s|$)/,
  /^top\s-bn1$/,
  /^pm2\s+(list|status|logs|restart|stop|start|reload)(\s|$)/,
  /^node\s+--version$/,
  /^npm\s+(list|outdated|audit)(\s|$)/,
  /^git\s+(status|log|diff|branch)(\s|$)/,
  /^curl\s+--max-time\s+\d+\s+https?:\/\//,
];

function isCommandAllowed(cmd: string): boolean {
  return ALLOWED_COMMANDS.some((pattern) => pattern.test(cmd.trim()));
}

export async function runCommand(command: string): Promise<string> {
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
  } catch (err: any) {
    return `❌ Error ejecutando comando: ${err.message}`;
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
