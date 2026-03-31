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

// Import your existing agent runner (adjust path as needed)
// import { runAgent } from "../agent";

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

  try {
    // ── Call your agent ───────────────────────────────────────────────────────
    // const agentResponse = await runAgent(userInput, { source: "whatsapp", from: msg.from_number });
    // const replyText = agentResponse.text;

    // Placeholder until agent is wired:
    const replyText = `[JARVIS] Recibí: "${userInput}" — agente no conectado aún.`;

    // ── Send response ─────────────────────────────────────────────────────────
    // Split long messages (WA limit ~4096 chars)
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
