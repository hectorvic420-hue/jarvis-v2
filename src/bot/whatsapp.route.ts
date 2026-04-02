/**
 * src/routes/whatsapp.route.ts
 * Mount on your Express app:  app.use("/webhook/whatsapp", whatsappRouter);
 */

import { Router, Request, Response } from "express";
import {
  parseWebhookPayload,
  isWhitelisted,
  sendText,
  sendTyping,
  markAsRead,
  downloadMedia,
  WaMessage,
} from "../tools/whatsapp.js";
import { transcribeBuffer } from "../tools/voice";
import { processMediaBuffer, mimeTypeToExt } from "./media_processor.js";

import { runAgent } from "../agent.js";
import { tools as toolRegistry, SYSTEM_PROMPT } from "../tools/index.js";
import { memoryService } from "../memory/service.js";
import {
  isWizardTrigger, isWizardCancel, isWizardInterrupt, getWizardState,
  startWizard, getStepMessage, parseStepAnswer, advanceStep,
  generateWizardLanding, clearWizard, buildWizardStatus,
} from "./landing_wizard.js";

const router = Router();

// ─── POST /webhook/whatsapp ───────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  // Always ack first to avoid Evolution retries
  res.status(200).json({ status: "ok" });

  try {
    const msg = parseWebhookPayload(req.body);
    if (!msg) return;

    // Whitelist gate
    if (!isWhitelisted(msg.from_number)) {
      console.log(`[WA] Blocked: ${msg.from_number}`);
      return;
    }

    await processMessage(msg);
  } catch (err) {
    console.error("[WA Route] Error:", err);
  }
});

