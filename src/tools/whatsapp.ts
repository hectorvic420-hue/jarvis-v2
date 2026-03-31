import fetch from "node-fetch";
import * as fs from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────
const EVOLUTION_BASE_URL = process.env.EVOLUTION_API_URL?.replace(/\/$/, "") ?? "";
const EVOLUTION_API_KEY  = process.env.EVOLUTION_API_KEY ?? "";
const INSTANCE_NAME      = process.env.EVOLUTION_INSTANCE ?? "jarvis";

// Whitelist: phone numbers allowed to interact with JARVIS
// Format: "5219XXXXXXXXX" (country code + number, no + or spaces)
const RAW_WHITELIST = process.env.WA_WHITELIST ?? "";
const WHITELIST: Set<string> = new Set(
  RAW_WHITELIST.split(",").map((n) => n.trim()).filter(Boolean)
);

// ─── Types ────────────────────────────────────────────────────────────────────
export interface WaMessage {
  message_id: string;
  from: string;         // number@s.whatsapp.net
  from_number: string;  // clean number
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

// ─── Parse Evolution webhook payload ─────────────────────────────────────────
export function parseWebhookPayload(body: any): WaMessage | null {
  try {
    const data = body?.data;
    if (!data) return null;

    const key   = data.key ?? {};
    const msg   = data.message ?? {};
    const from  = key.remoteJid ?? "";

    const fromNumber = from.replace("@s.whatsapp.net", "").replace("@g.us", "");
    const isGroup    = from.endsWith("@g.us");

    // Determine type and body
    let type: WaMessage["type"] = "unknown";
    let textBody = "";
    let mediaUrl: string | undefined;
    let mediaMimetype: string | undefined;

    if (msg.conversation || msg.extendedTextMessage?.text) {
      type = "text";
      textBody = msg.conversation ?? msg.extendedTextMessage?.text ?? "";
    } else if (msg.audioMessage) {
      type = "audio";
      mediaUrl = data.message?.audioMessage?.url;
      mediaMimetype = "audio/ogg";
    } else if (msg.imageMessage) {
      type = "image";
      textBody = msg.imageMessage.caption ?? "";
      mediaUrl = data.message?.imageMessage?.url;
      mediaMimetype = msg.imageMessage.mimetype;
    } else if (msg.documentMessage) {
      type = "document";
      textBody = msg.documentMessage.caption ?? msg.documentMessage.fileName ?? "";
      mediaUrl = data.message?.documentMessage?.url;
    } else if (msg.videoMessage) {
      type = "video";
      textBody = msg.videoMessage.caption ?? "";
    } else if (msg.stickerMessage) {
      type = "sticker";
    }

    return {
      message_id: key.id ?? "",
      from,
      from_number: fromNumber,
      body: textBody,
      type,
      timestamp: data.messageTimestamp ?? Math.floor(Date.now() / 1000),
      is_group: isGroup,
      group_id: isGroup ? from : undefined,
      media_url: mediaUrl,
      media_mimetype: mediaMimetype,
    };
  } catch {
    return null;
  }
}

// ─── Whitelist check ──────────────────────────────────────────────────────────
export function isWhitelisted(number: string): boolean {
  if (WHITELIST.size === 0) return true; // open if no whitelist configured
  const clean = number.replace(/\D/g, "");
  return WHITELIST.has(clean);
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function evRequest(endpoint: string, body: object): Promise<any> {
  const url = `${EVOLUTION_BASE_URL}/${endpoint}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Evolution API ${response.status}: ${err}`);
  }

  return response.json();
}

