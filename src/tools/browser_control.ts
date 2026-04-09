import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { Tool } from "../shared/types.js";

// ─── Screenshot store ─────────────────────────────────────────────────────────
// telegram.ts reads this after runAgent() to send the photo
export const screenshotStore = new Map<string, string>();

// ─── Session management ───────────────────────────────────────────────────────

interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();
const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

// Clean up stale sessions every minute
setInterval(() => {
  const now = Date.now();
  for (const [chatId, s] of sessions.entries()) {
    if (now - s.lastUsed > SESSION_TIMEOUT_MS) {
      s.browser.close().catch(() => {});
      sessions.delete(chatId);
      console.log(`[browser_control] Session closed (timeout) for ${chatId}`);
    }
  }
}, 60_000);

async function getOrCreateSession(chatId: string, headed = false): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const browser = await chromium.launch({
    headless: !headed,
    args: headed ? [] : ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  const session: BrowserSession = { browser, context, page, lastUsed: Date.now() };
  sessions.set(chatId, session);
  console.log(`[browser_control] New session for ${chatId} (headless=${!headed})`);
  return session;
}

// ─── Windows Agent proxy ──────────────────────────────────────────────────────

async function callWindowsAgent(
  params: Record<string, unknown>
): Promise<string> {
  const agentUrl = process.env.WINDOWS_AGENT_URL;
  const secret   = process.env.WINDOWS_AGENT_SECRET ?? "";

  const res = await fetch(`${agentUrl}/browser`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return `❌ Windows agent error ${res.status}: ${text}`;
  }

  const json = (await res.json()) as {
    success: boolean;
    result: string;
    screenshot_path?: string;
  };

  return json.result;
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function navigate(page: Page, url: string): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const title = await page.title();
  return `✅ Navegué a: ${url}\nTítulo: ${title}`;
}

async function clickElement(page: Page, selector: string): Promise<string> {
  try {
    await page.click(selector, { timeout: 10_000 });
    return `✅ Clic en: ${selector}`;
  } catch {
    await page.getByText(selector).first().click({ timeout: 10_000 });
    return `✅ Clic en texto: "${selector}"`;
  }
}

async function fillField(page: Page, selector: string, value: string): Promise<string> {
  await page.fill(selector, value, { timeout: 10_000 });
  return `✅ Rellené campo "${selector}" con valor`;
}

async function takeScreenshot(page: Page, chatId: string): Promise<string> {
  const screenshotsDir = "/tmp/jarvis-screenshots";
  if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

  const filePath = path.join(screenshotsDir, `screenshot-${chatId}-${Date.now()}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  screenshotStore.set(chatId, filePath);
  return `📸 Screenshot tomado`;
}

async function getText(page: Page, selector?: string): Promise<string> {
  if (selector) {
    const el = page.locator(selector).first();
    const text = await el.textContent({ timeout: 10_000 });
    return `📄 Texto en "${selector}":\n${text?.trim() ?? "(vacío)"}`;
  }
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore: runs in browser context where document exists
  const text = await page.evaluate(() => document.body.innerText as string);
  return `📄 Texto de la página:\n${text.slice(0, 2000)}`;
}

async function loginSequence(
  page: Page,
  username: string,
  password: string,
  userSelector: string,
  passSelector: string,
  submitSelector: string
): Promise<string> {
  await page.fill(userSelector, username, { timeout: 10_000 });
  await page.fill(passSelector, password, { timeout: 10_000 });
  await page.click(submitSelector, { timeout: 10_000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  const url   = page.url();
  const title = await page.title();
  return `✅ Login ejecutado\nURL actual: ${url}\nTítulo: ${title}`;
}

async function selectOption(page: Page, selector: string, value: string): Promise<string> {
  await page.selectOption(selector, value, { timeout: 10_000 });
  return `✅ Seleccioné "${value}" en ${selector}`;
}

async function scrollPage(page: Page, direction: "down" | "up" = "down"): Promise<string> {
  await page.evaluate((dir) => {
    // @ts-ignore: runs in browser context where window exists
    window.scrollBy(0, dir === "down" ? 600 : -600);
  }, direction);
  return `✅ Scroll ${direction}`;
}

// ─── Tool definition ──────────────────────────────────────────────────────────

export const browserControlTool: Tool = {
  name: "browser_control",
  description:
    "Controla un navegador web: navega a URLs, hace clic, rellena formularios, toma screenshots, ejecuta login. " +
    "Úsalo para: llenar formularios, entrar a páginas, hacer login, confirmar acciones en sitios web. " +
    "Las sesiones del navegador se mantienen abiertas entre comandos del mismo chat.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["navigate", "click", "fill", "screenshot", "get_text", "login", "select", "scroll", "close"],
        description: "Acción a ejecutar en el navegador",
      },
      url: {
        type: "string",
        description: "URL para navegar (acción: navigate)",
      },
      selector: {
        type: "string",
        description: "Selector CSS o texto visible del elemento (acciones: click, fill, get_text, select)",
      },
      value: {
        type: "string",
        description: "Valor a escribir o seleccionar (acciones: fill, select)",
      },
      username: {
        type: "string",
        description: "Nombre de usuario para login",
      },
      password: {
        type: "string",
        description: "Contraseña para login",
      },
      user_selector: {
        type: "string",
        description: "Selector del campo usuario (default: input[name='email'],input[type='email'],#email,#username)",
      },
      pass_selector: {
        type: "string",
        description: "Selector del campo contraseña (default: input[type='password'])",
      },
      submit_selector: {
        type: "string",
        description: "Selector del botón submit (default: [type='submit'],button[type='submit'])",
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Dirección del scroll (default: down)",
      },
      mode: {
        type: "string",
        enum: ["server", "windows"],
        description: "Modo de ejecución: server (headless, default) o windows (headed en PC)",
      },
    },
    required: ["action"],
  },

  async execute(params, chatId) {
    const {
      action,
      url,
      selector,
      value,
      username,
      password,
      user_selector = "input[name='email'],input[type='email'],#email,#username,input[name='user']",
      pass_selector = "input[type='password']",
      submit_selector = "[type='submit'],button[type='submit'],button:has-text('Login'),button:has-text('Entrar'),button:has-text('Iniciar')",
      direction = "down",
      mode,
    } = params as Record<string, string>;

    // Route to Windows agent if requested and configured
    const windowsUrl = process.env.WINDOWS_AGENT_URL;
    if (mode === "windows" || (!mode && windowsUrl)) {
      if (!windowsUrl) return "❌ WINDOWS_AGENT_URL no configurado. Usa mode='server' o configura la variable.";
      return await callWindowsAgent(params);
    }

    try {
      if (action === "close") {
        const s = sessions.get(chatId);
        if (s) {
          await s.browser.close();
          sessions.delete(chatId);
          screenshotStore.delete(chatId);
        }
        return "✅ Navegador cerrado.";
      }

      const session = await getOrCreateSession(chatId);
      const { page } = session;

      switch (action) {
        case "navigate":
          if (!url) return "❌ Parámetro 'url' requerido para navigate";
          return await navigate(page, url);

        case "click":
          if (!selector) return "❌ Parámetro 'selector' requerido para click";
          return await clickElement(page, selector);

        case "fill":
          if (!selector) return "❌ Parámetro 'selector' requerido para fill";
          if (value === undefined) return "❌ Parámetro 'value' requerido para fill";
          return await fillField(page, selector, value);

        case "screenshot":
          return await takeScreenshot(page, chatId);

        case "get_text":
          return await getText(page, selector);

        case "login":
          if (!username || !password) return "❌ Parámetros 'username' y 'password' requeridos para login";
          return await loginSequence(page, username, password, user_selector, pass_selector, submit_selector);

        case "select":
          if (!selector || !value) return "❌ Parámetros 'selector' y 'value' requeridos para select";
          return await selectOption(page, selector, value);

        case "scroll":
          return await scrollPage(page, direction as "up" | "down");

        default:
          return `❌ Acción desconocida: ${action}`;
      }
    } catch (err) {
      return `❌ Error en browser_control (${action}): ${(err as Error).message}`;
    }
  },
};
