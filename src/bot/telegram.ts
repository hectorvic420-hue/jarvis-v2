import { Bot, Context, session, SessionFlavor, InputFile } from "grammy";
import { runAgent }       from "../agent";
import { tools as toolRegistry, listTools, SYSTEM_PROMPT } from "../tools/index.js";
import { memoryService } from "../memory/service.js";
import {
  isWizardTrigger, isWizardCancel, getWizardState, startWizard,
  getStepMessage, parseStepAnswer, advanceStep, generateWizardLanding,
  clearWizard, buildWizardStatus, WIZARD_MAP,
} from "./landing_wizard.js";
import { processMediaBuffer } from "./media_processor.js";
import { screenshotStore } from "../tools/browser_control.js";

// ─── Session ──────────────────────────────────────────────────────────────────

interface PendingAction {
  label:   string;
  message: string;
}

interface WizardSession {
  step: number;
  data: Record<string, string>;
  startedAt: number;
}

interface SessionData {
  pendingAction?: PendingAction;
  wizard?: WizardSession;
}

type BotCtx = Context & SessionFlavor<SessionData>;

// ─── System prompt ────────────────────────────────────────────────────────────

const systemPrompt = SYSTEM_PROMPT;

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

async function sendAgentResponse(ctx: BotCtx, response: string, chatId: string): Promise<void> {
  const screenshotPath = screenshotStore.get(chatId);
  if (screenshotPath) {
    screenshotStore.delete(chatId);
    try {
      await ctx.replyWithPhoto(new InputFile(screenshotPath));
    } catch (err) {
      console.error("[BOT] Error enviando screenshot:", (err as Error).message);
    }
  }
  await sendLong(ctx, response);
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
        `/cancelar   — Cancelar acción pendiente\n\n` +
        `💡 También puedes decir "crea una landing" para iniciar el wizard interactivo.`,
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

    const list = facts.map((f, i) => `${i + 1}. *${f.key}*: ${f.value}`).join("\n");
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
    if (!ctx.from) { await ctx.reply("⚠️ No pude identificar tu usuario."); return; }
    const chatId = String(ctx.from.id);
    ctx.session.pendingAction = undefined;
    if (ctx.session.wizard) {
      clearWizard(chatId);
      ctx.session.wizard = undefined;
      await ctx.reply("✅ Wizard de landing cancelado.", { parse_mode: "Markdown" });
    } else {
      ctx.session.pendingAction = undefined;
      await ctx.reply("✅ No había acción pendiente.", { parse_mode: "Markdown" });
    }
  });

  // ── Mensajes de texto ─────────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text   = ctx.message.text;
    const userId = ctx.from.id;
    const chatId = String(userId);

    // ─── Wizard: Sync from session ──────────────────────────────────────────
    if (ctx.session.wizard) {
      const existing = WIZARD_MAP.get(chatId);
      if (!existing || existing.startedAt !== ctx.session.wizard.startedAt) {
        WIZARD_MAP.set(chatId, {
          step: ctx.session.wizard.step,
          channel: "telegram",
          data: ctx.session.wizard.data,
          startedAt: ctx.session.wizard.startedAt,
        });
      }
    }

    // ─── Wizard Flow ────────────────────────────────────────────────────────
    const wizard = getWizardState(chatId);
    if (wizard) {
      if (isWizardCancel(text)) {
        clearWizard(chatId);
        ctx.session.wizard = undefined;
        await ctx.reply("✅ Wizard cancelado. Puedo ayudarte con otra cosa.", { parse_mode: "Markdown" });
        return;
      }

      const parsed = parseStepAnswer(wizard, text);
      if (!parsed.updated) {
        await ctx.reply(`❌ ${parsed.error}\n\n${getStepMessage(wizard)}`, { parse_mode: "Markdown" });
        return;
      }

      advanceStep(wizard);
      ctx.session.wizard = { step: wizard.step, data: wizard.data as Record<string, string>, startedAt: wizard.startedAt };

      if (wizard.step >= 7) {
        await ctx.reply("🎉 ¡Generando tu landing page!");
        const result = await generateWizardLanding(wizard);
        await sendLong(ctx, result);
        clearWizard(chatId);
        ctx.session.wizard = undefined;
        return;
      }

      await ctx.reply(getStepMessage(wizard), { parse_mode: "Markdown" });
      return;
    }

    // ─── Wizard Trigger ──────────────────────────────────────────────────────
    if (isWizardTrigger(text)) {
      const state = startWizard("telegram", chatId);
      ctx.session.wizard = { step: 0, data: {}, startedAt: state.startedAt };
      await ctx.reply(
        "🚀 *Vamos a crear tu landing page!*\n\n" +
        "Te voy a hacer 7 preguntas rápidas.\n\n" +
        getStepMessage(state),
        { parse_mode: "Markdown" }
      );
      return;
    }

    // ─── Normal Agent Flow ───────────────────────────────────────────────────
    const tools  = Object.values(toolRegistry);

    memoryService.addMessage(userId, "user", text, "telegram");

    const processingMsg = await ctx.reply("⏳ Procesando...");

    try {
      const result = await runAgent(text, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
      });

      await tryDelete(ctx, processingMsg.message_id);

      memoryService.addMessage(userId, "assistant", result.response, "telegram");

      const response = result.warning
        ? `${result.warning}\n\n${result.response}`
        : result.response;

      await sendAgentResponse(ctx, response, chatId);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      const msg = (err as Error).message;
      console.error("[BOT] Error en handler:", msg);
      await ctx.reply(`❌ Error interno: ${msg}`);
    }
  });

  // ── Fotos ─────────────────────────────────────────────────────────────────
  bot.on("message:photo", async (ctx) => {
    const userId  = ctx.from.id;
    const photoArr = ctx.message.photo;
    if (!photoArr || photoArr.length === 0) {
      await ctx.reply("⚠️ No se recibió la imagen correctamente.");
      return;
    }
    const photo   = photoArr.at(-1)!;
    const caption = ctx.message.caption ?? "Describe esta imagen en detalle";

    const processingMsg = await ctx.reply("⏳ Analizando imagen...");
    try {
      const fileInfo = await ctx.api.getFile(photo.file_id);
      const url      = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res      = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer   = Buffer.from(await res.arrayBuffer());

      const media = await processMediaBuffer(buffer, "photo.jpg");
      if (media.error) {
        await tryDelete(ctx, processingMsg.message_id);
        await ctx.reply(media.error);
        return;
      }

      const tools = Object.values(toolRegistry);
      memoryService.addMessage(userId, "user", `[imagen] ${caption}`, "telegram");

      const result = await runAgent(caption, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
        imageBlocks: media.imageBlock ? [media.imageBlock] : undefined,
      });

      await tryDelete(ctx, processingMsg.message_id);
      memoryService.addMessage(userId, "assistant", result.response, "telegram");
      await sendLong(ctx, result.response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      await ctx.reply(`❌ Error analizando imagen: ${(err as Error).message}`);
    }
  });

  // ── Documentos ───────────────────────────────────────────────────────────
  bot.on("message:document", async (ctx) => {
    const userId   = ctx.from.id;
    const doc      = ctx.message.document;
    const caption  = ctx.message.caption ?? "Analiza este documento y explica su contenido";
    const filename = doc.file_name ?? "documento.bin";

    const processingMsg = await ctx.reply("⏳ Leyendo documento...");
    try {
      const fileInfo = await ctx.api.getFile(doc.file_id);
      const url      = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res      = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer   = Buffer.from(await res.arrayBuffer());

      const media = await processMediaBuffer(buffer, filename);
      if (media.error) {
        await tryDelete(ctx, processingMsg.message_id);
        await ctx.reply(media.error);
        return;
      }

      const tools = Object.values(toolRegistry);
      memoryService.addMessage(userId, "user", `[doc: ${filename}] ${caption}`, "telegram");

      const result = await runAgent(caption, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
        imageBlocks:   media.imageBlock   ? [media.imageBlock]   : undefined,
        extractedText: media.extractedText,
      });

      await tryDelete(ctx, processingMsg.message_id);
      memoryService.addMessage(userId, "assistant", result.response, "telegram");
      await sendLong(ctx, result.response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      await ctx.reply(`❌ Error leyendo documento: ${(err as Error).message}`);
    }
  });

  // ── Otros mensajes (videos, stickers, audio sin voz…) ────────────────────
  bot.on("message", async (ctx) => {
    await ctx.reply(
      "❌ No puedo procesar ese tipo de archivo. Envíame texto, fotos, PDFs, Word (.docx) o Excel (.xlsx)."
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
