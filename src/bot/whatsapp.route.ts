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
  sendAudio,
  markAsRead,
  downloadMedia,
  WaMessage,
} from "../tools/whatsapp";
import { transcribeBuffer } from "../tools/voice";
import { textToSpeech }     from "../tools/voice";

import { runAgent } from "../agent.js";
import { tools as toolRegistry } from "../tools/index.js";
import { memoryService } from "../memory/service.js";

const SYSTEM_PROMPT =
  `Eres Jarvis, un agente de IA personal altamente capaz, preciso y eficiente. ` +
  `Ayudas a tu usuario con tareas complejas usando las herramientas disponibles. ` +
  `Responde siempre en el mismo idioma que el usuario (por defecto, español). ` +
  `Sé directo, concreto y útil. Evita respuestas genéricas. ` +
  `Cuando uses herramientas, explica brevemente qué hiciste y qué encontraste. ` +
  `Nunca inventes datos — usa las herramientas para información real. ` +
  `Si no puedes completar una tarea, explica con claridad por qué.`;

const router = Router();

// ─── POST /webhook/whatsapp ───────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  // Always ack first to avoid Evolution retries
  res.status(200).json({ status: "ok" });

  try {
    const msg = parseWebhookPayload(req.body);
    if (!msg) return;

    // Ignore own messages
    if (req.body?.data?.key?.fromMe === true) return;

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

  if (!userInput.trim()) return;

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
    const userId = parseInt(msg.from_number.replace(/\D/g, "")) || 0;

    // Guardar mensaje en DB
    memoryService.addMessage(userId, "user", userInput, "whatsapp");

    const agentResult = await runAgent(userInput, { 
      tools, 
      systemPrompt: SYSTEM_PROMPT, 
      userId
    });
    
    // Guardar respuesta en DB
    memoryService.addMessage(userId, "assistant", agentResult.response, "whatsapp");

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
