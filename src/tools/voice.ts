import * as fs from "fs";
import * as path from "path";
import fetch from "node-fetch";
import FormData from "form-data";

const AUDIO_DIR = "/data/audio";

// ─── Whisper: Speech to Text ──────────────────────────────────────────────────

export interface TranscribeOptions {
  audio_path: string;
  language?: string;        // ISO 639-1, e.g. "es", "en"
  response_format?: "json" | "text" | "verbose_json";
  temperature?: number;
}

export interface TranscribeResult {
  success: boolean;
  text: string;
  language?: string;
  duration?: number;
  segments?: { start: number; end: number; text: string }[];
  error?: string;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { success: false, text: "", error: "OPENAI_API_KEY not set" };

  if (!fs.existsSync(opts.audio_path)) {
    return { success: false, text: "", error: `File not found: ${opts.audio_path}` };
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(opts.audio_path));
  form.append("model", "whisper-1");

  if (opts.language) form.append("language", opts.language);
  form.append("response_format", opts.response_format ?? "verbose_json");
  if (opts.temperature !== undefined) form.append("temperature", String(opts.temperature));

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!response.ok) {
      const err = await response.text();
      return { success: false, text: "", error: `Whisper error ${response.status}: ${err}` };
    }

    const format = opts.response_format ?? "verbose_json";

    if (format === "text") {
      const text = await response.text();
      return { success: true, text };
    }

    const data = (await response.json()) as any;

    return {
      success: true,
      text: data.text ?? "",
      language: data.language,
      duration: data.duration,
      segments: data.segments?.map((s: any) => ({
        start: s.start,
        end: s.end,
        text: s.text,
      })),
    };
  } catch (err: any) {
    return { success: false, text: "", error: err.message };
  }
}

// ─── Transcribe from Telegram voice/audio buffer ──────────────────────────────
export async function transcribeBuffer(
  buffer: Buffer,
  extension: "ogg" | "mp3" | "wav" | "m4a",
  language?: string
): Promise<TranscribeResult> {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const tempPath = path.join(AUDIO_DIR, `temp_${Date.now()}.${extension}`);
  fs.writeFileSync(tempPath, buffer);

  const result = await transcribeAudio({ audio_path: tempPath, language });

  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }

  return result;
}

// ─── ElevenLabs: Text to Speech ───────────────────────────────────────────────

export interface TTSOptions {
  text: string;
  voice_id?: string;           // default: configured or first available
  model?: string;              // default: eleven_multilingual_v2
  stability?: number;          // 0-1, default 0.5
  similarity_boost?: number;   // 0-1, default 0.75
  style?: number;              // 0-1, default 0
  use_speaker_boost?: boolean;
  output_name?: string;
}

export interface TTSResult {
  success: boolean;
  audio_path: string;
  duration_estimate?: number;  // rough estimate based on text length
  error?: string;
}

// Default Jarvis voice — can override via env
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "pNInz6obpgDQGcFmaJgB"; // Adam

export async function textToSpeech(opts: TTSOptions): Promise<TTSResult> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { success: false, audio_path: "", error: "ELEVENLABS_API_KEY not set" };

  fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const voiceId = opts.voice_id ?? DEFAULT_VOICE_ID;
  const model   = opts.model ?? "eleven_multilingual_v2";
  const outputPath = path.join(AUDIO_DIR, `${opts.output_name ?? `tts_${Date.now()}`}.mp3`);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: opts.text,
          model_id: model,
          voice_settings: {
            stability: opts.stability ?? 0.5,
            similarity_boost: opts.similarity_boost ?? 0.75,
            style: opts.style ?? 0,
            use_speaker_boost: opts.use_speaker_boost ?? true,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return { success: false, audio_path: "", error: `ElevenLabs error ${response.status}: ${err}` };
    }

    const buffer = await response.buffer();
    fs.writeFileSync(outputPath, buffer);

    return {
      success: true,
      audio_path: outputPath,
      duration_estimate: Math.ceil(opts.text.length / 15), // ~15 chars/sec
    };
  } catch (err: any) {
    return { success: false, audio_path: "", error: err.message };
  }
}

// ─── List ElevenLabs voices ───────────────────────────────────────────────────
export interface VoiceInfo {
  voice_id: string;
  name: string;
  category: string;
  labels: Record<string, string>;
}

export async function listVoices(): Promise<{ voices: VoiceInfo[]; error?: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return { voices: [], error: "ELEVENLABS_API_KEY not set" };

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey },
    });

    if (!response.ok) return { voices: [], error: `${response.status}` };

    const data = (await response.json()) as { voices: any[] };
    const voices: VoiceInfo[] = data.voices.map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category ?? "unknown",
      labels: v.labels ?? {},
    }));

    return { voices };
  } catch (err: any) {
    return { voices: [], error: err.message };
  }
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export const voiceTools = {
  transcribe_audio: transcribeAudio,
  transcribe_buffer: transcribeBuffer,
  text_to_speech: textToSpeech,
  list_voices: listVoices,
};