// ─── Message processor ────────────────────────────────────────────────────────
async function processMessage(msg: WaMessage): Promise<void> {
  console.log(`[WA] ${msg.from_number} → [${msg.type}] ${msg.body.slice(0, 80)}`);

  // Mark as read + show typing
  await markAsRead(msg.from, msg.message_id);
  await sendTyping(msg.from, 2000);

  let userInput = msg.body;

  // Handle voice messages: transcribe first
  if (msg.type === "audio" && msg.message_id) {
    const media = await downloadMedia(msg.message_id, msg.from);
    if (media) {
      const transcription = await transcribeBuffer(media.buffer, "ogg", "es");
      if (transcription.success && transcription.text) {
        userInput = `[Mensaje de voz transcrito]: ${transcription.text}`;
      } else {
        await sendText(msg.from, "No pude transcribir el audio. Por favor escríbeme.");
        return;
      }
    }
  }

  const userId = msg.from_number;

  // ── Image ────────────────────────────────────────────────────────────────
  if (msg.type === "image") {
    const mediaData = await downloadMedia(msg.message_id, msg.from);
    if (!mediaData) {
      await sendText(msg.from, "❌ No pude descargar la imagen. Intenta de nuevo.");
      return;
    }
    const mediaResult = await processMediaBuffer(mediaData.buffer, "photo.jpg");
    if (mediaResult.error) {
      await sendText(msg.from, mediaResult.error);
      return;
    }
    const caption = userInput || "Describe esta imagen en detalle";
    const uid = parseInt(userId.replace(/\D/g, ""), 10) || 0;
    memoryService.addMessage(uid, "user", `[imagen] ${caption}`, "whatsapp");
    const agentResult = await runAgent(caption, {
      tools: Object.values(toolRegistry),
      systemPrompt: SYSTEM_PROMPT,
      userId: uid,
      imageBlocks: mediaResult.imageBlock ? [mediaResult.imageBlock] : undefined,
    });
    memoryService.addMessage(uid, "assistant", agentResult.response, "whatsapp");
    const imgChunks = splitMessage(agentResult.response, 4000);
    for (const chunk of imgChunks) await sendText(msg.from, chunk);
    return;
  }

  // ── Document ─────────────────────────────────────────────────────────────
  if (msg.type === "document") {
    const mediaData = await downloadMedia(msg.message_id, msg.from);
    if (!mediaData) {
      await sendText(msg.from, "❌ No pude descargar el documento. Intenta de nuevo.");
      return;
    }
    const ext = mimeTypeToExt(mediaData.mimetype);
    const mediaResult = await processMediaBuffer(mediaData.buffer, `documento.${ext}`);
    if (mediaResult.error) {
      await sendText(msg.from, mediaResult.error);
      return;
    }
    const caption = userInput || "Analiza este documento y explica su contenido";
    const uid = parseInt(userId.replace(/\D/g, ""), 10) || 0;
    memoryService.addMessage(uid, "user", `[documento] ${caption}`, "whatsapp");
    const agentResult = await runAgent(caption, {
      tools: Object.values(toolRegistry),
      systemPrompt: SYSTEM_PROMPT,
      userId: uid,
      imageBlocks:   mediaResult.imageBlock   ? [mediaResult.imageBlock]   : undefined,
      extractedText: mediaResult.extractedText,
    });
    memoryService.addMessage(uid, "assistant", agentResult.response, "whatsapp");
    const docChunks = splitMessage(agentResult.response, 4000);
    for (const chunk of docChunks) await sendText(msg.from, chunk);
    return;
  }

  if (!userInput.trim() && msg.type === "text") return;

  // ─── Wizard Flow ──────────────────────────────────────────────────────────
  const wizard = getWizardState(userId);
  if (wizard) {
    // Cancelar wizard
    if (isWizardCancel(userInput)) {
      clearWizard(userId);
      await sendText(msg.from, "✅ Wizard cancelado. Puedo ayudarte con otra cosa.");
      return;
    }

    // Interrupción: usuario manda algo que no es respuesta al paso actual
    if (isWizardInterrupt(userInput) && !wizardInProgress(wizard, userInput)) {
      const status = buildWizardStatus(wizard);
      await sendText(msg.from,
        `💬 Estás en medio del wizard de landing.\n\n${status}\n\n` +
        `¿Seguimos con tu landing o prefieres otra cosa?\n` +
        `• Escribe *cancelar* para salir del wizard\n` +
        `• O responde la pregunta de arriba`
      );
      return;
    }

    await handleWizard(wizard, userInput, msg.from);
    return;
  }

  // ─── Wizard Trigger ───────────────────────────────────────────────────────
  if (isWizardTrigger(userInput)) {
    const state = startWizard("whatsapp", userId);
    await sendText(msg.from,
      "🚀 *Vamos a crear tu landing page!*\n\n" +
      "Te voy a hacer 7 preguntas rápidas.\n\n" +
      getStepMessage(state)
    );
    return;
  }

  // ─── Command handling (parity with Telegrambot) ───────────────────────────
  const cmd = userInput.trim().toLowerCase();
  
  if (cmd === "/ayuda" || cmd === "ayuda") {
    await sendText(msg.from, 
      "📋 *Jarvis WhatsApp — Comandos*\n\n" +
      "• /ayuda — Esta ayuda\n" +
      "• /estado — Ver estado del sistema\n" +
      "• /confirmar — Ejecutar orden pendiente\n" +
      "• /cancelar — Cancelar orden pendiente\n\n" +
      "O simplemente escríbeme lo que necesites."
    );
    return;
  }

  if (cmd === "/confirmar" || cmd === "confirmar") {
    await sendTyping(msg.from, 1000);
    const tools = Object.values(toolRegistry);
    try {
      const result = await runAgent("ACCIÓN CONFIRMADA POR EL USUARIO: /confirmar", { 
        tools, 
        systemPrompt: SYSTEM_PROMPT, 
        userId: parseInt(msg.from_number.replace(/\D/g, "")) || 0
      });
      await sendText(msg.from, result.response);
    } catch (err: any) {
      await sendText(msg.from, `❌ Error: ${err.message}`);
    }
    return;
  }

  if (cmd === "/cancelar" || cmd === "cancelar") {
    // Para simplificar, usamos runAgent para limpiar estados si se desea, 
    // o simplemente avisamos. El agente detectará la intención si hay pendiente.
    const result = await runAgent("EL USUARIO CANCELÓ LA ACCIÓN: /cancelar", { 
      tools: Object.values(toolRegistry), 
      systemPrompt: SYSTEM_PROMPT, 
      userId: parseInt(msg.from_number.replace(/\D/g, "")) || 0
    });
    await sendText(msg.from, result.response);
    return;
  }

  if (cmd === "/estado" || cmd === "estado") {
    const toolNames = Object.keys(toolRegistry);
    await sendText(msg.from, 
      `⚙️ *Jarvis v2 Status*\n\n` +
      `🔧 Herramientas: ${toolNames.length}\n` +
      `📱 Usuario: ${msg.from_number}\n` +
      `✅ Sistema Online`
    );
    return;
  }

  // ─── Agent Processing ─────────────────────────────────────────────────────
  try {
    const tools = Object.values(toolRegistry);
    const uid = parseInt(userId.replace(/\D/g, "")) || 0;

    // Guardar mensaje en DB
    memoryService.addMessage(uid, "user", userInput, "whatsapp");

    const agentResult = await runAgent(userInput, { 
      tools, 
      systemPrompt: SYSTEM_PROMPT, 
      userId: uid
    });
    
    // Guardar respuesta en DB
    memoryService.addMessage(uid, "assistant", agentResult.response, "whatsapp");

    // Add warning if exists (e.g. Gemini fallback warning)
    const replyText = agentResult.warning 
      ? `${agentResult.warning}\n\n${agentResult.response}`
      : agentResult.response;

    // ── Send response ─────────────────────────────────────────────────────────
    const chunks = splitMessage(replyText, 4000);
    for (const chunk of chunks) {
      await sendText(msg.from, chunk, msg.message_id);
    }
  } catch (err: any) {
    console.error("[WA] Agent error:", err);
    await sendText(msg.from, "Ocurrió un error procesando tu mensaje.");
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function wizardInProgress(wizard: import("./landing_wizard.js").LandingWizardState, answer: string): boolean {
  const result = parseStepAnswer(wizard, answer);
  return result.updated;
}

async function handleWizard(
  wizard: import("./landing_wizard.js").LandingWizardState,
  answer: string,
  chatId: string
): Promise<void> {
  const parsed = parseStepAnswer(wizard, answer);

  if (!parsed.updated) {
    await sendText(chatId, `❌ ${parsed.error}\n\n${getStepMessage(wizard)}`);
    return;
  }

  advanceStep(wizard);

  if (wizard.step >= 7) {
    await sendText(chatId, "🎉 ¡Generando tu landing page!");
    const result = await generateWizardLanding(wizard);
    await sendText(chatId, result);
    return;
  }

  await sendText(chatId, getStepMessage(wizard));
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let chunk = remaining.slice(0, maxLen);
    // Try to split at last newline
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl > maxLen * 0.6) chunk = chunk.slice(0, lastNl);
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

export default router;
