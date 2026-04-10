import { Tool } from "../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const GRAPH_BASE = "https://graph.facebook.com/v19.0";
const FETCH_TIMEOUT = 30000;

// ─── Horarios permitidos para publicación ───────────────────────────────────────

const ALLOWED_HOURS = [6, 9, 12, 15, 18]; // 6am, 9am, 12pm, 3pm, 6pm

function isWithinAllowedHours(): boolean {
  const now = new Date();
  const hour = now.getHours();
  return ALLOWED_HOURS.includes(hour);
}

/** Devuelve la siguiente fecha/hora en un slot autorizado (mínimo 10 min en el futuro). */
function getNextAllowedSlotDate(): Date {
  const now = new Date();
  // Hora actual en Bogotá (UTC-5)
  const bogotaOffsetMs = -5 * 60 * 60 * 1000;
  const bogotaNow = new Date(now.getTime() + bogotaOffsetMs);
  const currentHour = bogotaNow.getUTCHours();
  const currentMin  = bogotaNow.getUTCMinutes();

  for (const h of ALLOWED_HOURS) {
    const isSameHour = h === currentHour && currentMin < 50;
    const isFuture   = h > currentHour;
    if (isFuture || isSameHour) {
      // Construir fecha en UTC que corresponde a 'h:00 Bogotá'
      const slotBogota = new Date(bogotaNow);
      slotBogota.setUTCHours(h, 0, 0, 0);
      const slotUtc = new Date(slotBogota.getTime() - bogotaOffsetMs);
      if (slotUtc.getTime() - now.getTime() >= 10 * 60 * 1000) return slotUtc;
    }
  }
  // Todos los slots de hoy pasaron → mañana 6am Bogotá
  const tomorrowBogota = new Date(bogotaNow);
  tomorrowBogota.setUTCDate(tomorrowBogota.getUTCDate() + 1);
  tomorrowBogota.setUTCHours(ALLOWED_HOURS[0], 0, 0, 0);
  return new Date(tomorrowBogota.getTime() - bogotaOffsetMs);
}

function formatNextAllowedTime(): string {
  const next = getNextAllowedSlotDate();
  return next.toLocaleString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
}

// ─── Rate limiting & deduplication ───────────────────────────────────────────

const POST_COOLDOWN_MS = 60_000;
const MAX_POSTS_PER_HOUR = 5;
let lastPostTime = 0;
let postTimestamps: number[] = [];
let lastPostContent = "";
let lastPublishedPostId: string | null = null;

function checkRateLimit(): string | null {
  const now = Date.now();

  // Solo verificar cooldown si hay una publicación previa
  if (lastPostTime > 0 && now - lastPostTime < POST_COOLDOWN_MS) {
    return `⚠️ Rate limit: Espera ${Math.ceil((POST_COOLDOWN_MS - (now - lastPostTime)) / 1000)}s antes de publicar de nuevo.`;
  }

  // Filtrar timestamps fuera de la ventana horaria
  postTimestamps = postTimestamps.filter(t => now - t < 3_600_000);
  if (postTimestamps.length >= MAX_POSTS_PER_HOUR) {
    const oldestInWindow = Math.min(...postTimestamps);
    const waitSeconds = Math.ceil((3_600_000 - (now - oldestInWindow)) / 1000);
    return `⚠️ Límite horario: Ya se hicieron ${MAX_POSTS_PER_HOUR} publicaciones esta hora. Espera ${waitSeconds}s antes de publicar más.`;
  }

  return null;
}

function recordPost(content: string): void {
  const now = Date.now();
  lastPostTime = now;
  postTimestamps.push(now);
  lastPostContent = content;
}

function resetRateLimit(): void {
  lastPostTime = 0;
  postTimestamps = [];
  lastPostContent = "";
}

function isDuplicateContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  const lastNormalized = lastPostContent.trim().toLowerCase();
  // Solo considerar duplicado si hay contenido previo
  if (!lastPostContent) return false;
  return normalized === lastNormalized || normalized.includes(lastNormalized) || lastNormalized.includes(normalized);
}

