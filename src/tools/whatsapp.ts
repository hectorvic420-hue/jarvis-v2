import { Tool } from "../shared/types.js";
import * as fs from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const EVOLUTION_BASE_URL = process.env.EVOLUTION_API_URL?.replace(/\/$/, "") ?? "";
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE_NAME      = process.env.EVOLUTION_INSTANCE ?? "jarvis";

const RAW_WHITELIST = process.env.WA_WHITELIST ?? "";
const WHITELIST: Set<string> = new Set(
  RAW_WHITELIST.split(",").map((n) => n.trim()).filter(Boolean)
);

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WaMessage {
  message_id: string;
  from: string;
  from_number: string;
  body: string;
  type: "text" | "audio" | "image" | "document" | "video" | "sticker" | "unknown";
  timestamp: number;
  is_group: boolean;
  group_id?: string;
  media_url?: string;
  media_mimetype?: string;
}

export interface SendResult {
  success: boolean;
  message_id?: string;
  error?: string;
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────
async function evRequest(endpoint: string, method: string, body?: object): Promise<any> {
    const url = `${EVOLUTION_BASE_URL}/${endpoint}`;
    const response = await fetch(url, {
        method,
        headers: {
            "Content-Type": "application/json",
            apikey: EVOLUTION_API_KEY,
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Evolution API ${response.status}: ${err}`);
    }
    return response.json();
}

// ─── Whitelist check ──────────────────────────────────────────────────────────
export function isWhitelisted(number: string): boolean {
  if (WHITELIST.size === 0) return true;
  const clean = number.replace(/\D/g, "");
  return WHITELIST.has(clean);
}

// ─── Instance Management ──────────────────────────────────────────────────────
async function createInstance(name: string): Promise<string> {
    try {
        await evRequest("instance/create", "POST", { 
            instanceName: name,
            token: EVOLUTION_API_KEY,
            qrcode: true 
        });
        return `✅ Instancia "${name}" creada con éxito.`;
    } catch (err: any) {
        if (err.message.includes("403")) return `⚠️ La instancia "${name}" ya existe.`;
        throw err;
    }
}

async function getPairingCode(name: string, number: string): Promise<string> {
    const res = await evRequest(`instance/connect/pairingCode/${name}?number=${number}`, "GET");
    if (res.code) return `🔑 Tu código de vinculación de WhatsApp es: *${res.code as string}*.\n\nIngrésalo en tu teléfono.`;
    return "❌ No se pudo generar el código de vinculación.";
}

async function getQrCode(name: string): Promise<string> {
    const res = await evRequest(`instance/connect/generateQrCode/${name}`, "GET");
    if (res.base64) return `📸 Código QR generado.`;
    return "❌ No se pudo generar el código QR.";
}

// ─── Messaging exports (Strict compatibility with whatsapp.route.ts) ───────────
export async function sendText(to: string, text: string, quotedId?: string): Promise<SendResult> {
    try {
        const number = to.replace(/\D/g, "");
        const body: any = { number, text };
        if (quotedId) body.quoted = { key: { id: quotedId } };
        
        const data = await evRequest(`message/sendText/${INSTANCE_NAME}`, "POST", body);
        return { success: true, message_id: data?.key?.id };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function sendAudio(to: string, audioPath: string): Promise<SendResult> {
    try {
        const number = to.replace(/\D/g, "");
        const buffer = fs.readFileSync(audioPath);
        const base64 = buffer.toString("base64");
        const data = await evRequest(`message/sendMedia/${INSTANCE_NAME}`, "POST", {
            number,
            mediatype: "audio",
            media: base64,
            mimetype: "audio/ogg; codecs=opus"
        });
        return { success: true, message_id: data?.key?.id };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

export async function markAsRead(remoteJid: string, messageId: string): Promise<void> {
    try {
        await evRequest(`message/readMessages/${INSTANCE_NAME}`, "POST", { 
            readMessages: [{ remoteJid, id: messageId, fromMe: false }] 
        });
    } catch {}
}

export async function sendTyping(remoteJid: string, durationMs = 2000): Promise<void> {
    try {
        await evRequest(`message/sendPresence/${INSTANCE_NAME}`, "POST", { 
            number: remoteJid.replace(/\D/g, ""),
            options: { presence: "composing", delay: durationMs }
        });
    } catch {}
}

export async function downloadMedia(messageId: string, remoteJid: string): Promise<{ buffer: Buffer; mimetype: string } | null> {
    try {
        const data = await evRequest(`chat/getBase64FromMediaMessage/${INSTANCE_NAME}`, "POST", {
            message: { key: { id: messageId, remoteJid } }
        });
        if (!data.base64) return null;
        return {
            buffer: Buffer.from(data.base64, "base64"),
            mimetype: data.mimetype ?? "application/octet-stream"
        };
    } catch { return null; }
}

export function parseWebhookPayload(body: any): WaMessage | null {
    try {
        const data = body?.data;
        if (!data) return null;
        const key = data.key ?? {};
        const from = key.remoteJid ?? "";
        return {
            message_id: key.id ?? "",
            from,
            from_number: from.replace(/\D/g, ""),
            body: data.message?.conversation ?? data.message?.extendedTextMessage?.text ?? "",
            type: data.message?.audioMessage ? "audio" : "text",
            timestamp: Date.now(),
            is_group: from.endsWith("@g.us")
        };
    } catch { return null; }
}

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const whatsappTool: Tool = {
    name: "whatsapp_manager",
    description: "Maneja la conexión de WhatsApp. Permite crear instancias, obtener códigos de vinculación (pairing) y códigos QR.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["create", "qr", "pairing", "send"] },
            name:   { type: "string", description: "Nombre de la instancia" },
            number: { type: "string", description: "Número con código de país para vincular" },
            text:   { type: "string", description: "Texto a enviar" },
            to:     { type: "string", description: "Número de destino" }
        },
        required: ["action"]
    },
    async execute(params, _chatId) {
        const { action, name, number, text, to } = params as Record<string, any>;
        const inst = name ?? INSTANCE_NAME;
        try {
            switch (action) {
                case "create":  return await createInstance(inst);
                case "qr":      return await getQrCode(inst);
                case "pairing": return await getPairingCode(inst, number as string);
                case "send":    const r = await sendText(to as string, text as string); return r.success ? "✅ Enviado" : `❌ ${r.error as string}`;
                default:        return "❌ Acción desconocida.";
            }
        } catch (err: any) { return `❌ Error en WA: ${err.message as string}`; }
    }
};
