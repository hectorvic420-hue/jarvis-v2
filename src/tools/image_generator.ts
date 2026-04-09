import { Tool } from "../shared/types.js";
import fs   from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const OUTPUT_DIR = process.env.IMAGE_OUTPUT_DIR || "./output/images";
const FETCH_TIMEOUT = 60000;

// ─── Ensure output dir ────────────────────────────────────────────────────────

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Providers ────────────────────────────────────────────────────────────────

async function generateTogetherAI(
  prompt:         string,
  model:          string,
  width:          number,
  height:         number,
  steps:          number,
  negativePrompt: string
): Promise<string> {
  const key = process.env.TOGETHER_API_KEY;
  if (!key) throw new Error("TOGETHER_API_KEY no configurado");

  const res = await fetchWithTimeout("https://api.together.xyz/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      prompt,
      negative_prompt: negativePrompt,
      width,
      height,
      steps,
      n: 1,
    }),
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) {
    const errMsg = data?.error?.message || data?.error?.error || `Together AI ${res.status}`;
    throw new Error(errMsg);
  }

  const imageUrl = data["data"]?.[0]?.["url"] as string;
  if (!imageUrl) throw new Error("Together AI no retornó URL de imagen");

  return imageUrl;
}

async function generateFalAI(
  prompt:  string,
  model:   string,
  width:   number,
  height:  number,
  steps:   number
): Promise<string> {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new Error("FAL_API_KEY no configurado");

  const res = await fetchWithTimeout(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_size:  { width, height },
      num_steps:   steps,
      num_images:  1,
    }),
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["message"] as string || `Fal.ai ${res.status}`);

  const imageUrl = data["images"]?.[0]?.["url"] as string;
  if (!imageUrl) throw new Error("Fal.ai no retornó URL de imagen");

  return imageUrl;
}

async function generateReplicate(
  prompt:         string,
  model:         string,
  width:          number,
  height:         number,
  steps:          number,
  negativePrompt: string
): Promise<string> {
  const key = process.env.REPLICATE_API_KEY;
  if (!key) throw new Error("REPLICATE_API_KEY no configurado");

  const res = await fetchWithTimeout("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: model,
      input: {
        prompt,
        negative_prompt: negativePrompt,
        width,
        height,
        num_inference_steps: steps,
      },
    }),
  });

  const prediction = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(prediction["detail"] as string || `Replicate ${res.status}`);

  const pollUrl = prediction["urls"]?.["get"] as string;
  if (!pollUrl) throw new Error("Replicate no retornó URL de poll");

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetchWithTimeout(pollUrl, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const status = await poll.json() as ApiResponse;

    if (status["status"] === "succeeded") {
      const output = status["output"];
      if (Array.isArray(output) && output[0]) return output[0] as string;
      if (typeof output === "string" && output) return output;
      throw new Error("Replicate completó pero sin URL de imagen");
    }
    if (status["status"] === "failed") {
      throw new Error(`Replicate falló: ${status["error"] as string}`);
    }
  }
  throw new Error("Replicate timeout (60s)");
}

// ─── Save image locally ───────────────────────────────────────────────────────

async function saveImage(url: string, filename: string): Promise<string> {
  ensureOutputDir();
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Error descargando imagen: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("Imagen descargada está vacía");
  const ext = url.includes(".png") ? "png" : "jpg";
  const file = path.join(OUTPUT_DIR, `${filename}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

// ─── Main generate ────────────────────────────────────────────────────────────

async function generate(
  prompt:          string,
  provider:        string,
  model:           string,
  width:           number,
  height:          number,
  steps:           number,
  negativePrompt:  string,
  saveLocally:     boolean
): Promise<string> {
  let imageUrl: string;

  switch (provider) {
    case "fal":
      imageUrl = await generateFalAI(prompt, model, width, height, steps);
      break;
    case "replicate":
      imageUrl = await generateReplicate(prompt, model, width, height, steps, negativePrompt);
      break;
    case "together":
    default:
      imageUrl = await generateTogetherAI(prompt, model, width, height, steps, negativePrompt);
  }

  const lines = [
    `🖼️ *Imagen generada*`,
    `Proveedor: ${provider}`,
    `Modelo: ${model}`,
    `Dimensiones: ${width}×${height}`,
    `URL: ${imageUrl}`,
  ];

  if (saveLocally) {
    const ts   = Date.now();
    const file = await saveImage(imageUrl, `image_${ts}`);
    lines.push(`Guardada en: ${file}`);
  }

  return lines.join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const imageGeneratorTool: Tool = {
  name: "image_generator",
  description:
    "Genera imágenes con IA usando Together AI, Fal.ai o Replicate. " +
    "Soporta modelos como FLUX, SDXL, Stable Diffusion. Retorna URL pública y opcionalmente guarda localmente.",
  parameters: {
    type: "object",
    properties: {
      prompt:          { type: "string",  description: "Prompt en inglés para mejor calidad" },
      provider:        { type: "string",  enum: ["together", "fal", "replicate"], description: "Proveedor de generación" },
      model:           { type: "string",  description: "Nombre/versión del modelo" },
      width:           { type: "number",  description: "Ancho en píxeles (default: 1024)" },
      height:          { type: "number",  description: "Alto en píxeles (default: 1024)" },
      steps:           { type: "number",  description: "Pasos de difusión (default: 30)" },
      negative_prompt: { type: "string",  description: "Elementos a excluir de la imagen" },
      save_locally:    { type: "boolean", description: "Guardar imagen en disco (default: false)" },
    },
    required: ["prompt"],
  },

  async execute(params, _chatId) {
    const {
      prompt,
      provider        = "together",
      model           = "black-forest-labs/FLUX.1-schnell-Free",
      width           = 1024,
      height          = 1024,
      steps           = 30,
      negative_prompt = "blurry, low quality, distorted, watermark",
      save_locally    = false,
    } = params as Record<string, any>;

    if (!prompt) return "❌ Falta parámetro: prompt";

    return generate(
      prompt as string,
      provider as string,
      model as string,
      width as number,
      height as number,
      steps as number,
      negative_prompt as string,
      save_locally as boolean
    );
  },
};