// ─── Send text message ────────────────────────────────────────────────────────
export async function sendText(
  to: string,
  text: string,
  quotedMessageId?: string
): Promise<SendResult> {
  try {
    const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;

    const payload: any = {
      number,
      text,
    };

    if (quotedMessageId) {
      payload.quoted = { key: { id: quotedMessageId } };
    }

    const data = await evRequest(`message/sendText/${INSTANCE_NAME}`, payload);
    return { success: true, message_id: data?.key?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Send audio ───────────────────────────────────────────────────────────────
export async function sendAudio(
  to: string,
  audioPath: string
): Promise<SendResult> {
  try {
    const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;
    const buffer = fs.readFileSync(audioPath);
    const base64 = buffer.toString("base64");
    const mimetype = audioPath.endsWith(".ogg") ? "audio/ogg; codecs=opus" : "audio/mpeg";

    const data = await evRequest(`message/sendMedia/${INSTANCE_NAME}`, {
      number,
      mediatype: "audio",
      media: base64,
      mimetype,
    });

    return { success: true, message_id: data?.key?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Send image ───────────────────────────────────────────────────────────────
export async function sendImage(
  to: string,
  imagePath: string,
  caption?: string
): Promise<SendResult> {
  try {
    const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;
    const buffer = fs.readFileSync(imagePath);
    const base64 = buffer.toString("base64");
    const ext = imagePath.split(".").pop()?.toLowerCase();
    const mimetype = ext === "png" ? "image/png" : "image/jpeg";

    const data = await evRequest(`message/sendMedia/${INSTANCE_NAME}`, {
      number,
      mediatype: "image",
      media: base64,
      mimetype,
      caption: caption ?? "",
    });

    return { success: true, message_id: data?.key?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Send document ────────────────────────────────────────────────────────────
export async function sendDocument(
  to: string,
  filePath: string,
  filename?: string,
  caption?: string
): Promise<SendResult> {
  try {
    const number = to.includes("@") ? to.replace("@s.whatsapp.net", "") : to;
    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString("base64");
    const name = filename ?? filePath.split("/").pop() ?? "file";

    const data = await evRequest(`message/sendMedia/${INSTANCE_NAME}`, {
      number,
      mediatype: "document",
      media: base64,
      mimetype: "application/octet-stream",
      fileName: name,
      caption: caption ?? "",
    });

    return { success: true, message_id: data?.key?.id };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ─── Mark as read ─────────────────────────────────────────────────────────────
export async function markAsRead(
  remoteJid: string,
  messageId: string
): Promise<void> {
  try {
    await evRequest(`message/readMessages/${INSTANCE_NAME}`, {
      readMessages: [{ remoteJid, id: messageId, fromMe: false }],
    });
  } catch { /* non-critical */ }
}

// ─── Send typing indicator ────────────────────────────────────────────────────
export async function sendTyping(
  remoteJid: string,
  durationMs = 2000
): Promise<void> {
  try {
    await evRequest(`message/sendPresence/${INSTANCE_NAME}`, {
      number: remoteJid.replace("@s.whatsapp.net", ""),
      options: { presence: "composing", delay: durationMs },
    });
  } catch { /* non-critical */ }
}

// ─── Download media from Evolution ───────────────────────────────────────────
export async function downloadMedia(
  messageId: string,
  remoteJid: string
): Promise<{ buffer: Buffer; mimetype: string } | null> {
  try {
    const url = `${EVOLUTION_BASE_URL}/chat/getBase64FromMediaMessage/${INSTANCE_NAME}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_API_KEY },
      body: JSON.stringify({ message: { key: { id: messageId, remoteJid } } }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as any;
    const base64 = data?.base64;
    if (!base64) return null;

    return {
      buffer: Buffer.from(base64, "base64"),
      mimetype: data.mimetype ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

// ─── Webhook handler factory ──────────────────────────────────────────────────
export type MessageHandler = (msg: WaMessage) => Promise<void>;

export function createWebhookHandler(handler: MessageHandler) {
  return async (req: any, res: any) => {
    try {
      // Ack immediately
      res.status(200).json({ status: "ok" });

      const msg = parseWebhookPayload(req.body);
      if (!msg) return;

      // Ignore own messages
      if (req.body?.data?.key?.fromMe) return;

      // Whitelist check
      if (!isWhitelisted(msg.from_number)) {
        console.log(`[WA] Blocked non-whitelisted: ${msg.from_number}`);
        return;
      }

      await handler(msg);
    } catch (err) {
      console.error("[WA] Webhook error:", err);
    }
  };
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export const whatsappTools = {
  send_text: sendText,
  send_audio: sendAudio,
  send_image: sendImage,
  send_document: sendDocument,
  mark_as_read: markAsRead,
  send_typing: sendTyping,
  download_media: downloadMedia,
  is_whitelisted: isWhitelisted,
  parse_webhook: parseWebhookPayload,
};