// ─── Schedule validation ─────────────────────────────────────────────────────

function validateSchedule(schedule?: string): { valid: boolean; error?: string; delayMs?: number } {
  if (!schedule) return { valid: true };
  
  try {
    const now = new Date();
    const scheduled = new Date(schedule);
    
    if (isNaN(scheduled.getTime())) {
      return { valid: false, error: `Fecha inválida: ${schedule}` };
    }
    
    if (scheduled <= now) {
      return { valid: false, error: `La fecha ${schedule} ya pasó. Usa una fecha futura.` };
    }
    
    const delayMs = scheduled.getTime() - now.getTime();
    const maxDelay = 24 * 60 * 60 * 1000;
    
    if (delayMs > maxDelay) {
      return { valid: false, error: "No se puede programar con más de 24h de anticipación." };
    }
    
    return { valid: true, delayMs };
  } catch (err) {
    return { valid: false, error: `Error validando fecha: ${(err as Error).message}` };
  }
}

// ─── HTTP Helper with timeout ─────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Graph API helper ─────────────────────────────────────────────────────────

function globalToken(): string {
  const t = process.env.META_PAGE_ACCESS_TOKEN;
  if (!t) throw new Error("META_PAGE_ACCESS_TOKEN no configurado");
  return t;
}

function globalPageId(): string {
  const p = process.env.META_PAGE_ID;
  if (!p) throw new Error("META_PAGE_ID no configurado");
  return p;
}

