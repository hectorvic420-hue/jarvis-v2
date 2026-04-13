// src/bot/landing_wizard.ts
import { landingBuilderTool } from "../tools/landing_builder.js";
import { LANDING_STYLES } from "../tools/landing_prompts.js";
import { getWizard, saveWizard, removeWizard } from "../repositories/wizardRepository.js";

export interface LandingWizardState {
  userId:    string;    // incluido para persistencia SQLite
  step:      number;
  channel:   "whatsapp" | "telegram";
  data:      Partial<LandingParams>;
  startedAt: number;
}

export interface LandingParams {
  prompt:           string;
  product_type:     string;
  title:            string;
  description:      string;
  audience:         string;
  price:            string;
  checkout_url:     string;
  video_url:        string;
  style:            string;
  pixel_id:         string;
  ga_id:            string;
  countdown_hours:  number;
}

const WIZARD_TRIGGERS = [
  "crea una landing", "necesito una landing", "página de ventas",
  "hazme un funnel", "quiero una landing", "landing page",
  "crear landing", "págima de ventas", "necesito una página",
  "crea un landing", "quiero una página de ventas",
];

const WIZARD_CANCEL_TRIGGERS = [
  "cancelar", "parar", "salir", "abortar", "empezar de nuevo",
  "otra cosa", "olvídalo", "no quiero",
];

export const WIZARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

export function isWizardTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return WIZARD_TRIGGERS.some(t => lower.includes(t));
}

export function isWizardCancel(text: string): boolean {
  const lower = text.toLowerCase().trim();
  return WIZARD_CANCEL_TRIGGERS.some(t => lower === t || lower.startsWith(t + " "));
}

export function isWizardInterrupt(text: string): boolean {
  if (isWizardTrigger(text)) return false;
  if (isWizardCancel(text)) return false;
  return text.trim().length > 0;
}

export function getWizardState(userId: string): LandingWizardState | undefined {
  return getWizard(userId);
}

export function startWizard(channel: "whatsapp" | "telegram", userId: string): LandingWizardState {
  const state: LandingWizardState = {
    userId,
    step: 0,
    channel,
    data: {},
    startedAt: Date.now(),
  };
  saveWizard(state);
  return state;
}

export function clearWizard(userId: string): void {
  removeWizard(userId);
}

function getStyleEmoji(style: string): string {
  const map: Record<string, string> = {
    futuristic: "🚀", premium: "✨", energetic: "🔥",
    corporate: "💼", natural: "🌿", bold: "💜",
  };
  return map[style] || "🎨";
}

function formatStyles(): string {
  return Object.values(LANDING_STYLES).map(s =>
    `${getStyleEmoji(s.id)} *${s.name}*`
  ).join("  ");
}

export const STEP_MESSAGES: Record<number, { q: string }> = {
  0: {
    q: "🏷️ *¿Qué quieres vender?*\n\n1️⃣ Curso online\n2️⃣ Servicio/Digital\n3️⃣ Membresía\n4️⃣ Producto físico\n\n_Escribe el número o el nombre_",
  },
  1: {
    q: "📝 *¿Cómo se llama tu producto?*\n\nDame el nombre y una descripción breve (2-3 líneas).\n\n_Ejemplo: Masterclass de Marketing Digital — Aprende a vender online sin invertir en ads desde cero_",
  },
  2: {
    q: "👥 *¿A quién va dirigido?*\n\nDescribe tu cliente ideal en 1-3 oraciones.\n\n_Ejemplo: Emprendedores que quieren escalar sus ventas online sin depender de ads_",
  },
  3: {
    q: "💰 *¿Cuál es el precio y la URL de pago?*\n\n_Ejemplo: $197 USD — https://pay.hotmart.com/123456_\n\nSi no tienes URL aún, dime solo el precio.",
  },
  4: {
    q: "🎬 *¿Tienes un video de presentación?*\n\nPega la URL de YouTube o Vimeo.\n\nEscribe *no* si no tienes video.",
  },
  5: {
    q: `🎨 *¿Qué estilo visual prefieres?*\n\n${formatStyles()}\n\n_Escribe el número, el nombre o *auto* para que Jarvis elija_`,
  },
  6: {
    q: "📊 *¿Tracking opcional?*\n\n• Meta Pixel ID → _escribe: pixel 123456789_\n• Google Analytics → _escribe: G-XXXXXXXX_\n\nEscribe *no* para omitir ambos.",
  },
};

export function getStepMessage(state: LandingWizardState): string {
  return STEP_MESSAGES[state.step]?.q ?? "";
}

export function getStepLabel(step: number): string {
  const labels: Record<number, string> = {
    0: "tipo de producto", 1: "nombre del producto", 2: "audiencia",
    3: "precio y checkout", 4: "video", 5: "estilo visual", 6: "tracking",
  };
  return labels[step] ?? "";
}

