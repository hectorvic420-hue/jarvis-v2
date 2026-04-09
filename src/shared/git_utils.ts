import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execAsync = promisify(exec);
const PROJECT_ROOT = process.env.JARVIS_ROOT ?? "/opt/jarvis/jarvis-v2";

export async function commitRepair(filePath: string, summary: string): Promise<string | null> {
  try {
    const relPath = path.relative(PROJECT_ROOT, filePath);
    await execAsync(`git add "${relPath}"`, { cwd: PROJECT_ROOT, timeout: 30_000 });
    await execAsync(
      `git commit -m "auto-repair(${relPath}): ${summary.replace(/["`]/g, "'").slice(0, 60)}"`,
      { cwd: PROJECT_ROOT, timeout: 30_000 }
    );
    const { stdout } = await execAsync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, timeout: 10_000 });
    return stdout.trim();
  } catch (err) {
    console.error("[git_utils] commit failed (non-blocking):", (err as Error).message);
    return null;
  }
}
