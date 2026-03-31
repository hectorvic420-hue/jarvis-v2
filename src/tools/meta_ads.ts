import { Tool } from "../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

// ─── Auth helper ──────────────────────────────────────────────────────────────

function token(): string {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) throw new Error("META_ACCESS_TOKEN no configurado");
  return t;
}

async function adsGet(endpoint: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const qs = new URLSearchParams({ ...params, access_token: token() }).toString();
  const res = await fetch(`${GRAPH_BASE}${endpoint}?${qs}`);
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Ads API error ${res.status}`);
  return data;
}

async function adsPost(endpoint: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const res = await fetch(`${GRAPH_BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: token() }),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Ads API error ${res.status}`);
  return data;
}

async function adsDelete(endpoint: string): Promise<ApiResponse> {
  const qs = new URLSearchParams({ access_token: token() }).toString();
  const res = await fetch(`${GRAPH_BASE}${endpoint}?${qs}`, { method: "DELETE" });
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Ads API error ${res.status}`);
  return data;
}

// ─── Helper: find ad account ──────────────────────────────────────────────────

async function getAdAccountId(): Promise<string> {
  const me = await adsGet("/me/adaccounts", { fields: "id,name" });
  if (!me.data?.length) throw new Error("Sin cuentas publicitarias disponibles");
  return me.data[0].id; // Usa la primera cuenta
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function listCampaigns(): Promise<string> {
  const adAccountId = await getAdAccountId();
  const data = await adsGet(`/${adAccountId}/campaigns`, {
    fields: "id,name,status,objective,daily_budget,lifetime_budget,start_time,stop_time",
    limit: "20",
  });

  if (!data.data?.length) return "📢 Sin campañas activas.";

  const lines = [`📢 *Campañas (${data.data.length})*`];
  for (const c of data.data) {
    const budget = c.daily_budget
      ? `$${(parseInt(c.daily_budget) / 100).toFixed(2)}/día`
      : c.lifetime_budget
      ? `$${(parseInt(c.lifetime_budget) / 100).toFixed(2)} total`
      : "Sin presupuesto";
    lines.push(`• [${c.status}] ${c.name}\n  ID: ${c.id} | ${c.objective} | ${budget}`);
  }
  return lines.join("\n");
}

async function getCampaignInsights(campaignId: string, datePreset = "last_7d"): Promise<string> {
  const data = await adsGet(`/${campaignId}/insights`, {
    fields: "impressions,reach,clicks,ctr,spend,cpc,cpm,actions",
    date_preset: datePreset,
  });

  if (!data.data?.length) return "📊 Sin datos de insights para esta campaña.";

  const d = data.data[0];
  const conversions =
    d.actions?.find((a: any) => a.action_type === "purchase")?.value || 0;

  return [
    `📊 *Insights campaña ${campaignId}* (${datePreset})`,
    `Impresiones: ${parseInt(d.impressions || 0).toLocaleString("en-US")}`,
    `Alcance: ${parseInt(d.reach || 0).toLocaleString("en-US")}`,
    `Clics: ${parseInt(d.clicks || 0).toLocaleString("en-US")}`,
    `CTR: ${parseFloat(d.ctr || 0).toFixed(2)}%`,
    `Gasto: $${parseFloat(d.spend || 0).toFixed(2)}`,
    `CPC: $${parseFloat(d.cpc || 0).toFixed(2)}`,
    `CPM: $${parseFloat(d.cpm || 0).toFixed(2)}`,
    `Conversiones: ${conversions}`,
  ].join("\n");
}

async function createCampaign(
  name: string,
  objective: string,
  dailyBudget: number,
  status = "PAUSED"
): Promise<string> {
  const adAccountId = await getAdAccountId();
  const data = await adsPost(`/${adAccountId}/campaigns`, {
    name,
    objective: objective.toUpperCase(),
    daily_budget: Math.round(dailyBudget * 100).toString(), // en centavos
    status,
    special_ad_categories: [],
  });
  return `✅ Campaña creada\nID: ${data.id}\nNombre: ${name}\nEstado: ${status}`;
}

async function updateCampaignBudget(
  campaignId: string,
  dailyBudget: number
): Promise<string> {
  await adsPost(`/${campaignId}`, {
    daily_budget: Math.round(dailyBudget * 100).toString(),
  });
  return `✅ Presupuesto actualizado\nCampaña: ${campaignId}\nNuevo presupuesto diario: $${dailyBudget}`;
}

async function pauseCampaign(campaignId: string): Promise<string> {
  await adsPost(`/${campaignId}`, { status: "PAUSED" });
  return `⏸ Campaña pausada: ${campaignId}`;
}

async function activateCampaign(campaignId: string): Promise<string> {
  await adsPost(`/${campaignId}`, { status: "ACTIVE" });
  return `▶️ Campaña activada: ${campaignId}`;
}

async function listAdSets(campaignId: string): Promise<string> {
  const data = await adsGet(`/${campaignId}/adsets`, {
    fields: "id,name,status,daily_budget,targeting,bid_amount",
    limit: "20",
  });

  if (!data.data?.length) return "📦 Sin ad sets en esta campaña.";

  const lines = [`📦 *Ad Sets (${data.data.length})*`];
  for (const s of data.data) {
    const budget = s.daily_budget
      ? `$${(parseInt(s.daily_budget) / 100).toFixed(2)}/día`
      : "Heredado";
    lines.push(`• [${s.status}] ${s.name}\n  ID: ${s.id} | ${budget}`);
  }
  return lines.join("\n");
}

async function listAds(adSetId: string): Promise<string> {
  const data = await adsGet(`/${adSetId}/ads`, {
    fields: "id,name,status,creative",
    limit: "20",
  });

  if (!data.data?.length) return "🎨 Sin anuncios en este ad set.";

  const lines = [`🎨 *Anuncios (${data.data.length})*`];
  for (const ad of data.data) {
    lines.push(`• [${ad.status}] ${ad.name}\n  ID: ${ad.id}`);
  }
  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const metaAdsTool: Tool = {
  name: "meta_ads",
  description:
    "Gestiona campañas de Meta Ads: lista campañas, obtiene insights, crea campañas, actualiza presupuestos, pausa/activa campañas y lista ad sets y anuncios.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list_campaigns",
          "get_insights",
          "create_campaign",
          "update_budget",
          "pause_campaign",
          "activate_campaign",
          "list_adsets",
          "list_ads",
        ],
        description: "Acción a ejecutar",
      },
      campaign_id: {
        type: "string",
        description: "ID de la campaña",
      },
      adset_id: {
        type: "string",
        description: "ID del ad set",
      },
      name: {
        type: "string",
        description: "Nombre de la campaña",
      },
      objective: {
        type: "string",
        description:
          "Objetivo (BRAND_AWARENESS, REACH, TRAFFIC, ENGAGEMENT, APP_INSTALLS, VIDEO_VIEWS, LEAD_GENERATION, CONVERSIONS)",
      },
      daily_budget: {
        type: "number",
        description: "Presupuesto diario en USD",
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "PAUSED"],
        description: "Estado inicial de la campaña",
      },
      date_preset: {
        type: "string",
        description:
          "Período para insights: today, yesterday, last_7d, last_30d, this_month, last_month",
      },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const {
      action,
      campaign_id,
      adset_id,
      name,
      objective,
      daily_budget,
      status,
      date_preset,
    } = params as any;

    switch (action) {
      case "list_campaigns":
        return listCampaigns();

      case "get_insights":
        if (!campaign_id) return "❌ Falta parámetro: campaign_id";
        return getCampaignInsights(campaign_id, date_preset);

      case "create_campaign":
        if (!name || !objective || !daily_budget)
          return "❌ Faltan parámetros: name, objective, daily_budget";
        return createCampaign(name, objective, daily_budget, status);

      case "update_budget":
        if (!campaign_id || !daily_budget)
          return "❌ Faltan parámetros: campaign_id, daily_budget";
        return updateCampaignBudget(campaign_id, daily_budget);

      case "pause_campaign":
        if (!campaign_id) return "❌ Falta parámetro: campaign_id";
        return pauseCampaign(campaign_id);

      case "activate_campaign":
        if (!campaign_id) return "❌ Falta parámetro: campaign_id";
        return activateCampaign(campaign_id);

      case "list_adsets":
        if (!campaign_id) return "❌ Falta parámetro: campaign_id";
        return listAdSets(campaign_id);

      case "list_ads":
        if (!adset_id) return "❌ Falta parámetro: adset_id";
        return listAds(adset_id);

      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};
