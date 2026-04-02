// src/tools/landing_builder.ts
import { Tool } from "../shared/types.js";
import { buildExpertPrompt, LANDING_STYLES, AUTO_STYLE_RULES } from "./landing_prompts.js";
import Anthropic from "@anthropic-ai/sdk";
import db from "../memory/db.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANDINGS_DIR = process.env.LANDINGS_DIR || path.join(process.cwd(), "landings");
const PUBLIC_URL   = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");

function extractText(content: Anthropic.Messages.ContentBlock[]): string | null {
  const block = content.find(b => b.type === "text");
  return block && block.type === "text" ? block.text : null;
}

function ensureLandingsDir(): void {
  if (!fs.existsSync(LANDINGS_DIR)) fs.mkdirSync(LANDINGS_DIR, { recursive: true });
}

function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

async function generateHtml(params: {
  prompt:          string;
  style:           string;
  checkout_url:    string;
  pixel_id?:       string;
  ga_id?:          string;
  countdown_hours: number;
  video_url?:      string;
}): Promise<string> {
  const styleObj = LANDING_STYLES[params.style] || LANDING_STYLES.futuristic;

  const userPrompt = `
Crea una landing page con la siguiente información:

DESCRIPCIÓN DEL PRODUCTO:
${params.prompt}

ESTILO VISUAL: ${styleObj.name}
${styleObj.description}
Paleta de colores: ${styleObj.palette}

CHECKOUT URL (todos los botones de compra deben apuntar aquí): ${params.checkout_url}

${params.video_url ? `VIDEO URL: ${params.video_url}` : "Sin video — usa sección 'Por qué este curso' con 3 puntos clave"}
${params.pixel_id ? `META PIXEL ID: ${params.pixel_id}` : ""}
${params.ga_id ? `GOOGLE ANALYTICS ID: ${params.ga_id}` : ""}
COUNTDOWN TIMER: ${params.countdown_hours > 0 ? `${params.countdown_hours} horas desde ahora` : "7 días desde hoy"}

Genera el HTML completo ahora.
`;

  const response = await client.messages.create({
    model:      "claude-opus-4-6",
    max_tokens: 8000,
    messages: [
      { role: "user", content: userPrompt },
    ],
    system: buildExpertPrompt({
      checkout_url:    params.checkout_url,
      style:           params.style,
      pixel_id:        params.pixel_id,
      ga_id:           params.ga_id,
      video_url:       params.video_url,
      countdown_hours: params.countdown_hours,
    }),
  });

  const text = response.content
    .filter(b => b.type === "text")
    .map(b => (b as any).text as string)
    .join("");

  // Extraer solo el HTML (Claude puede agregar texto antes/después)
  const htmlMatch = text.match(/<!DOCTYPE html>[\s\S]*/i);
  return htmlMatch ? htmlMatch[0] : text;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function createLanding(params: Record<string, any>): Promise<string> {
  const {
    prompt,
    checkout_url = "https://pay.hotmart.com/CONFIGURE_URL",
    pixel_id,
    ga_id,
    video_url,
    countdown_hours = 48,
  } = params;

  if (!prompt) return "❌ Falta el parámetro: prompt";

  // Determinar estilo
  let style = (params.style as string) || "auto";
  if (style === "auto") {
    // Pedir a Claude que elija el estilo
    const styleResponse = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: `Basado en este producto: "${prompt}"\n\n${AUTO_STYLE_RULES}\n\nResponde SOLO con el ID del estilo (futuristic, premium, energetic, corporate, natural o bold):` }],
    });
    const chosen = extractText(styleResponse.content)?.trim().toLowerCase() ?? "futuristic";
    style = Object.keys(LANDING_STYLES).includes(chosen) ? chosen : "futuristic";
  }

  ensureLandingsDir();

  // Extraer título del prompt para el slug
  const titleResponse = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 30,
    messages: [{ role: "user", content: `Extrae el nombre del curso/producto de este texto en máximo 5 palabras: "${prompt}". Responde solo el nombre, sin puntuación.` }],
  });
  const title = extractText(titleResponse.content)?.trim() ?? "landing";

  const slug     = generateSlug(title);
  const htmlPath = path.join(LANDINGS_DIR, `${slug}.html`);

  // Generar HTML con Claude Opus
  const html = await generateHtml({
    prompt,
    style,
    checkout_url,
    pixel_id,
    ga_id,
    countdown_hours: Number(countdown_hours),
    video_url,
  });

  fs.writeFileSync(htmlPath, html, "utf-8");

  try {
    db.prepare(`
      INSERT INTO landings (slug, title, style, checkout_url, pixel_id, ga_id, html_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(slug, title, style, checkout_url || null, pixel_id || null, ga_id || null, htmlPath);
  } catch (dbErr) {
    try { fs.unlinkSync(htmlPath); } catch { /* ignore cleanup error */ }
    throw dbErr;
  }

  const url = `${PUBLIC_URL}/l/${slug}`;

  return `✅ *Landing creada exitosamente*\n\n` +
    `🌐 URL: ${url}\n` +
    `🎨 Estilo: ${LANDING_STYLES[style]?.name ?? style}\n` +
    `📋 Título: ${title}\n` +
    `💳 Checkout: ${checkout_url}\n\n` +
    `La página ya está publicada y accesible.`;
}

function listLandings(): string {
  const rows = db.prepare(
    `SELECT slug, title, style, checkout_url, created_at, views FROM landings ORDER BY created_at DESC LIMIT 20`
  ).all() as any[];

  if (rows.length === 0) return "📭 No hay landings creadas todavía.";

  const list = rows.map((r, i) =>
    `${i + 1}. *${r.title}* (${r.style})\n   🌐 ${PUBLIC_URL}/l/${r.slug}\n   👁 ${r.views} visitas · ${r.created_at}`
  ).join("\n\n");

  return `📋 *Landings creadas (${rows.length}):*\n\n${list}`;
}

function deleteLanding(slug: string): string {
  if (!slug) return "❌ Falta el parámetro: slug";

  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) return `❌ No existe una landing con slug: ${slug}`;

  // Eliminar archivo
  try { fs.unlinkSync(row.html_path); } catch { /* ya no existía */ }

  // Eliminar de DB
  db.prepare(`DELETE FROM landings WHERE slug = ?`).run(slug);

  return `🗑 Landing *${slug}* eliminada correctamente.`;
}

function getLanding(slug: string): string {
  if (!slug) return "❌ Falta el parámetro: slug";
  const row = db.prepare(`SELECT * FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) return `❌ No existe landing con slug: ${slug}`;

  return `📄 *Landing: ${row.title}*\n\n` +
    `🌐 URL: ${PUBLIC_URL}/l/${row.slug}\n` +
    `🎨 Estilo: ${row.style}\n` +
    `💳 Checkout: ${row.checkout_url ?? "no configurado"}\n` +
    `👁 Visitas: ${row.views}\n` +
    `📅 Creada: ${row.created_at}`;
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export const landingBuilderTool: Tool = {
  name: "landing_builder",
  description:
    "Crea, lista, consulta y elimina landing pages profesionales de alta conversión. " +
    "Genera HTML/CSS/JS completo con diseño experto, múltiples secciones (hero, beneficios, testimonios, FAQ, countdown, etc.) " +
    "y las publica automáticamente en el servidor con una URL pública.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create_landing", "list_landings", "delete_landing", "get_landing"],
        description: "create_landing: genera y publica una landing | list_landings: lista todas | delete_landing: elimina una | get_landing: detalles de una",
      },
      prompt: {
        type: "string",
        description: "Descripción del curso/producto/servicio. Puede ser texto libre: 'Curso de marketing digital para emprendedores, precio $197'",
      },
      style: {
        type: "string",
        enum: ["futuristic", "premium", "energetic", "corporate", "natural", "bold", "auto"],
        description: "Estilo visual. 'auto' = Jarvis elige según el nicho detectado",
      },
      checkout_url: {
        type: "string",
        description: "URL de pago (Hotmart, Stripe, MercadoPago, PayPal, etc.)",
      },
      pixel_id: {
        type: "string",
        description: "Meta Pixel ID para tracking (opcional)",
      },
      ga_id: {
        type: "string",
        description: "Google Analytics 4 ID, formato G-XXXXXXXX (opcional)",
      },
      countdown_hours: {
        type: "number",
        description: "Horas para el countdown timer de urgencia. Default: 48",
      },
      video_url: {
        type: "string",
        description: "URL de YouTube o Vimeo para embed en la landing (opcional)",
      },
      slug: {
        type: "string",
        description: "Slug de la landing para delete_landing y get_landing",
      },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, slug } = params as Record<string, any>;
    try {
      if (action === "create_landing") return await createLanding(params);
      if (action === "list_landings")  return listLandings();
      if (action === "delete_landing") return deleteLanding(slug);
      if (action === "get_landing")    return getLanding(slug);
      return "❌ Acción inválida.";
    } catch (err: any) {
      return `❌ Error en landing_builder: ${err.message as string}`;
    }
  },
};
