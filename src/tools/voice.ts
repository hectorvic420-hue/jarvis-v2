import { Tool } from "../shared/types.js";
import fs   from "fs";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiResponse = Record<string, any>;

const OUTPUT_DIR = process.env.VOICE_OUTPUT_DIR || "./output/voice";
const ELEVENLABS_BASE = "https://api.elevenlabs.io/v1";

function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function elKey(): string {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error("ELEVENLABS_API_KEY no configurado");
  return k;
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

export async function textToSpeech(
  text:      string,
  voiceId:   string,
  modelId:   string,
  stability: number,
  similarity: number,
  saveFile:  boolean
): Promise<string> {
  const res = await fetch(`${ELEVENLABS_BASE}/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key":    elKey(),
      "Content-Type":  "application/json",
      Accept:          "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      voice_settings: { stability, similarity_boost: similarity },
    }),
  });

  if (!res.ok) {
    const err = await res.json() as ApiResponse;
    throw new Error(err["detail"]?.["message"] as string || `ElevenLabs TTS ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  let savedPath: string | undefined;
  if (saveFile) {
    ensureOutputDir();
    savedPath = path.join(OUTPUT_DIR, `tts_${Date.now()}.mp3`);
    fs.writeFileSync(savedPath, buffer);
  }

  const lines = [
    `🔊 *Audio generado (TTS)*`,
    `Voz ID: ${voiceId}`,
    `Modelo: ${modelId}`,
    `Texto: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`,
    `Tamaño: ${(buffer.length / 1024).toFixed(1)}KB`,
  ];
  if (savedPath) lines.push(`Guardado: ${savedPath}`);

  return lines.join("\n");
}

// ─── STT (transcripción) ──────────────────────────────────────────────────────

async function speechToText(audioPath: string): Promise<string> {
  if (!fs.existsSync(audioPath)) return `❌ Archivo no encontrado: ${audioPath}`;

  const file = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append(
    "audio",
    new Blob([file], { type: "audio/mpeg" }),
    path.basename(audioPath)
  );
  form.append("model_id", "scribe_v1");

  const res = await fetch(`${ELEVENLABS_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "xi-api-key": elKey() },
    body: form,
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["detail"]?.["message"] as string || `ElevenLabs STT ${res.status}`);

  const text        = data["text"] as string ?? "Sin transcripción";
  const language    = data["language_code"] as string ?? "?";
  const confidence  = data["confidence"] as number ?? 0;

  return [
    `📝 *Transcripción*`,
    `Idioma detectado: ${language}`,
    `Confianza: ${(confidence * 100).toFixed(0)}%`,
    ``,
    text,
  ].join("\n");
}

/** Agregamos compatibilidad con el buffer para el webhook de WhatsApp */
export async function transcribeBuffer(buffer: Buffer, _ext = "mp3", _lang = "es"): Promise<{ success: boolean; text?: string }> {
  ensureOutputDir();
  const tempPath = path.join(OUTPUT_DIR, `temp_${Date.now()}.mp3`);
  fs.writeFileSync(tempPath, buffer);
  try {
    const text = await speechToText(tempPath);
    return { success: true, text };
  } catch (err) {
    console.error("[VOICE] Error en transcribeBuffer:", err);
    return { success: false };
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

// ─── List voices ──────────────────────────────────────────────────────────────

async function listVoices(filter?: string): Promise<string> {
  const res = await fetch(`${ELEVENLABS_BASE}/voices`, {
    headers: { "xi-api-key": elKey() },
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}`);

  let voices = (data["voices"] as ApiResponse[]) ?? [];
  if (filter) {
    voices = voices.filter((v) =>
      (v["name"] as string).toLowerCase().includes(filter.toLowerCase())
    );
  }

  if (!voices.length) return "🎤 Sin voces disponibles.";

  const lines = [`🎤 *Voces ElevenLabs (${voices.length})*`];
  for (const v of voices.slice(0, 20)) {
    const labels = Object.values(v["labels"] as Record<string, string> ?? {}).join(", ");
    lines.push(`• ${v["name"] as string} | ID: \`${v["voice_id"] as string}\` | ${labels}`);
  }
  return lines.join("\n");
}

// ─── Voice clone (add voice) ──────────────────────────────────────────────────

async function cloneVoice(name: string, audioFilePaths: string[]): Promise<string> {
  const form = new FormData();
  form.append("name", name);

  for (const p of audioFilePaths) {
    if (!fs.existsSync(p)) return `❌ Archivo no encontrado: ${p}`;
    const buf = fs.readFileSync(p);
    form.append("files", new Blob([buf], { type: "audio/mpeg" }), path.basename(p));
  }

  const res = await fetch(`${ELEVENLABS_BASE}/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": elKey() },
    body: form,
  });

  const data = await res.json() as ApiResponse;
  if (!res.ok) throw new Error(data["detail"]?.["message"] as string || `ElevenLabs clone ${res.status}`);

  return [
    `✅ *Voz clonada*`,
    `Nombre: ${name}`,
    `Voice ID: \`${data["voice_id"] as string}\``,
    `Archivos usados: ${audioFilePaths.length}`,
  ].join("\n");
}

// ─── Tool export ──────────────────────────────────────────────────────────────

export const voiceTool: Tool = {
  name: "voice",
  description:
    "Síntesis y transcripción de voz con ElevenLabs: text-to-speech (TTS), " +
    "speech-to-text (STT/transcripción), lista de voces disponibles y clonación de voz.",
  parameters: {
    type: "object",
    properties: {
      action:     {
        type: "string",
        enum: ["tts", "stt", "list_voices", "clone_voice"],
        description: "Acción a ejecutar",
      },
      text:       { type: "string",  description: "Texto a sintetizar (TTS)" },
      voice_id:   { type: "string",  description: "ID de la voz ElevenLabs (default: Rachel)" },
      model_id:   { type: "string",  description: "Modelo (eleven_multilingual_v2, eleven_turbo_v2_5)" },
      stability:  { type: "number",  description: "Estabilidad 0-1 (default: 0.5)" },
      similarity: { type: "number",  description: "Similitud 0-1 (default: 0.75)" },
      save_file:  { type: "boolean", description: "Guardar audio en disco (default: true)" },
      audio_path: { type: "string",  description: "Ruta del archivo de audio para STT" },
      filter:     { type: "string",  description: "Filtro de nombre para listar voces" },
      name:       { type: "string",  description: "Nombre para la voz clonada" },
      audio_files:{ type: "array",   description: "Rutas de audios para clonar voz (mín. 1)" },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const {
      action,
      text,
      voice_id    = "21m00Tcm4TlvDq8ikWAM", // Rachel
      model_id    = "eleven_multilingual_v2",
      stability   = 0.5,
      similarity  = 0.75,
      save_file   = true,
      audio_path,
      filter,
      name,
      audio_files = [],
    } = params as Record<string, any>;

    switch (action) {
      case "tts":
        if (!text) return "❌ Falta parámetro: text";
        return textToSpeech(
          text as string,
          voice_id as string,
          model_id as string,
          stability as number,
          similarity as number,
          save_file as boolean
        );

      case "stt":
        if (!audio_path) return "❌ Falta parámetro: audio_path";
        return speechToText(audio_path as string);

      case "list_voices":
        return listVoices(filter as string | undefined);

      case "clone_voice":
        if (!name || !(audio_files as string[]).length)
          return "❌ Faltan: name, audio_files";
        return cloneVoice(name as string, audio_files as string[]);

      default:
        return `❌ Acción desconocida: ${action as string}`;
    }
  },
};