export function parseStepAnswer(state: LandingWizardState, answer: string): { updated: boolean; error?: string } {
  const text = answer.trim();
  const data = state.data;

  switch (state.step) {
    case 0: {
      const map: Record<string, string> = {
        "1": "curso", "2": "servicio", "3": "membresía", "4": "producto",
        "curso": "curso", "cursito": "curso", "servicio": "servicio",
        "servicios": "servicio", "membresía": "membresía", "membresia": "membresía",
        "producto": "producto", "productos": "producto",
        "físico": "producto", "fisico": "producto",
      };
      const found = map[text.toLowerCase()];
      if (!found) return { updated: false, error: "Elige 1, 2, 3 o 4." };
      data.product_type = found;
      break;
    }
    case 1: {
      if (text.length < 5) return { updated: false, error: "La descripción es muy corta. Dame más detalles." };
      const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
      data.title = lines[0] || text.slice(0, 60);
      data.description = lines.slice(1).join(" ").trim() || lines[0] || text;
      data.prompt = text;
      break;
    }
    case 2: {
      if (text.length < 3) return { updated: false, error: "Describe tu audiencia con más detalle." };
      data.audience = text;
      break;
    }
    case 3: {
      const priceMatch = text.match(/[\$€]?\s?\d+[\.,]?\d*\s?(?:usd|dólar|dolares|euros|eur)?/i);
      if (!priceMatch) return { updated: false, error: "Indica el precio (ej: $197 o 197 USD)." };
      const urlMatch = text.match(/https?:\/\/\S+/i);
      data.price = priceMatch[0].replace(/^\$/, "$").toUpperCase();
      data.checkout_url = urlMatch ? urlMatch[0] : "https://pay.hotmart.com/CONFIGURE";
      break;
    }
    case 4: {
      const lower = text.toLowerCase();
      if (lower === "no" || lower === "n" || lower === "no tengo" || lower === "sin video") {
        data.video_url = "";
        break;
      }
      if (/youtube\.com|youtu\.be|vimeo\.com/.test(text)) {
        data.video_url = text;
        break;
      }
      return { updated: false, error: "URL de YouTube/Vimeo no válida. Escribe *no* para omitir." };
    }
    case 5: {
      const styleMap: Record<string, string> = {
        "1": "futuristic", "2": "premium", "3": "energetic",
        "4": "corporate", "5": "natural", "6": "bold",
        "futuristic": "futuristic", "futurista": "futuristic",
        "premium": "premium",
        "energético": "energetic", "energetic": "energetic", "energia": "energetic",
        "corporate": "corporate", "corporativo": "corporate", "corporation": "corporate",
        "natural": "natural", "naturaln": "natural",
        "bold": "bold",
        "auto": "auto", "automático": "auto", "automatico": "auto", "elige tú": "auto",
        " tú": "auto", "vos": "auto", "default": "auto",
      };
      const found = styleMap[text.toLowerCase().trim()];
      if (!found) return { updated: false, error: "Estilo no reconocido. Elige 1-6, un nombre, o *auto*." };
      data.style = found;
      break;
    }
    case 6: {
      const lower = text.toLowerCase();
      if (lower === "no" || lower === "n" || lower === "omitir" || lower === "ninguno") {
        data.pixel_id = "";
        data.ga_id = "";
        break;
      }
      const pixelMatch = text.match(/pixel[:\s]*(\d{6,})/i);
      const gaMatch = text.match(/G-[A-Z0-9]+/i);
      const pixelOnlyMatch = !pixelMatch ? text.match(/(\d{6,})/) : null;
      data.pixel_id = pixelMatch ? pixelMatch[1] : (pixelOnlyMatch ? pixelOnlyMatch[1] : "");
      data.ga_id = gaMatch ? gaMatch[0] : "";
      break;
    }
    default:
      return { updated: false };
  }

  state.startedAt = Date.now();
  saveWizard(state);   // persistir cambio en SQLite
  return { updated: true };
}

export function advanceStep(state: LandingWizardState): void {
  state.step++;
  state.startedAt = Date.now();
  saveWizard(state);   // persistir cambio en SQLite
}

export async function generateWizardLanding(state: LandingWizardState): Promise<string> {
  const d = state.data;

  const prompt = d.prompt ||
    `${d.title || "Producto"}\n\n${d.description || ""}\n\nPara: ${d.audience || "emprendedores"}`;

  try {
    const result = await landingBuilderTool.execute({
      action: "create_landing",
      prompt,
      style: d.style || "auto",
      checkout_url: d.checkout_url || "https://pay.hotmart.com/CONFIGURE",
      pixel_id: d.pixel_id || undefined,
      ga_id: d.ga_id || undefined,
      video_url: d.video_url || undefined,
      countdown_hours: 48,
    }, `wizard-${state.channel}`);

    clearWizard(state.userId);
    return result;
  } catch (err: any) {
    clearWizard(state.userId);
    return `❌ Error generando landing: ${err.message}`;
  }
}

export function getStyleName(style: string): string {
  return LANDING_STYLES[style]?.name ?? style;
}

export function buildWizardStatus(state: LandingWizardState): string {
  const stepLabel = getStepLabel(state.step);
  const totalSteps = 7;
  const current = state.step + 1;
  return `📊 *Progreso del Wizard*\n\nPaso ${current}/${totalSteps}: ${stepLabel}`;
}
