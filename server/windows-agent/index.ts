import express from "express";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

const app  = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3001;
const SECRET = process.env.WINDOWS_AGENT_SECRET ?? "jarvis-windows-secret";

app.use(express.json());

// ─── Auth middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SECRET}`) {
    res.status(401).json({ success: false, result: "Unauthorized" });
    return;
  }
  next();
});

// ─── Session management ───────────────────────────────────────────────────────
interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();

async function getOrCreateSession(chatId: string): Promise<BrowserSession> {
  const existing = sessions.get(chatId);
  if (existing) { existing.lastUsed = Date.now(); return existing; }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page    = await context.newPage();
  const session: BrowserSession = { browser, context, page, lastUsed: Date.now() };
  sessions.set(chatId, session);
  return session;
}

// ─── Browser endpoint ─────────────────────────────────────────────────────────
app.post("/browser", async (req, res) => {
  const params = req.body as Record<string, string>;
  const { action, url, selector, value, username, password,
    user_selector = "input[type='email'],#email,#username",
    pass_selector = "input[type='password']",
    submit_selector = "[type='submit']",
    direction = "down",
  } = params;

  const chatId = params.chat_id ?? "default";

  try {
    if (action === "close") {
      const s = sessions.get(chatId);
      if (s) { await s.browser.close(); sessions.delete(chatId); }
      res.json({ success: true, result: "✅ Navegador cerrado." });
      return;
    }

    const { page } = await getOrCreateSession(chatId);

    let result = "";

    switch (action) {
      case "navigate":
        await page.goto(url!, { waitUntil: "domcontentloaded", timeout: 30_000 });
        result = `✅ Navegué a: ${url}\nTítulo: ${await page.title()}`;
        break;

      case "click":
        try {
          await page.click(selector!, { timeout: 10_000 });
        } catch {
          await page.getByText(selector!).first().click({ timeout: 10_000 });
        }
        result = `✅ Clic en: ${selector}`;
        break;

      case "fill":
        await page.fill(selector!, value!, { timeout: 10_000 });
        result = `✅ Rellené campo "${selector}"`;
        break;

      case "screenshot": {
        const dir = path.join(process.env.TEMP ?? "C:/Temp", "jarvis-screenshots");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `screenshot-${Date.now()}.png`);
        await page.screenshot({ path: filePath });
        result = `📸 Screenshot en: ${filePath}`;
        res.json({ success: true, result, screenshot_path: filePath });
        return;
      }

      case "get_text":
        result = selector
          ? `📄 ${await page.locator(selector).first().textContent({ timeout: 10_000 })}`
          : `📄 ${(await page.evaluate(() => document.body.innerText)).slice(0, 2000)}`;
        break;

      case "login":
        await page.fill(user_selector, username!, { timeout: 10_000 });
        await page.fill(pass_selector, password!, { timeout: 10_000 });
        await page.click(submit_selector, { timeout: 10_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
        result = `✅ Login ejecutado. URL: ${page.url()}`;
        break;

      case "select":
        await page.selectOption(selector!, value!, { timeout: 10_000 });
        result = `✅ Seleccioné "${value}"`;
        break;

      case "scroll":
        await page.evaluate((dir) => { window.scrollBy(0, dir === "down" ? 600 : -600); }, direction);
        result = `✅ Scroll ${direction}`;
        break;

      default:
        res.json({ success: false, result: `❌ Acción desconocida: ${action}` });
        return;
    }

    res.json({ success: true, result });
  } catch (err) {
    res.json({ success: false, result: `❌ Error (${action}): ${(err as Error).message}` });
  }
});

app.listen(PORT, () => {
  console.log(`🖥️  Jarvis Windows Agent running on port ${PORT}`);
  console.log(`   Secret configured: ${SECRET !== "jarvis-windows-secret" ? "✅" : "⚠️  using default"}`);
});