async function graphRequest(endpoint: string, method: string, body?: object, queryParams: Record<string, string> = {}): Promise<ApiResponse> {
  const t = globalToken();
  const qs = new URLSearchParams({ ...queryParams, access_token: t }).toString();
  const url = `${GRAPH_BASE}${endpoint}?${qs}`;
  
  const res = await fetchWithTimeout(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) {
    throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Graph API error ${res.status}`);
  }
  return data;
}

// ─── Page Credential Finder ───────────────────────────────────────────────────

async function findPageCredentials(pageIdOrName?: string): Promise<{ id: string; token: string }> {
  console.log(`[FB] Buscando credenciales para: ${pageIdOrName || "Global Default"}...`);
  const data = await graphRequest("/me/accounts", "GET", undefined, { fields: "id,name,access_token,tasks" });
  
  if (!pageIdOrName) return { id: globalPageId(), token: globalToken() };

  const page = data.data?.find((p: any) => 
    p.name.toLowerCase().includes(pageIdOrName.toLowerCase()) || p.id === pageIdOrName
  );

  if (!page || !page.access_token) {
    console.warn(`[FB] No encontré credenciales para '${pageIdOrName}'. Usando configuración base.`);
    return { id: globalPageId(), token: globalToken() };
  }

  console.log(`[FB] Usando Página: '${page.name}' (ID: ${page.id})`);
  return { id: page.id, token: page.access_token };
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function getInsights(pageIdOrName?: string, postId?: string): Promise<string> {
  const { id, token: pToken } = await findPageCredentials(pageIdOrName);
  
  let endpoint = `/${id}/insights`;
  let fields = "page_impressions,page_impressions_unique,page_engaged_users,page_fan_adds,page_views_total";

  if (postId) {
    endpoint = `/${postId}/insights`;
    fields = "post_impressions,post_impressions_unique,post_engaged_users,post_clicks";
  }

  const qs = new URLSearchParams({ metric: fields, period: "day", access_token: pToken }).toString();
  const url = `${GRAPH_BASE}${endpoint}?${qs}`;
  const res = await fetchWithTimeout(url);
  const data = await res.json() as ApiResponse;

  if (!data.data?.length) return `📊 Sin datos de insights para ${id}.`;
  
  const lines = [postId ? `📊 *Insights Post ${postId}*` : `📊 *Insights Página: ${id}*`];
  for (const metric of data.data) {
    const value = metric.values?.[metric.values.length - 1]?.value ?? 0;
    lines.push(`• ${metric.name}: ${value}`);
  }
  return lines.join("\n");
}

async function quickPost(pageIdOrName: string | undefined, message: string, schedule?: string): Promise<string> {
  if (!message || message.trim().length === 0) {
    return "❌ Error: No se proporcionó mensaje para publicar.";
  }

  if (isDuplicateContent(message)) {
    return "⚠️ Contenido duplicado: Este mensaje es idéntico a la última publicación.";
  }

  const rateLimitError = checkRateLimit();
  if (rateLimitError) return rateLimitError;

  // Determinar cuándo publicar:
  // 1. Si el usuario pasó un schedule explícito → usar ese
  // 2. Si estamos fuera de horario → auto-programar al próximo slot
  // 3. Si estamos en horario → publicar ahora
  let scheduledTs: number | undefined;
  let scheduledLabel: string | undefined;

  if (schedule) {
    const t = new Date(schedule);
    if (isNaN(t.getTime())) return `❌ Fecha inválida: ${schedule}`;
    scheduledTs    = Math.floor(t.getTime() / 1000);
    scheduledLabel = t.toLocaleString("es-CO", { timeZone: "America/Bogota" });
  } else if (!isWithinAllowedHours()) {
    const next     = getNextAllowedSlotDate();
    scheduledTs    = Math.floor(next.getTime() / 1000);
    scheduledLabel = formatNextAllowedTime();
  }

  const { id, token: pToken } = await findPageCredentials(pageIdOrName);
  const url = `${GRAPH_BASE}/${id}/feed?access_token=${pToken}`;
  const body: Record<string, unknown> = { message };
  if (scheduledTs) {
    body.published             = false;
    body.scheduled_publish_time = scheduledTs;
  }

  const res = await fetchWithTimeout(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error?.message || "Error publicando");

  recordPost(message);
  lastPublishedPostId = data.id;

  if (scheduledTs) {
    return `⏳ Publicación programada en Facebook para *${scheduledLabel}*\nPost ID: ${data.id}\n_(Facebook publicará automáticamente aunque Jarvis esté apagado)_`;
  }
  return `✅ Publicado en ${id}\nPost ID: ${data.id}`;
}

async function postImage(pageIdOrName: string | undefined, imageUrl: string, message: string, schedule?: string): Promise<string> {
  if (!imageUrl || imageUrl.trim().length === 0) {
    return "❌ Error: No se proporcionó URL de imagen.";
  }

  const rateLimitError = checkRateLimit();
  if (rateLimitError) return rateLimitError;

  let scheduledTs: number | undefined;
  let scheduledLabel: string | undefined;

  if (schedule) {
    const t = new Date(schedule);
    if (isNaN(t.getTime())) return `❌ Fecha inválida: ${schedule}`;
    scheduledTs    = Math.floor(t.getTime() / 1000);
    scheduledLabel = t.toLocaleString("es-CO", { timeZone: "America/Bogota" });
  } else if (!isWithinAllowedHours()) {
    const next     = getNextAllowedSlotDate();
    scheduledTs    = Math.floor(next.getTime() / 1000);
    scheduledLabel = formatNextAllowedTime();
  }

  const { id, token: pToken } = await findPageCredentials(pageIdOrName);
  const url = `${GRAPH_BASE}/${id}/photos?access_token=${pToken}`;
  const body: Record<string, unknown> = { url: imageUrl, message };
  if (scheduledTs) {
    body.published              = false;
    body.scheduled_publish_time = scheduledTs;
  }

  const res = await fetchWithTimeout(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error?.message || "Error publicando imagen");

  recordPost(`[IMAGEN] ${message}`);
  lastPublishedPostId = data.post_id ?? data.id;

  if (scheduledTs) {
    return `⏳ Imagen programada en Facebook para *${scheduledLabel}*\nPost ID: ${data.post_id ?? data.id}`;
  }
  return `✅ Imagen publicada en ${id}\nPost ID: ${data.post_id ?? data.id}`;
}

async function postVideo(pageIdOrName: string | undefined, videoUrl: string, description: string, title: string, schedule?: string): Promise<string> {
  if (!videoUrl || videoUrl.trim().length === 0) {
    return "❌ Error: No se proporcionó URL de video.";
  }

  const rateLimitError = checkRateLimit();
  if (rateLimitError) return rateLimitError;

  let scheduledTs: number | undefined;
  let scheduledLabel: string | undefined;

  if (schedule) {
    const t = new Date(schedule);
    if (isNaN(t.getTime())) return `❌ Fecha inválida: ${schedule}`;
    scheduledTs    = Math.floor(t.getTime() / 1000);
    scheduledLabel = t.toLocaleString("es-CO", { timeZone: "America/Bogota" });
  } else if (!isWithinAllowedHours()) {
    const next     = getNextAllowedSlotDate();
    scheduledTs    = Math.floor(next.getTime() / 1000);
    scheduledLabel = formatNextAllowedTime();
  }

  const { id, token: pToken } = await findPageCredentials(pageIdOrName);
  const url = `${GRAPH_BASE}/${id}/videos?access_token=${pToken}`;
  const body: Record<string, unknown> = { file_url: videoUrl, description, title };
  if (scheduledTs) {
    body.published              = false;
    body.scheduled_publish_time = scheduledTs;
  }

  const res = await fetchWithTimeout(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error?.message || "Error publicando video");

  recordPost(`[VIDEO] ${title}: ${description}`);
  lastPublishedPostId = data.id;

  if (scheduledTs) {
    return `⏳ Video programado en Facebook para *${scheduledLabel}*\nVideo ID: ${data.id}`;
  }
  return `✅ Video publicado en ${id}\nVideo ID: ${data.id}`;
}

async function deletePost(postId: string): Promise<string> {
  const { id, token: pToken } = await findPageCredentials();
  const url = `${GRAPH_BASE}/${postId}?access_token=${pToken}`;
  const res = await fetchWithTimeout(url, { method: "DELETE" });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error?.message || "Error eliminando post");
  return `✅ Post ${postId} eliminado correctamente.`;
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const facebookPublisherTool: Tool = {
  name: "facebook_publisher",
  description: "Gestiona páginas de Facebook. Publica contenido y analiza métricas (insights). SOLO publica cuando el usuario lo solicita explícitamente.",
  parameters: {
    type: "object",
    properties: {
      action: {
          type: "string",
          enum: ["post_text", "post_image", "post_video", "get_insights", "list_pages", "delete_post", "reset_rate_limit"],
          description: "Acción a ejecutar"
      },
      page_id: {
          type: "string",
          description: "ID o Nombre de la página (ej: 'David Academy' o '123456...')"
      },
      message:   { type: "string", description: "Texto o descripción del post" },
      image_url: { type: "string", description: "URL pública de la imagen a publicar (para post_image)" },
      video_url: { type: "string", description: "URL pública del video a publicar (para post_video)" },
      title:     { type: "string", description: "Título del video (para post_video)" },
      post_id:   { type: "string", description: "ID del post para insights específicos o delete_post" },
      schedule:  { type: "string", description: "Fecha/hora ISO para programar publicación (opcional, ej: '2026-04-06T15:00:00-05:00')" }
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, page_id, message, image_url, video_url, title, post_id, schedule } = params as any;
    try {
        switch (action) {
            case "post_text":    return await quickPost(page_id, message ?? "", schedule);
            case "post_image":   return await postImage(page_id, image_url, message ?? "", schedule);
            case "post_video":   return await postVideo(page_id, video_url, message ?? "", title ?? "", schedule);
            case "delete_post":  return await deletePost(post_id);
            case "get_insights": return await getInsights(page_id, post_id);
            case "list_pages": {
                const data = await graphRequest("/me/accounts", "GET", undefined, { fields: "id,name" });
                return "📋 Páginas:\n" + data.data.map((p: any) => `• ${p.name} (ID: ${p.id})`).join("\n");
            }
            case "reset_rate_limit":
                resetRateLimit();
                return "✅ Rate limit reseteado. Ya puedes publicar sin restricciones.";
            default: return `❌ Acción desconocida: ${action}`;
        }
    } catch (err: any) { return `❌ Error FB: ${err.message as string}`; }
  },
};

export { lastPublishedPostId };
