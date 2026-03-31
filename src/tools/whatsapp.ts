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
            instanceName: name, qrcode: true 
        });
        return `✅ Instancia "${name}" creada.`;
    } catch (err: any) {
        if (err.message.includes("403")) return `⚠️ La instancia "${name}" ya existe.`;
        throw err;
    }
}

async function getPairingCode(name: string, number: string): Promise<string> {
    const cleanNumber = number.replace(/\D/g, "");
    try {
        const res = await evRequest(`instance/connect/pairingCode/${name}?number=${cleanNumber}`, "GET");
        if (res.code) return `🔑 Código: *${res.code as string}*.\n\nVincúlalo en tu teléfono.`;
        return `❌ Error: La API no devolvió un código.`;
    } catch (err: any) {
        return `❌ Error: ${err.message as string}`;
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
export async function downloadMedia(): Promise<null> { return null; }
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
