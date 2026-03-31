import { Bot, Context, session, SessionFlavor } from "grammy";
import { runAgent }       from "../agent";
import { tools as toolRegistry, listTools } from "../tools/index.js";
import { memoryService } from "../memory/service.js";

// ─── Session ──────────────────────────────────────────────────────────────────

interface PendingAction {
  label:   string;
  message: string;
}

interface SessionData {
  pendingAction?: PendingAction;
}

type BotCtx = Context & SessionFlavor<SessionData>;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  `Eres Jarvis, un agente de IA de élite, preciso, seguro y altamente capaz. ` +
  `Tienes acceso directo a herramientas de automatización de n8n, Meta (Facebook Ads y Publishing), Google Workspace y el sistema local. ` +
  `Si un usuario te pide gestionar n8n, publicar en Facebook o manejar archivos, USA TUS HERRAMIENTAS en lugar de decir que no puedes. ` +
  `Eres proactivo, firme y eficiente. Si una tarea requiere varias herramientas, ejecútalas en orden. ` +
  `Para n8n, usa 'n8n_manager' para listar, activar o ejecutar workflows. ` +
  `Responde siempre en español de forma profesional y motivadora. ` +
  `Sé directo, concreto y útil. Evita respuestas genéricas. ` +
  `Cuando uses herramientas, explica brevemente qué hiciste y qué encontraste. ` +
  `Nunca inventes datos — usa las herramientas para información real. ` +
  `Si no puedes completar una tarea, explica con claridad por qué.`;

// ─── Auth ─────────────────────────────────────────────────────────────────────

function getAllowedUsers(): Set<string> {
  const raw = process.env.TELEGRAM_ALLOWED_USERS ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function isAllowed(userId: number): boolean {
  return getAllowedUsers().has(String(userId));
}

// ─── Message helpers ──────────────────────────────────────────────────────────

const TG_MAX_LENGTH = 4_000;

async function sendLong(ctx: BotCtx, text: string): Promise<void> {
  if (!text.trim()) {
    await ctx.reply("_(respuesta vacía)_", { parse_mode: "Markdown" });
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, TG_MAX_LENGTH));
    remaining = remaining.slice(TG_MAX_LENGTH);
  }

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    } catch {
      try {
        await ctx.reply(chunk); // fallback sin markdown
      } catch (err) {
        console.error("[BOT] No se pudo enviar chunk:", (err as Error).message);
      }
    }
  }
}

