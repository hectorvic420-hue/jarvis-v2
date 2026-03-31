import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

// ─── Allowed paths for list_dir ───────────────────────────────────────────────
const ALLOWED_DIRS = [
  "/data",
  "/home",
  os.homedir(),
  process.cwd(),
];

// ─── Destructive command patterns that require confirmation ───────────────────
const DESTRUCTIVE_PATTERNS = [
  /\brm\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bformat\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bchmod\s+777\b/,
  /\b>\s*\/dev\//,
  /\bsudo\b/,
];

function isDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
}

function isAllowedDir(dirPath: string): boolean {
  const resolved = path.resolve(dirPath);
  return ALLOWED_DIRS.some((allowed) => resolved.startsWith(path.resolve(allowed)));
}

// ─── Tool: screenshot ─────────────────────────────────────────────────────────
export async function screenshot(outputPath?: string): Promise<{ success: boolean; path: string; error?: string }> {
  const outDir = "/data/media/screenshots";
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = outputPath ?? path.join(outDir, `screenshot_${Date.now()}.png`);

  try {
    // Try scrot (Linux), fallback to import (ImageMagick)
    const cmd = process.platform === "darwin"
      ? `screencapture -x "${filePath}"`
      : `scrot "${filePath}" 2>/dev/null || import -window root "${filePath}"`;

    await execAsync(cmd);
    return { success: true, path: filePath };
  } catch (err: any) {
    return { success: false, path: "", error: err.message };
  }
}

// ─── Tool: list_processes ─────────────────────────────────────────────────────
export interface ProcessInfo {
  pid: string;
  name: string;
  cpu: string;
  mem: string;
  status: string;
}

export async function listProcesses(filter?: string): Promise<{ processes: ProcessInfo[]; error?: string }> {
  try {
    const cmd = process.platform === "darwin"
      ? `ps aux | head -50`
      : `ps aux --sort=-%cpu | head -50`;

    const { stdout } = await execAsync(cmd);
    const lines = stdout.trim().split("\n").slice(1);

    let processes: ProcessInfo[] = lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parts[1],
        cpu: parts[2],
        mem: parts[3],
        status: parts[7] ?? "?",
        name: parts.slice(10).join(" "),
      };
    });

    if (filter) {
      processes = processes.filter((p) =>
        p.name.toLowerCase().includes(filter.toLowerCase())
      );
    }

    return { processes };
  } catch (err: any) {
    return { processes: [], error: err.message };
  }
}

// ─── Tool: system_stats ───────────────────────────────────────────────────────
export interface SystemStats {
  platform: string;
  arch: string;
  hostname: string;
  uptime_seconds: number;
  cpu_count: number;
  total_memory_gb: number;
  free_memory_gb: number;
  used_memory_pct: number;
  load_avg: number[];
  disk?: { filesystem: string; size: string; used: string; available: string; use_pct: string }[];
}

export async function systemStats(): Promise<{ stats: SystemStats; error?: string }> {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const stats: SystemStats = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime_seconds: os.uptime(),
      cpu_count: os.cpus().length,
      total_memory_gb: +(totalMem / 1e9).toFixed(2),
      free_memory_gb: +(freeMem / 1e9).toFixed(2),
      used_memory_pct: +((1 - freeMem / totalMem) * 100).toFixed(1),
      load_avg: os.loadavg(),
    };

    try {
      const { stdout } = await execAsync("df -h --output=source,size,used,avail,pcent 2>/dev/null || df -h");
      const diskLines = stdout.trim().split("\n").slice(1);
      stats.disk = diskLines.map((line) => {
        const p = line.trim().split(/\s+/);
        return { filesystem: p[0], size: p[1], used: p[2], available: p[3], use_pct: p[4] };
      });
    } catch {
      // disk info optional
    }

    return { stats };
  } catch (err: any) {
    return { stats: {} as SystemStats, error: err.message };
  }
}

// ─── Tool: list_dir ───────────────────────────────────────────────────────────
export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink";
  size_bytes: number;
  modified: string;
  extension: string;
}

export async function listDir(dirPath: string): Promise<{ entries: FileEntry[]; error?: string }> {
  if (!isAllowedDir(dirPath)) {
    return { entries: [], error: `Path not allowed: ${dirPath}. Allowed: ${ALLOWED_DIRS.join(", ")}` };
  }

  try {
    const items = fs.readdirSync(dirPath);
    const entries: FileEntry[] = items.map((name) => {
      const full = path.join(dirPath, name);
      try {
        const stat = fs.lstatSync(full);
        return {
          name,
          type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
          size_bytes: stat.size,
          modified: stat.mtime.toISOString(),
          extension: path.extname(name).toLowerCase(),
        };
      } catch {
        return { name, type: "file" as const, size_bytes: 0, modified: "", extension: "" };
      }
    });

    return { entries };
  } catch (err: any) {
    return { entries: [], error: err.message };
  }
}

// ─── Tool: run_command ────────────────────────────────────────────────────────
export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  requires_confirmation?: boolean;
}

export async function runCommand(
  command: string,
  confirmed = false
): Promise<CommandResult> {
  if (isDestructive(command) && !confirmed) {
    return {
      stdout: "",
      stderr: "",
      exit_code: -1,
      requires_confirmation: true,
    };
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exit_code: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout?.trim() ?? "",
      stderr: err.stderr?.trim() ?? err.message,
      exit_code: err.code ?? 1,
    };
  }
}

// ─── Tool registry (for agent) ────────────────────────────────────────────────
export const systemControlTools = {
  screenshot,
  list_processes: listProcesses,
  system_stats: systemStats,
  list_dir: listDir,
  run_command: runCommand,
};
