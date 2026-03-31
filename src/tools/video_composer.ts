import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";

const execAsync = promisify(exec);
const OUTPUT_DIR = "/data/media/videos";
const AUDIO_DIR  = "/data/audio";

export type VideoOrientation = "vertical" | "horizontal";
export type VideoQuality = "low" | "medium" | "high";

const DIMENSIONS = {
  vertical:   { w: 1080, h: 1920 },
  horizontal: { w: 1920, h: 1080 },
};

const CRF_MAP: Record<VideoQuality, number> = {
  low: 28, medium: 23, high: 18,
};

// ─── Verify ffmpeg is installed ───────────────────────────────────────────────
async function checkFfmpeg(): Promise<boolean> {
  try {
    await execAsync("ffmpeg -version");
    return true;
  } catch {
    return false;
  }
}

// ─── Tool: images_to_video ────────────────────────────────────────────────────
export interface ImagesToVideoOptions {
  image_paths: string[];
  output_name: string;
  duration_per_image?: number;   // seconds, default 5
  orientation?: VideoOrientation;
  audio_path?: string;
  quality?: VideoQuality;
  fps?: number;                  // default 30
  transition?: "none" | "fade";  // default none
}

export interface VideoResult {
  success: boolean;
  output_path: string;
  duration_seconds?: number;
  error?: string;
}

export async function imagesToVideo(opts: ImagesToVideoOptions): Promise<VideoResult> {
  if (!(await checkFfmpeg())) {
    return { success: false, output_path: "", error: "ffmpeg not installed" };
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const orientation  = opts.orientation ?? "vertical";
  const duration     = opts.duration_per_image ?? 5;
  const quality      = opts.quality ?? "high";
  const fps          = opts.fps ?? 30;
  const { w, h }     = DIMENSIONS[orientation];
  const outputPath   = path.join(OUTPUT_DIR, `${opts.output_name}.mp4`);
  const crf          = CRF_MAP[quality];
  const listFile     = path.join(OUTPUT_DIR, `${opts.output_name}_list.txt`);

  // Write concat list
  const listContent = opts.image_paths
    .map((p) => `file '${p}'\nduration ${duration}`)
    .join("\n");
  fs.writeFileSync(listFile, listContent);

  try {
    const scaleFilter = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

    let cmd: string;

    if (opts.audio_path) {
      const totalDuration = opts.image_paths.length * duration;
      cmd = [
        `ffmpeg -y`,
        `-f concat -safe 0 -i "${listFile}"`,
        `-i "${opts.audio_path}"`,
        `-vf "${scaleFilter}"`,
        `-c:v libx264 -crf ${crf} -preset medium`,
        `-c:a aac -b:a 192k`,
        `-t ${totalDuration}`,
        `-pix_fmt yuv420p`,
        `-r ${fps}`,
        `"${outputPath}"`,
      ].join(" ");
    } else {
      cmd = [
        `ffmpeg -y`,
        `-f concat -safe 0 -i "${listFile}"`,
        `-vf "${scaleFilter}"`,
        `-c:v libx264 -crf ${crf} -preset medium`,
        `-pix_fmt yuv420p`,
        `-r ${fps}`,
        `"${outputPath}"`,
      ].join(" ");
    }

    await execAsync(cmd, { timeout: 300_000 });

    // Get duration
    const { stdout } = await execAsync(
      `ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${outputPath}"`
    );

    fs.unlinkSync(listFile);
    return {
      success: true,
      output_path: outputPath,
      duration_seconds: parseFloat(stdout.trim()),
    };
  } catch (err: any) {
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    return { success: false, output_path: "", error: err.message };
  }
}

// ─── Tool: add_audio_to_video ─────────────────────────────────────────────────
export async function addAudioToVideo(
  videoPath: string,
  audioPath: string,
  outputName: string,
  mixWithOriginal = false
): Promise<VideoResult> {
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);

  const audioFilter = mixWithOriginal
    ? `-filter_complex "[0:a][1:a]amix=inputs=2:duration=shortest"`
    : `-map 0:v -map 1:a -shortest`;

  const cmd = `ffmpeg -y -i "${videoPath}" -i "${audioPath}" ${audioFilter} -c:v copy -c:a aac "${outputPath}"`;

  try {
    await execAsync(cmd, { timeout: 120_000 });
    return { success: true, output_path: outputPath };
  } catch (err: any) {
    return { success: false, output_path: "", error: err.message };
  }
}

// ─── Tool: trim_video ─────────────────────────────────────────────────────────
export async function trimVideo(
  videoPath: string,
  startSeconds: number,
  endSeconds: number,
  outputName: string
): Promise<VideoResult> {
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);
  const duration = endSeconds - startSeconds;

  const cmd = `ffmpeg -y -i "${videoPath}" -ss ${startSeconds} -t ${duration} -c:v copy -c:a copy "${outputPath}"`;

  try {
    await execAsync(cmd, { timeout: 60_000 });
    return { success: true, output_path: outputPath };
  } catch (err: any) {
    return { success: false, output_path: "", error: err.message };
  }
}

// ─── Tool: add_subtitles ──────────────────────────────────────────────────────
export interface SubtitleEntry {
  start: number;  // seconds
  end: number;
  text: string;
}

export async function addSubtitles(
  videoPath: string,
  subtitles: SubtitleEntry[],
  outputName: string,
  fontSize = 48,
  color = "white"
): Promise<VideoResult> {
  const srtPath = path.join(OUTPUT_DIR, `${outputName}.srt`);
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);

  // Build SRT
  const srtContent = subtitles
    .map((sub, i) => {
      const fmt = (s: number) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const ms = Math.round((s % 1) * 1000);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
      };
      return `${i + 1}\n${fmt(sub.start)} --> ${fmt(sub.end)}\n${sub.text}\n`;
    })
    .join("\n");

  fs.writeFileSync(srtPath, srtContent);

  const cmd = `ffmpeg -y -i "${videoPath}" -vf "subtitles='${srtPath}':force_style='FontSize=${fontSize},PrimaryColour=&H${color === "white" ? "FFFFFF" : "000000"}&'" -c:a copy "${outputPath}"`;

  try {
    await execAsync(cmd, { timeout: 120_000 });
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    return { success: true, output_path: outputPath };
  } catch (err: any) {
    if (fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    return { success: false, output_path: "", error: err.message };
  }
}

// ─── Tool: concat_videos ──────────────────────────────────────────────────────
export async function concatVideos(
  videoPaths: string[],
  outputName: string
): Promise<VideoResult> {
  const listFile = path.join(OUTPUT_DIR, `concat_${Date.now()}.txt`);
  const outputPath = path.join(OUTPUT_DIR, `${outputName}.mp4`);

  const listContent = videoPaths.map((p) => `file '${p}'`).join("\n");
  fs.writeFileSync(listFile, listContent);

  const cmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`;

  try {
    await execAsync(cmd, { timeout: 300_000 });
    fs.unlinkSync(listFile);
    return { success: true, output_path: outputPath };
  } catch (err: any) {
    if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    return { success: false, output_path: "", error: err.message };
  }
}

// ─── Tool registry ────────────────────────────────────────────────────────────
export const videoComposerTools = {
  images_to_video: imagesToVideo,
  add_audio_to_video: addAudioToVideo,
  trim_video: trimVideo,
  add_subtitles: addSubtitles,
  concat_videos: concatVideos,
};
