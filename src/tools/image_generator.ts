import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";

const OUTPUT_DIR = "/data/media/images";

export type ImageFormat = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
export type ImageStyle = "photorealistic" | "anime" | "illustration" | "cinematic" | "dark";

export interface GenerateImageOptions {
  prompt: string;
  negative_prompt?: string;
  format?: ImageFormat;
  style?: ImageStyle;
  num_images?: number;        // 1-4
  guidance_scale?: number;    // 1-20, default 7
  steps?: number;             // 20-50
  seed?: number;
  filename?: string;
}

export interface GenerateImageResult {
  success: boolean;
  paths: string[];
  prompt_used: string;
  error?: string;
}

// ─── Dimension map ────────────────────────────────────────────────────────────
const DIMENSIONS: Record<ImageFormat, { width: number; height: number }> = {
  "1:1":  { width: 1024, height: 1024 },
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "4:3":  { width: 1024, height: 768  },
  "3:4":  { width: 768,  height: 1024 },
};

// ─── Style prefix map ─────────────────────────────────────────────────────────
const STYLE_PREFIXES: Record<ImageStyle, string> = {
  photorealistic: "hyperrealistic photo, 8k resolution, professional photography, ",
  anime:          "anime style, vibrant colors, detailed linework, studio quality, ",
  illustration:   "digital illustration, concept art, detailed, professional, ",
  cinematic:      "cinematic shot, film grain, dramatic lighting, movie still, ",
  dark:           "dark aesthetic, moody atmosphere, dramatic shadows, high contrast, ",
};

// ─── Flux API via fal.ai ──────────────────────────────────────────────────────
async function callFluxAPI(options: GenerateImageOptions): Promise<string[]> {
  const apiKey = process.env.FAL_API_KEY ?? process.env.FLUX_API_KEY;
  if (!apiKey) throw new Error("FAL_API_KEY or FLUX_API_KEY not set");

  const format = options.format ?? "1:1";
  const dims = DIMENSIONS[format];
  const stylePrefix = options.style ? STYLE_PREFIXES[options.style] : "";
  const finalPrompt = stylePrefix + options.prompt;

  // fal.ai Flux endpoint
  const response = await fetch("https://fal.run/fal-ai/flux/dev", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Key ${apiKey}`,
    },
    body: JSON.stringify({
      prompt: finalPrompt,
      negative_prompt: options.negative_prompt ?? "blurry, low quality, distorted",
      image_size: { width: dims.width, height: dims.height },
      num_inference_steps: options.steps ?? 28,
      guidance_scale: options.guidance_scale ?? 7.5,
      num_images: options.num_images ?? 1,
      seed: options.seed,
      enable_safety_checker: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Flux API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as { images: { url: string }[] };
  return data.images.map((img) => img.url);
}

// ─── Download and save image ──────────────────────────────────────────────────
async function downloadImage(url: string, filePath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);
  const buffer = await res.buffer();
  fs.writeFileSync(filePath, buffer);
}

// ─── Main: generateImage ──────────────────────────────────────────────────────
export async function generateImage(
  options: GenerateImageOptions
): Promise<GenerateImageResult> {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const stylePrefix = options.style ? STYLE_PREFIXES[options.style] : "";
  const promptUsed = stylePrefix + options.prompt;

  try {
    const imageUrls = await callFluxAPI(options);
    const savedPaths: string[] = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const baseName =
        options.filename
          ? `${options.filename}${imageUrls.length > 1 ? `_${i + 1}` : ""}.png`
          : `img_${Date.now()}_${i + 1}.png`;

      const filePath = path.join(OUTPUT_DIR, baseName);
      await downloadImage(imageUrls[i], filePath);
      savedPaths.push(filePath);
    }

    return { success: true, paths: savedPaths, prompt_used: promptUsed };
  } catch (err: any) {
    return { success: false, paths: [], prompt_used: promptUsed, error: err.message };
  }
}

// ─── Batch generation ─────────────────────────────────────────────────────────
export async function generateImageBatch(
  prompts: string[],
  baseOptions: Omit<GenerateImageOptions, "prompt">
): Promise<GenerateImageResult[]> {
  const results: GenerateImageResult[] = [];
  for (const prompt of prompts) {
    const result = await generateImage({ ...baseOptions, prompt });
    results.push(result);
  }
  return results;
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export const imageGeneratorTools = {
  generate_image: generateImage,
  generate_image_batch: generateImageBatch,
};
