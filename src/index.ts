import "./memory/db"; // inicializa DB antes que todo
import { Bot } from "grammy";
import Groq from "groq-sdk";
import OpenAI from "openai";

import { env, ALLOWED_USERS } from "./config/env";
import {
  saveMessage,
  getHistory,
  clearHistory,
  getAllFacts,
  setFact,
  deleteFact,
  auditLog,
  getCapital,
  type Role,
} from "./memory/service";

// ─── LLM Clients ──────────────────────────────────────────────────────────────

const groq = new Groq({ apiKey: env.GROQ_API_KEY });

const openrouter = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

// ─── LLM con fallback automático ──────────────────────────────────────────────

type ChatMessage = { role: Role; content: string };

async function llmChat(messages: ChatMessage[]): Promise<string> {
  try {
    const res = await groq.chat.completions.create({
      model: "llama3-70b-8192",
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });
    return res.choices[0]?.message?.content?.trim() ?? "Sin respuesta.";
  } catch (groqErr) {
    console.warn("⚠️  Groq falló → OpenRouter:", (groqErr as Error).message);
    try {
      const res = await openrouter.chat.completions.create({
        model: "google/gemini-flash-1.5",
        messages,
        max_tokens: 1024,
      });
      return res.choices[0]?.message?.content?.trim() ?? "Sin respuesta.";
    } catch (orErr) {
      console.error("❌ OpenRouter también falló:", (orErr as Error).message);
      throw orErr;
    }
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return (
    "Eres JARVIS, agente autónomo personal de Hector (Automatizado Agency / David Academy). " +
    "Eres directo, preciso y sin relleno. Responde siempre en español. " +
    "Si el usuario te da una instrucción, ejecútala. Si no puedes, dilo sin rodeos."
  );
}

// ─── Bot ──────────────────────────────────────────────────────────────────────

const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

// Middleware: guard de acceso
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId || !ALLOWED_USERS.includes(userId)) {
    auditLog("unauthorized_access", { userId, username: ctx.from?.username });
    await ctx.reply("⛔ Acceso no autorizado.");
    return;
  }
  await next();
});

// ─── Comandos ─────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  await ctx.reply(
    "⚡ *JARVIS v2 online.*\n\n" +
    "Comandos disponibles:\n" +
    "/clear — borrar historial\n" +
    "/facts — ver memoria permanente\n" +
    "/capital — estado de capital\n" +
    "/setfact clave | valor — guardar hecho\n" +
    "/delfact clave — borrar hecho",
    { parse_mode: "Markdown" }
  );
});

bot.command("clear", async (ctx) => {
  clearHistory(ctx.from!.id);
  auditLog("clear_history", null, ctx.from!.id);
  await ctx.reply("🗑️ Historial borrado.");
});

bot.command("facts", async (ctx) => {
  const facts = getAllFacts();
  if (!facts.length) return ctx.reply("📭 Sin hechos guardados.");
  const lines = facts.map((f) => `• *${f.key}*: ${f.value}`).join("\n");
  await ctx.reply(`📚 *Memoria permanente:*\n\n${lines}`, {
    parse_mode: "Markdown",
  });
});

bot.command("capital", async (ctx) => {
  const capital = getCapital();
  if (!capital.length) return ctx.reply("📭 Sin datos de capital.");
  const lines = capital
    .map((c) => `• *${c.asset}*: ${c.amount}${c.source ? ` (${c.source})` : ""}`)
    .join("\n");
  await ctx.reply(`💰 *Capital actual:*\n\n${lines}`, { parse_mode: "Markdown" });
});

// /setfact clave | valor
bot.command("setfact", async (ctx) => {
  const args = ctx.match?.toString().split("|").map((s) => s.trim());
  if (!args || args.length < 2 || !args[0] || !args[1]) {
    return ctx.reply("Uso: /setfact clave | valor");
  }
  setFact(args[0], args[1]);
  auditLog("set_fact", { key: args[0] }, ctx.from!.id);
  await ctx.reply(`✅ Hecho guardado: *${args[0]}*`, { parse_mode: "Markdown" });
});

// /delfact clave
bot.command("delfact", async (ctx) => {
  const key = ctx.match?.toString().trim();
  if (!key) return ctx.reply("Uso: /delfact clave");
  const deleted = deleteFact(key);
  auditLog("delete_fact", { key }, ctx.from!.id);
  await ctx.reply(deleted ? `🗑️ Hecho *${key}* eliminado.` : `⚠️ No existe: *${key}*`, {
    parse_mode: "Markdown",
  });
});

// ─── Mensajes de texto ────────────────────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  const userId = ctx.from.id;
  const userText = ctx.message.text;

  saveMessage("user", userText, userId);
  auditLog("message_in", { preview: userText.slice(0, 120) }, userId);

  const history = getHistory(userId, 20);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history.map((m) => ({ role: m.role as Role, content: m.content })),
  ];

  await ctx.replyWithChatAction("typing");

  try {
    const reply = await llmChat(messages);
    saveMessage("assistant", reply, userId);
    auditLog("message_out", { preview: reply.slice(0, 120) }, userId);
    await ctx.reply(reply, { parse_mode: "Markdown" });
  } catch (err) {
    auditLog("llm_error", { error: String(err) }, userId, "error");
    await ctx.reply("❌ Error en LLM. Intenta de nuevo en unos segundos.");
  }
});

// Mensajes no manejados
bot.on("message", async (ctx) => {
  await ctx.reply("⚠️ Solo proceso mensajes de texto por ahora.");
});

// ─── Arranque ─────────────────────────────────────────────────────────────────

async function startBot(): Promise<void> {
  console.log("🤖 Iniciando JARVIS v2...");
  console.log(`👤 Usuarios permitidos: ${ALLOWED_USERS.join(", ")}`);

  await bot.start({
    onStart: (info) => {
      console.log(`✅ JARVIS online → @${info.username}`);
    },
  });
}

startBot().catch((err) => {
  console.error("❌ Error fatal al iniciar:", err);
  process.exit(1);
});
