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
