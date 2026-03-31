import { Tool } from "../shared/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

// ─── Graph API helper ─────────────────────────────────────────────────────────

function token(): string {
  const t = process.env.META_PAGE_ACCESS_TOKEN;
  if (!t) throw new Error("META_PAGE_ACCESS_TOKEN no configurado");
  return t;
}

function pageId(): string {
  const p = process.env.META_PAGE_ID;
  if (!p) throw new Error("META_PAGE_ID no configurado");
  return p;
}

async function graphPost(endpoint: string, body: Record<string, unknown>): Promise<ApiResponse> {
  const url = `${GRAPH_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, access_token: token() }),
  });
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) {
    throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Graph API error ${res.status}`);
  }
  return data;
}

async function graphGet(endpoint: string, params: Record<string, string> = {}): Promise<ApiResponse> {
  const qs = new URLSearchParams({ ...params, access_token: token() }).toString();
  const url = `${GRAPH_BASE}${endpoint}?${qs}`;
  const res = await fetch(url);
  const data = await res.json() as ApiResponse;
  if (!res.ok || data["error"]) {
    throw new Error((data["error"] as ApiResponse)?.["message"] as string || `Graph API error ${res.status}`);
  }
  return data;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function postText(message: string): Promise<string> {
  const data = await graphPost(`/${pageId()}/feed`, { message });
  return `✅ Post publicado\nID: ${data.id}`;
}

async function postPhoto(message: string, photoUrl: string): Promise<string> {
  const data = await graphPost(`/${pageId()}/photos`, {
    message,
    url: photoUrl,
  });
  return `✅ Foto publicada\nID: ${data.post_id || data.id}`;
}

async function postVideo(
  title: string,
  description: string,
  videoUrl: string
): Promise<string> {
  const data = await graphPost(`/${pageId()}/videos`, {
    title,
    description,
    file_url: videoUrl,
  });
  return `✅ Video publicado\nID: ${data.id}`;
}

async function postReel(
  description: string,
  videoUrl: string
): Promise<string> {
  // Step 1: initialize upload session
  const init = await graphPost(`/${pageId()}/video_reels`, {
    upload_phase: "start",
  });

  const videoId = init.video_id;

  // Step 2: upload via URL
  await graphPost(`/${pageId()}/video_reels`, {
    upload_phase: "finish",
    video_id: videoId,
    file_url: videoUrl,
    description,
    video_state: "PUBLISHED",
  });

  return `✅ Reel publicado\nVideo ID: ${videoId}`;
}

async function schedulePost(
  message: string,
  scheduledTime: number,
  photoUrl?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    published: false,
    scheduled_publish_time: scheduledTime,
  };

  let endpoint = `/${pageId()}/feed`;

  if (photoUrl) {
    endpoint = `/${pageId()}/photos`;
    body.url = photoUrl;
  }

  const data = await graphPost(endpoint, body);
  const date = new Date(scheduledTime * 1000).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
  });
  return `📅 Post programado\nID: ${data.id || data.post_id}\nPublicación: ${date} (COT)`;
}

async function listPosts(limit = 10): Promise<string> {
  const data = await graphGet(`/${pageId()}/posts`, {
    fields: "id,message,created_time,full_picture,permalink_url",
    limit: limit.toString(),
  });

  if (!data.data?.length) return "📋 No hay posts recientes.";

  const lines = [`📋 *Últimos ${data.data.length} posts*`];
  for (const post of data.data) {
    const date = new Date(post.created_time).toLocaleString("es-CO", {
      timeZone: "America/Bogota",
    });
    const preview = post.message
      ? post.message.substring(0, 60) + (post.message.length > 60 ? "…" : "")
      : "[Sin texto]";
    lines.push(`• [${date}] ${preview}\n  ID: ${post.id}`);
  }
  return lines.join("\n");
}

async function getInsights(postId?: string): Promise<string> {
  let endpoint: string;
  let fields: string;

  if (postId) {
    endpoint = `/${postId}/insights`;
    fields = "post_impressions,post_impressions_unique,post_engaged_users,post_clicks";
  } else {
    endpoint = `/${pageId()}/insights`;
    fields =
      "page_impressions,page_impressions_unique,page_engaged_users,page_fan_adds,page_views_total";
  }

  const data = await graphGet(endpoint, { metric: fields, period: "day" });

  if (!data.data?.length) return "📊 Sin datos de insights disponibles.";

  const lines = [postId ? `📊 *Insights del post ${postId}*` : `📊 *Insights de la página*`];
  for (const metric of data.data) {
    const value = metric.values?.[metric.values.length - 1]?.value ?? 0;
    lines.push(`• ${metric.name}: ${value}`);
  }
  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const facebookPublisherTool: Tool = {
  name: "facebook_publisher",
  description:
    "Publica y gestiona contenido en Facebook: texto, fotos, videos, reels, posts programados, lista posts y obtiene insights de la página o publicaciones.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "post_text",
          "post_photo",
          "post_video",
          "post_reel",
          "schedule_post",
          "list_posts",
          "get_insights",
        ],
        description: "Acción a ejecutar",
      },
      message: {
        type: "string",
        description: "Texto del post",
      },
      photo_url: {
        type: "string",
        description: "URL pública de la foto",
      },
      video_url: {
        type: "string",
        description: "URL pública del video",
      },
      title: {
        type: "string",
        description: "Título del video",
      },
      description: {
        type: "string",
        description: "Descripción del reel o video",
      },
      scheduled_time: {
        type: "number",
        description: "Unix timestamp para programar el post",
      },
      post_id: {
        type: "string",
        description: "ID del post para obtener insights específicos",
      },
      limit: {
        type: "number",
        description: "Cantidad de posts a listar",
      },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const {
      action,
      message,
      photo_url,
      video_url,
      title,
      description,
      scheduled_time,
      post_id,
      limit,
    } = params as any;

    switch (action) {
      case "post_text":
        if (!message) return "❌ Falta parámetro: message";
        return postText(message);

      case "post_photo":
        if (!message || !photo_url) return "❌ Faltan parámetros: message, photo_url";
        return postPhoto(message, photo_url);

      case "post_video":
        if (!video_url) return "❌ Falta parámetro: video_url";
        return postVideo(title || "", description || "", video_url);

      case "post_reel":
        if (!video_url) return "❌ Falta parámetro: video_url";
        return postReel(description || "", video_url);

      case "schedule_post":
        if (!message || !scheduled_time) return "❌ Faltan parámetros: message, scheduled_time";
        return schedulePost(message, scheduled_time, photo_url);

      case "list_posts":
        return listPosts(limit || 10);

      case "get_insights":
        return getInsights(post_id);

      default:
        return `❌ Acción desconocida: ${action}`;
    }
  },
};
