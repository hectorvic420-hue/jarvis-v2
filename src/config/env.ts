import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  // Telegram (REQUERIDOS)
  TELEGRAM_BOT_TOKEN:      z.string().min(1),
  TELEGRAM_ALLOWED_USERS:  z.string().min(1),

  // LLMs (Todos opcionales - al menos uno debe estar configurado)
  GROQ_API_KEY:            z.string().optional(),
  OPENROUTER_API_KEY:      z.string().optional(),
  GOOGLE_API_KEY:          z.string().optional(),
  ANTHROPIC_API_KEY:       z.string().optional(),

  // Meta
  META_PAGE_ACCESS_TOKEN:  z.string().optional(),
  META_ACCESS_TOKEN:        z.string().optional(),
  META_PAGE_ID:            z.string().optional(),

  // Binance
  BINANCE_API_KEY:         z.string().optional(),
  BINANCE_SECRET:          z.string().optional(),

  // WhatsApp
  WHAPI_TOKEN:             z.string().optional(),
  WHATSAPP_WHITELIST:      z.string().optional(),

  // n8n
  N8N_BASE_URL:            z.string().optional(),
  N8N_API_KEY:            z.string().optional(),

  // AI Services
  TOGETHER_API_KEY:        z.string().optional(),
  FAL_API_KEY:             z.string().optional(),
  REPLICATE_API_KEY:       z.string().optional(),
  RUNWAY_API_KEY:          z.string().optional(),
  KLING_API_KEY:           z.string().optional(),
  PIKA_API_KEY:            z.string().optional(),
  ELEVENLABS_API_KEY:      z.string().optional(),
  TAVILY_API_KEY:          z.string().optional(),

  // Landings
  LANDINGS_DIR:             z.string().optional(),
  PUBLIC_URL:              z.string().optional(),

  // Browser control
  WINDOWS_AGENT_URL:       z.string().optional(),
  WINDOWS_AGENT_SECRET:    z.string().optional(),
  SCREENSHOTS_DIR:         z.string().optional(),

  // Self-repair
  BACKUPS_DIR:             z.string().optional(),
  JARVIS_ROOT:             z.string().optional(),

  // App
  NODE_ENV:  z.enum(["development", "production"]).default("production"),
  PORT:      z.string().optional().default("8080"),
  DB_DIR:    z.string().optional().default("./data/db"),
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

// Validar que al menos un proveedor LLM esté configurado
const hasLLMProvider =
  env.GROQ_API_KEY ||
  env.OPENROUTER_API_KEY ||
  env.GOOGLE_API_KEY ||
  env.ANTHROPIC_API_KEY;

if (!hasLLMProvider) {
  console.error("❌ ERROR: No hay proveedor LLM configurado.");
  console.error("   Configure al menos una de: GROQ_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, ANTHROPIC_API_KEY");
  process.exit(1);
}
