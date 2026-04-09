import { Tool } from "../shared/types.js";
import fs   from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const OUTPUT_DIR = process.env.VIDEO_OUTPUT_DIR || "./output/videos";

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const FETCH_TIMEOUT = 30000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── RunwayML ─────────────────────────────────────────────────────────────────

async function generateRunway(
  prompt:     string,
  imageUrl:   string | undefined,
  duration:   number,
  ratio:      string
): Promise<string> {
  const key = process.env.RUNWAY_API_KEY;
  if (!key) throw new Error("RUNWAY_API_KEY no configurado");

  const body: Record<string, unknown> = {
    promptText: prompt,
    model:      "gen3a_turbo",
    duration,
    ratio,
  };
  if (imageUrl) body["promptImage"] = imageUrl;

  const res = await fetchWithTimeout("https://api.dev.runwayml.com/v1/image_to_video", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Runway-Version": "2024-11-06",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["message"] as string || `RunwayML ${res.status}`);

  const taskId = data["id"] as string;
  if (!taskId) throw new Error("RunwayML no retornó task ID");

  // Poll hasta completar (max 120s)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const poll = await fetchWithTimeout(`https://api.dev.runwayml.com/v1/tasks/${taskId}`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Runway-Version": "2024-11-06",
      },
    });
    const status = await poll.json() as ApiResponse;

    if (status["status"] === "SUCCEEDED") {
      const output = status["output"];
      if (Array.isArray(output) && output[0]) return output[0] as string;
      if (typeof output === "string" && output) return output;
      throw new Error("RunwayML completó pero sin URL de salida");
    }
    if (status["status"] === "FAILED") {
      throw new Error(`RunwayML falló: ${status["failure"] as string}`);
    }
  }
  throw new Error("RunwayML timeout (120s)");
}

// ─── Kling AI ─────────────────────────────────────────────────────────────────

async function generateKling(
  prompt:   string,
  imageUrl: string | undefined,
  duration: number,
  ratio:    string
): Promise<string> {
  const key = process.env.KLING_API_KEY;
  if (!key) throw new Error("KLING_API_KEY no configurado");

  const body: Record<string, unknown> = {
    prompt,
    duration,
    aspect_ratio: ratio,
    mode: "std",
  };
  if (imageUrl) body["image_url"] = imageUrl;

  const endpoint = imageUrl
    ? "https://api.klingai.com/v1/videos/image2video"
    : "https://api.klingai.com/v1/videos/text2video";

  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["message"] as string || `Kling ${res.status}`);

  const taskId = data["data"]?.["task_id"] as string;
  if (!taskId) throw new Error("Kling no retornó task_id");

  const pollEndpoint = imageUrl
    ? `https://api.klingai.com/v1/videos/image2video/${taskId}`
    : `https://api.klingai.com/v1/videos/text2video/${taskId}`;

  // Poll (max 120s)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));

    const poll = await fetchWithTimeout(pollEndpoint, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = await poll.json() as ApiResponse;
    const taskStatus = status["data"]?.["task_status"] as string;

    if (taskStatus === "succeed") {
      return status["data"]?.["task_result"]?.["videos"]?.[0]?.["url"] as string ?? "Sin URL";
    }
    if (taskStatus === "failed") {
      throw new Error(`Kling falló: ${status["data"]?.["task_status_msg"] as string}`);
    }
  }
  throw new Error("Kling timeout (120s)");
}

// ─── Pika Labs ────────────────────────────────────────────────────────────────

async function generatePika(
  prompt:   string,
  imageUrl: string | undefined,
  ratio:    string
): Promise<string> {
  const key = process.env.PIKA_API_KEY;
  if (!key) throw new Error("PIKA_API_KEY no configurado");

  const body: Record<string, unknown> = {
    promptText: prompt,
    aspectRatio: ratio,
    frameRate: 24,
  };
  if (imageUrl) body["image"] = imageUrl;

  const res = await fetchWithTimeout("https://api.pika.art/v1/generate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["message"] as string || `Pika ${res.status}`);

  const jobId = data["id"] as string;
  if (!jobId) throw new Error("Pika no retornó job ID");

  // Poll (max 90s)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await fetchWithTimeout(`https://api.pika.art/v1/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = await poll.json() as ApiResponse;

    if (status["status"] === "finished") {
      const resultUrl = status["resultUrl"] as string;
      if (!resultUrl) throw new Error("Pika completó pero sin URL de resultado");
      return resultUrl;
    }
    if (status["status"] === "failed") {
      throw new Error(`Pika falló: ${status["error"] as string}`);
    }
  }
  throw new Error("Pika timeout (90s)");
}

// ─── Save video ───────────────────────────────────────────────────────────────

async function saveVideo(url: string, filename: string): Promise<string> {
  ensureOutputDir();
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Error descargando video: ${res.status}`);
  const buf  = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("Video descargado está vacío");
  const file = path.join(OUTPUT_DIR, `${filename}.mp4`);
  fs.writeFileSync(file, buf);
  return file;
}

// ─── Main generate ────────────────────────────────────────────────────────────

async function generate(
  prompt:      string,
  provider:    string,
  imageUrl:    string | undefined,
  duration:    number,
  ratio:       string,
  saveLocally: boolean
): Promise<string> {
  let videoUrl: string;

  switch (provider) {
    case "kling":
      videoUrl = await generateKling(prompt, imageUrl, duration, ratio);
      break;
    case "pika":
      videoUrl = await generatePika(prompt, imageUrl, ratio);
      break;
    case "runway":
    default:
      videoUrl = await generateRunway(prompt, imageUrl, duration, ratio);
  }

  const lines = [
    `🎬 *Video generado*`,
    `Proveedor: ${provider}`,
    `Duración: ${duration}s`,
    `Ratio: ${ratio}`,
    imageUrl ? `Imagen base: ${imageUrl}` : "Generación: text-to-video",
    `URL: ${videoUrl}`,
  ];

  if (saveLocally) {
    const file = await saveVideo(videoUrl, `video_${Date.now()}`);
    lines.push(`Guardado en: ${file}`);
  }

  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const videoComposerTool: Tool = {
  name: "video_composer",
  description:
    "Genera videos con IA usando RunwayML Gen-3, Kling AI o Pika Labs. " +
    "Soporta text-to-video e image-to-video. Retorna URL del video generado.",
  parameters: {
    type: "object",
    properties: {
      prompt:      { type: "string",  description: "Descripción del video (inglés para mejor calidad)" },
      provider:    { type: "string",  enum: ["runway", "kling", "pika"], description: "Proveedor de generación" },
      image_url:   { type: "string",  description: "URL pública de imagen base (para image-to-video)" },
      duration:    { type: "number",  description: "Duración en segundos (5 o 10, default: 5)" },
      ratio:       { type: "string",  description: "Aspect ratio (16:9, 9:16, 1:1, default: 16:9)" },
      save_locally:{ type: "boolean", description: "Guardar video en disco (default: false)" },
    },
    required: ["prompt"],
  },

  async execute(params, _chatId) {
    const {
      prompt,
      provider     = "runway",
      image_url,
      duration     = 5,
      ratio        = "16:9",
      save_locally = false,
    } = params as Record<string, any>;

    if (!prompt) return "❌ Falta parámetro: prompt";

    return generate(
      prompt as string,
      provider as string,
      image_url as string | undefined,
      duration as number,
      ratio as string,
      save_locally as boolean
    );
  },
};
