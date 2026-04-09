

import { Tool } from "../shared/types.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const WHAPI_TOKEN   = process.env.WHAPI_TOKEN   || "";
const WHAPI_API_URL = process.env.WHAPI_API_URL || "https://gate.whapi.cloud";
const FETCH_TIMEOUT = 30000;
const MAX_MEDIA_SIZE = 50 * 1024 * 1024; // 50MB

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WaMessage {
  message_id:  string;
  from:        string;   // chat_id con sufijo: 573245597160@s.whatsapp.net
  from_number: string;   // solo dígitos: 573245597160
  body:        string;
  type: "text" | "audio" | "image" | "document" | "video" | "sticker" | "unknown";
  timestamp:   number;
  is_group:    boolean;
  caption?:    string;
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function whapiRequest(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: object
): Promise<any> {
  if (!WHAPI_TOKEN) throw new Error("Falta WHAPI_TOKEN en .env");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(`${WHAPI_API_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${WHAPI_TOKEN}`,
        "Content-Type":  "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const data = await res.json() as any;
    if (!res.ok) throw new Error(data?.error?.message || data?.message || `Whapi ${res.status}`);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Phone helpers ────────────────────────────────────────────────────────────
/** Convierte "573245597160" → "573245597160@s.whatsapp.net" si no tiene sufijo */
function toChatId(to: string): string {
  const clean = to.replace(/\D/g, "");
  if (to.includes("@")) return to;         // ya tiene sufijo
  return `${clean}@s.whatsapp.net`;
}

/** Extrae solo dígitos del chat_id: "573245597160@s.whatsapp.net" → "573245597160" */
function toNumber(chatId: string): string {
  return chatId.split("@")[0].replace(/\D/g, "");
}

// ─── Send Text ────────────────────────────────────────────────────────────────
export async function sendText(
  to: string,
  text: string,
  quotedId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const payload: Record<string, any> = {
      to:   toChatId(to),
      body: text,
    };
    if (quotedId) payload.quoted = quotedId;

    await whapiRequest("POST", "/messages/text", payload);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Send Audio ───────────────────────────────────────────────────────────────
export async function sendAudio(
  to: string,
  urlOrPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await whapiRequest("POST", "/messages/audio", {
      to:    toChatId(to),
      audio: urlOrPath,   // URL pública o base64
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Mark as Read ─────────────────────────────────────────────────────────────
export async function markAsRead(chatId: string, messageId: string): Promise<void> {
  try {
    await whapiRequest("PUT", `/messages/${messageId}/read`);
  } catch {
    // no-op: no bloquear flujo si falla
  }
}

// ─── Send Typing ──────────────────────────────────────────────────────────────
export async function sendTyping(chatId: string, ms = 2000): Promise<void> {
  try {
    await whapiRequest("POST", `/chats/${encodeURIComponent(toChatId(chatId))}/typing`, { ms });
  } catch {
    // no-op
  }
}

// ─── Download Media ───────────────────────────────────────────────────────────
export async function downloadMedia(
  messageId?: string,
  _chatId?: string
): Promise<{ buffer: Buffer; mimetype: string } | null> {
  if (!messageId) return null;
  try {
    const msg = await whapiRequest("GET", `/messages/${messageId}`);
    const mediaUrl: string | undefined =
      msg?.audio?.link ?? msg?.image?.link ?? msg?.video?.link ?? msg?.document?.link;

    if (!mediaUrl) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(mediaUrl, {
        headers: { "Authorization": `Bearer ${WHAPI_TOKEN}` },
        signal: controller.signal,
      });
      if (!res.ok) return null;

      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const size = parseInt(contentLength, 10);
        if (!isNaN(size) && size > MAX_MEDIA_SIZE) {
          throw new Error(`Archivo demasiado grande: ${(size / 1024 / 1024).toFixed(1)}MB (límite: 50MB)`);
        }
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length > MAX_MEDIA_SIZE) {
        throw new Error(`Archivo demasiado grande: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (límite: 50MB)`);
      }
      const mimetype = res.headers.get("content-type") ?? "application/octet-stream";
      return { buffer, mimetype };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

// ─── Whitelist ────────────────────────────────────────────────────────────────
const WHITELIST = (process.env.WHATSAPP_WHITELIST || "")
  .split(",")
  .map(n => n.trim())
  .filter(Boolean);

export function isWhitelisted(number: string): boolean {
  if (WHITELIST.length === 0) return true;          // sin lista = todos permitidos
  const clean = number.replace(/\D/g, "");
  return WHITELIST.some(w => w.replace(/\D/g, "") === clean);
}

// ─── Parse Webhook (formato Whapi) ───────────────────────────────────────────
export function parseWebhookPayload(body: any): WaMessage | null {
  try {
    // Whapi envía: { event: { type, event }, messages: [...] }
    const messages: any[] = body?.messages ?? [];
    const msg = messages[0];
    if (!msg) return null;

    // Ignorar mensajes propios
    if (msg.from_me === true) return null;

    const chatId = (msg.chat_id ?? msg.from) as string;
    let text = "";
    let type: WaMessage["type"] = "unknown";

    if (msg.type === "text") {
      text = msg.text?.body ?? "";
      type = "text";
    } else if (msg.type === "audio" || msg.type === "voice") {
      type = "audio";
    } else if (msg.type === "image") {
      type = "image";
      text = (msg.image?.caption as string | undefined) ?? "";
    } else if (msg.type === "document") {
      type = "document";
      text = (msg.document?.caption as string | undefined) ?? "";
    } else if (msg.type === "video") {
      type = "video";
    } else if (msg.type === "sticker") {
      type = "sticker";
    }

    return {
      message_id:  msg.id as string,
      from:        chatId,
      from_number: toNumber(chatId),
      body:        text,
      type,
      timestamp:   (msg.timestamp as number) * 1000,
      is_group:    chatId.endsWith("@g.us"),
    };
  } catch {
    return null;
  }
}

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const whatsappTool: Tool = {
  name: "whatsapp_manager",
  description:
    "Envía mensajes de WhatsApp via Whapi. Puede enviar texto libre o audio.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send_text", "send_audio"],
        description: "send_text: mensaje de texto | send_audio: URL de audio",
      },
      to:    { type: "string", description: "Número destino con código de país (ej: 573245597160)" },
      text:  { type: "string", description: "Texto a enviar (send_text)" },
      audio: { type: "string", description: "URL pública del audio (send_audio)" },
    },
    required: ["action", "to"],
  },

  async execute(params, _chatId) {
    const { action, to, text, audio } = params as Record<string, any>;
    try {
      if (action === "send_text") {
        if (!text) return "❌ Falta parámetro: text";
        const res = await sendText(to, text);
        return res.success ? `✅ Mensaje enviado a ${to as string}` : `❌ Error: ${res.error}`;
      }
      if (action === "send_audio") {
        if (!audio) return "❌ Falta parámetro: audio";
        const res = await sendAudio(to, audio);
        return res.success ? `✅ Audio enviado a ${to as string}` : `❌ Error: ${res.error}`;
      }
      return "❌ Acción inválida.";
    } catch (err: any) {
      return `❌ Error: ${err.message as string}`;
    }
  },
};
