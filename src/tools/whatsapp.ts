import { Tool } from "../shared/types.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN    || "";
const GRAPH_BASE      = "https://graph.facebook.com/v19.0";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WaMessage {
  message_id: string;
  from: string;
  from_number: string;
  body: string;
  type: "text" | "audio" | "image" | "document" | "video" | "sticker" | "unknown";
  timestamp: number;
  is_group: boolean;
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function cloudPost(endpoint: string, body: object): Promise<any> {
  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    throw new Error("Faltan WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN");
  }
  const res = await fetch(`${GRAPH_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${ACCESS_TOKEN}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (!res.ok) throw new Error(data?.error?.message || `Meta API ${res.status}`);
  return data;
}

// ─── Send Text ────────────────────────────────────────────────────────────────
export async function sendText(
  to: string,
  text: string,
  _quotedId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const clean = to.replace(/\D/g, "");
    await cloudPost(`${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to: clean,
      type: "text",
      text: { body: text },
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Send Template ────────────────────────────────────────────────────────────
async function sendTemplate(to: string, templateName: string, langCode = "es"): Promise<string> {
  const clean = to.replace(/\D/g, "");
  await cloudPost(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to: clean,
    type: "template",
    template: { name: templateName, language: { code: langCode } },
  });
  return `✅ Template "${templateName}" enviado a ${to}`;
}

// ─── Parse Webhook ────────────────────────────────────────────────────────────
export function parseWebhookPayload(body: any): WaMessage | null {
  try {
    const entry   = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msg     = value?.messages?.[0];

    if (!msg) return null;

    const from = msg.from as string;
    let text   = "";
    let type: WaMessage["type"] = "unknown";

    if (msg.type === "text") {
      text = msg.text?.body ?? "";
      type = "text";
    } else if (msg.type === "audio") {
      type = "audio";
    } else if (msg.type === "image") {
      type = "image";
    } else if (msg.type === "document") {
      type = "document";
    } else if (msg.type === "video") {
      type = "video";
    }

    return {
      message_id:  msg.id as string,
      from:        from,
      from_number: from,
      body:        text,
      type,
      timestamp:   parseInt(msg.timestamp as string) * 1000,
      is_group:    false,
    };
  } catch {
    return null;
  }
}

// ─── Stubs (mantener compatibilidad) ─────────────────────────────────────────
export async function sendAudio(_to: string, _path: string): Promise<any> { return { success: false }; }
export async function markAsRead(_jid: string, _id: string): Promise<void> {}
export async function sendTyping(_jid: string, _ms?: number): Promise<void> {}
export async function downloadMedia(_mid?: string, _jid?: string): Promise<{ buffer: Buffer; mimetype: string } | null> { return null; }
export function isWhitelisted(_n: string): boolean { return true; }

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const whatsappTool: Tool = {
  name: "whatsapp_manager",
  description:
    "Envía mensajes de WhatsApp via Meta Cloud API. Puede enviar texto libre o plantillas aprobadas.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send_text", "send_template"],
        description: "send_text: mensaje libre | send_template: plantilla aprobada",
      },
      to:       { type: "string", description: "Número destino con código de país (ej: 573245597160)" },
      text:     { type: "string", description: "Texto a enviar (send_text)" },
      template: { type: "string", description: "Nombre de la plantilla (send_template)" },
      lang:     { type: "string", description: "Código de idioma (default: es)" },
    },
    required: ["action", "to"],
  },

  async execute(params, _chatId) {
    const { action, to, text, template, lang } = params as Record<string, any>;
    try {
      if (action === "send_text") {
        if (!text) return "❌ Falta parámetro: text";
        const res = await sendText(to, text);
        return res.success ? `✅ Mensaje enviado a ${to as string}` : `❌ Error: ${res.error}`;
      }
      if (action === "send_template") {
        if (!template) return "❌ Falta parámetro: template";
        return await sendTemplate(to, template, lang ?? "es");
      }
      return "❌ Acción inválida.";
    } catch (err: any) {
      return `❌ Error: ${err.message as string}`;
    }
  },
};