async function tryDelete(ctx: BotCtx, messageId: number): Promise<void> {
  try {
    await ctx.api.deleteMessage(ctx.chat!.id, messageId);
  } catch {
    // Ignorar — el bot puede no tener permiso para borrar
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTelegramBot(): Bot<BotCtx> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN no definido.");

  const bot = new Bot<BotCtx>(token);

  // ── Session (in-memory) ──────────────────────────────────────────────────
  bot.use(
    session<SessionData, BotCtx>({
      initial: (): SessionData => ({}),
    })
  );

  // ── Auth ─────────────────────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid || !isAllowed(uid)) {
      await ctx.reply("⛔ Acceso denegado.");
      return;
    }
    await next();
  });

  // ── /start ───────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `🤖 *Jarvis v2 — Online*\n\n` +
        `Soy tu agente de IA personal. Ejecuto tareas, busco información, ` +
        `controlo herramientas y recuerdo contexto sobre ti.\n\n` +
        `Escríbeme lo que necesitas o usa /ayuda para ver los comandos.`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /ayuda ───────────────────────────────────────────────────────────────
  bot.command("ayuda", async (ctx) => {
    await ctx.reply(
      `📋 *Comandos disponibles:*\n\n` +
        `/start      — Iniciar Jarvis\n` +
        `/ayuda      — Esta ayuda\n` +
        `/memoria    — Ver hechos memorizados\n` +
        `/olvida     — Eliminar un hecho (ej: /olvida trabajo en Google)\n` +
        `/estado     — Estado del sistema\n` +
        `/confirmar  — Confirmar acción pendiente\n` +
        `/cancelar   — Cancelar acción pendiente`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /memoria ─────────────────────────────────────────────────────────────
  bot.command("memoria", async (ctx) => {
    const userId = ctx.from!.id;
    const facts  = memoryService?.getAllFacts(userId) ?? [];

    if (facts.length === 0) {
      await ctx.reply("🧠 No tengo hechos memorizados sobre ti aún.");
      return;
    }

    const list = facts.map((f, i) => `${i + 1}. ${f}`).join("\n");
    await ctx.reply(`🧠 *Memoria (${facts.length} hechos):*\n\n${list}`, {
      parse_mode: "Markdown",
    });
  });

  // ── /olvida [texto] ───────────────────────────────────────────────────────
  bot.command("olvida", async (ctx) => {
    const userId = ctx.from!.id;
    const raw    = ctx.message?.text ?? "";
    const arg    = raw.replace(/^\/olvida\s*/i, "").trim();

    if (!arg) {
      await ctx.reply(
        "❓ Indica qué debo olvidar.\nEjemplo: `/olvida trabajo en Google`",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (!memoryService) {
      await ctx.reply("⚠️ Módulo de memoria no disponible.");
      return;
    }

    const deleted = memoryService.deleteFact(userId, arg);
    if (deleted) {
      await ctx.reply(`✅ Olvidado: _${arg}_`, { parse_mode: "Markdown" });
    } else {
      const facts = memoryService.getAllFacts(userId);
      const hint =
        facts.length > 0
          ? `\n\nHechos actuales:\n${facts
              .map((f, i) => `${i + 1}. *${f.key}*: ${f.value}`)
              .join("\n")}`
          : "";
      await ctx.reply(`❌ No encontré ese hecho exacto en mi memoria.${hint}`);
    }
  });

  // ── /estado ───────────────────────────────────────────────────────────────
  bot.command("estado", async (ctx) => {
    const userId = ctx.from!.id;
    const toolNames = listTools();
    const facts   = memoryService?.getAllFacts(userId) ?? [];
    const pending = ctx.session.pendingAction;

    const groqOk   = process.env.GROQ_API_KEY       ? "✅" : "❌";
    const orOk     = process.env.OPENROUTER_API_KEY  ? "✅" : "❌";
    const geminiOk = process.env.GOOGLE_API_KEY      ? "✅" : "❌";

    await ctx.reply(
      `⚙️ *Estado de Jarvis v2*\n\n` +
        `🔧 Herramientas cargadas: ${toolNames.length}\n` +
        `🧠 Hechos en memoria: ${facts.length}\n` +
        `📡 Groq: ${groqOk}\n` +
        `🔄 OpenRouter: ${orOk}\n` +
        `🔄 Gemini: ${geminiOk}\n` +
        `⏳ Acción pendiente: ${pending ? `_${pending.label}_` : "ninguna"}`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /confirmar ────────────────────────────────────────────────────────────
  bot.command("confirmar", async (ctx) => {
    const pending = ctx.session.pendingAction;
    if (!pending) {
      await ctx.reply("❓ No hay ninguna acción pendiente de confirmación.");
      return;
    }

    ctx.session.pendingAction = undefined;
    const processingMsg = await ctx.reply("⏳ Ejecutando acción confirmada...");
    const userId = ctx.from!.id;
    const tools         = Object.values(toolRegistry);

    try {
      const result = await runAgent(
        `ACCIÓN CONFIRMADA POR EL USUARIO: ${pending.message}`,
        { tools, systemPrompt: SYSTEM_PROMPT, userId }
      );

      await tryDelete(ctx, processingMsg.message_id);

      const response = result.warning
        ? `${result.warning}\n\n${result.response}`
        : result.response;

      await sendLong(ctx, response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      await ctx.reply(`❌ Error: ${(err as Error).message}`);
    }
  });

  // ── /cancelar ─────────────────────────────────────────────────────────────
  bot.command("cancelar", async (ctx) => {
    if (ctx.session.pendingAction) {
      const { label } = ctx.session.pendingAction;
      ctx.session.pendingAction = undefined;
      await ctx.reply(`✅ Acción cancelada: _${label}_`, {
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply("❓ No hay ninguna acción pendiente.");
    }
  });

  // ── Mensajes de texto ─────────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text   = ctx.message.text;
    const userId = ctx.from.id;
    const tools  = Object.values(toolRegistry);

    // Guardar mensaje del usuario
    memoryService.addMessage(userId, "user", text, "telegram");

    const processingMsg = await ctx.reply("⏳ Procesando...");

    try {
      const result = await runAgent(text, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
      });

      await tryDelete(ctx, processingMsg.message_id);

      // Guardar respuesta del asistente
      memoryService.addMessage(userId, "assistant", result.response, "telegram");

      const response = result.warning
        ? `${result.warning}\n\n${result.response}`
        : result.response;

      await sendLong(ctx, response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      const msg = (err as Error).message;
      console.error("[BOT] Error en handler:", msg);
      await ctx.reply(`❌ Error interno: ${msg}`);
    }
  });

  // ── Otros mensajes (fotos, docs, stickers…) ───────────────────────────────
  bot.on("message", async (ctx) => {
    await ctx.reply(
      "📎 Por ahora solo proceso texto. Envíame tu consulta en texto."
    );
  });

  // ── Error global ──────────────────────────────────────────────────────────
  bot.catch((err) => {
    console.error("[BOT] Error no capturado:", err.message);
    if (err.ctx) {
      console.error("[BOT] Update:", JSON.stringify(err.ctx.update, null, 2));
    }
  });

  return bot;
}
