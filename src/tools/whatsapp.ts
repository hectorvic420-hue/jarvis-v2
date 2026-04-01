import { Tool } from "../shared/types.js";
import * as fs from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const EVOLUTION_BASE_URL = (process.env.EVOLUTION_API_URL || "http://127.0.0.1:8085").replace(/\/$/, "");
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY || "Jarvis_WA_Key_2026";
const INSTANCE_NAME      = process.env.EVOLUTION_INSTANCE || "jarvis";

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

// ─── Instance Management ──────────────────────────────────────────────────────
async function createInstance(name: string): Promise<string> {
    try {
        await evRequest("instance/create", "POST", {
            instanceName: name,
            integration: "WHATSAPP-BAILEYS",
            qrcode: false,
        });
        return `✅ Instancia "${name}" creada. Ahora pide el código de vinculación con tu número.`;
    } catch (err: any) {
        if (err.message.includes("403") || err.message.includes("already")) {
            return `⚠️ La instancia "${name}" ya existe. Pide el código de vinculación con tu número.`;
        }
        throw err;
    }
}

async function getPairingCode(name: string, number: string): Promise<string> {
    const cleanNumber = number.replace(/\D/g, "");
    try {
        const res = await evRequest(`instance/connect/${name}`, "GET");
        if (res.code) return `🔑 Código de vinculación: *${res.code as string}*\n\nEn tu WhatsApp → Dispositivos vinculados → Vincular con número de teléfono → ingresa el código.`;
        // Si no viene en el connect, solicitar explícitamente
        const res2 = await evRequest(`instance/connect/pairingCode/${name}`, "POST", { number: cleanNumber });
        if (res2.code) return `🔑 Código de vinculación: *${res2.code as string}*\n\nEn tu WhatsApp → Dispositivos vinculados → Vincular con número de teléfono → ingresa el código.`;
        return `❌ La API no devolvió un código. Verifica que la instancia esté creada.`;
    } catch (err: any) {
        return `❌ Error obteniendo código: ${err.message as string}`;
    }
}

// ─── Messaging exports (Needed for compilation) ───────────────────────────────
export async function sendText(to: string, text: string, _quotedId?: string): Promise<{success:boolean, error?:string}> {
    try {
        await evRequest(`message/sendText/${INSTANCE_NAME}`, "POST", { number: to.replace(/\D/g, ""), text });
        return { success: true };
    } catch (err: any) { return { success: false, error: err.message }; }
}

export async function sendAudio(_to: string, _path: string): Promise<any> { return { success: false }; }
export async function markAsRead(_jid: string, _id: string): Promise<void> {}
export async function sendTyping(_jid: string, _ms?: number): Promise<void> {}
export async function downloadMedia(_mid?: string, _jid?: string): Promise<{ buffer: Buffer; mimetype: string } | null> { return null; }
export function isWhitelisted(_n: string): boolean { return true; }
export function parseWebhookPayload(_b: any): WaMessage | null { return null; }

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const whatsappTool: Tool = {
    name: "whatsapp_manager",
    description: "Conecta WhatsApp mediante un código de vinculación de 8 dígitos.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["create", "pairing"] },
            number: { type: "string", description: "Número con código de país (ej: 57...)" }
        },
        required: ["action"]
    },
    async execute(params, _chatId) {
        const { action, number } = params as Record<string, any>;
        try {
            if (action === "create") return await createInstance(INSTANCE_NAME);
            if (action === "pairing" && number) return await getPairingCode(INSTANCE_NAME, number);
            return "❌ Acción inválida.";
        } catch (err: any) { return `❌ Error: ${err.message as string}`; }
    }
};
