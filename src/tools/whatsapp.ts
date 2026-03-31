import { Tool } from "../shared/types.js";
import * as fs from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const EVOLUTION_BASE_URL = process.env.EVOLUTION_API_URL?.replace(/\/$/, "") ?? "";
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE_NAME      = process.env.EVOLUTION_INSTANCE ?? "jarvis";

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
    if (res.code) return `🔑 Tu código de vinculación de WhatsApp es: *${res.code as string}*.\n\nIngrésalo en tu teléfono (Dispositivos vinculados > Vincular con número de teléfono).`;
    return "❌ No se pudo generar el código de vinculación.";
}

async function getQrCode(name: string): Promise<string> {
    const res = await evRequest(`instance/connect/generateQrCode/${name}`, "GET");
    if (res.base64) return `📸 Código QR generado. Escanéalo en WhatsApp para vincular.\n\n(Base64 data disponible)`;
    return "❌ No se pudo generar el código QR.";
}

// ─── Send Tools ────────────────────────────────────────────────────────────────
async function sendText(to: string, text: string): Promise<string> {
    const number = to.replace(/\D/g, "");
    await evRequest(`message/sendText/${INSTANCE_NAME}`, "POST", { number, text });
    return `✅ Mensaje enviado a ${number}`;
}

// ─── Tool Registry ────────────────────────────────────────────────────────────
export const whatsappTool: Tool = {
    name: "whatsapp_manager",
    description: "Maneja la conexión de WhatsApp. Permite crear instancias, obtener códigos de vinculación (pairing) y códigos QR.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["create", "qr", "pairing", "send"] },
            name:   { type: "string", description: "Nombre de la instancia (ej: 'jarvis')" },
            number: { type: "string", description: "Número de teléfono para vincular (con código de país, ej: 521...)" },
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
                case "send":    return await sendText(to as string, text as string);
                default:        return "❌ Acción de WhatsApp desconocida.";
            }
        } catch (err: any) {
            return `❌ Error en WhatsApp: ${err.message as string}`;
        }
    }
};
