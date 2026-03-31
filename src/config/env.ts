import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  // Telegram
  TELEGRAM_BOT_TOKEN:      z.string().min(1),
  TELEGRAM_ALLOWED_USERS:  z.string().min(1),

  // LLMs
  GROQ_API_KEY:            z.string().min(1),
  OPENROUTER_API_KEY:      z.string().min(1),
  OPENAI_API_KEY:          z.string().optional(),
  GOOGLE_API_KEY:          z.string().optional(),

  // Meta
  META_PAGE_ACCESS_TOKEN:  z.string().optional(),
  META_ACCESS_TOKEN:       z.string().optional(),
  META_PAGE_ID:            z.string().optional(),

  // Binance
  BINANCE_API_KEY:         z.string().optional(),
  BINANCE_SECRET:          z.string().optional(),

  // App
  NODE_ENV:  z.enum(["development", "production"]).default("production"),
  DB_PATH:   z.string().default("/data/jarvis.db"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Variables de entorno inválidas:");
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;

export const ALLOWED_USERS: number[] = env.TELEGRAM_ALLOWED_USERS
  .split(",")
  .map((id) => parseInt(id.trim(), 10))
  .filter((id) => !isNaN(id));
