import { Tool } from "../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

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
  
  const res = await fetch(url, {
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

  // Usamos el token específico de la página para insights
  const qs = new URLSearchParams({ metric: fields, period: "day", access_token: pToken }).toString();
  const url = `${GRAPH_BASE}${endpoint}?${qs}`;
  const res = await fetch(url);
  const data = await res.json() as ApiResponse;

  if (!data.data?.length) return `📊 Sin datos de insights para ${id}.`;
  
  const lines = [postId ? `📊 *Insights Post ${postId}*` : `📊 *Insights Página: ${id}*`];
  for (const metric of data.data) {
    const value = metric.values?.[metric.values.length - 1]?.value ?? 0;
    lines.push(`• ${metric.name}: ${value}`);
  }
  return lines.join("\n");
}

async function quickPost(pageIdOrName: string | undefined, message: string): Promise<string> {
  const { id, token: pToken } = await findPageCredentials(pageIdOrName);
  const url = `${GRAPH_BASE}/${id}/feed?access_token=${pToken}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data.error?.message || "Error publicando");
  return `✅ Publicado en ${id}\nID: ${data.id}`;
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const facebookPublisherTool: Tool = {
  name: "facebook_publisher",
  description: "Gestiona páginas de Facebook. Publica contenido y analiza métricas (insights).",
  parameters: {
    type: "object",
    properties: {
      action: { 
          type: "string", 
          enum: ["post_text", "get_insights", "list_pages"],
          description: "Acción a ejecutar" 
      },
      page_id: { 
          type: "string", 
          description: "ID o Nombre de la página (ej: 'David Academy' o '123456...')" 
      },
      message: { type: "string", description: "Texto del post" },
      post_id: { type: "string", description: "ID del post para insights específicos" }
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, page_id, message, post_id } = params as any;
    try {
        switch (action) {
            case "post_text":      return await quickPost(page_id, message);
            case "get_insights":   return await getInsights(page_id, post_id);
            case "list_pages":     
                const data = await graphRequest("/me/accounts", "GET", undefined, { fields: "id,name" });
                return "📋 Páginas:\n" + data.data.map((p: any) => `• ${p.name} (ID: ${p.id})`).join("\n");
            default: return `❌ Acción desconocida: ${action}`;
        }
    } catch (err: any) { return `❌ Error FB: ${err.message as string}`; }
  },
};
