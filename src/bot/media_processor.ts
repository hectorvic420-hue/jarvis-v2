// src/bot/media_processor.ts
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import path from "path";

export type ImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export interface ImageBlock {
  media_type: ImageMimeType;
  data: string; // base64
}

export interface MediaResult {
  type: "image" | "document" | "unsupported";
  imageBlock?: ImageBlock;
  extractedText?: string;
  filename: string;
  error?: string;
}

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

const MIME_MAP: Record<string, ImageMimeType> = {
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  gif:  "image/gif",
};

function getExt(filename: string): string {
  return path.extname(filename).toLowerCase().replace(".", "");
}

export async function processMediaBuffer(
  buffer: Buffer,
  filename: string
): Promise<MediaResult> {
  const ext = getExt(filename);

  // ── Images ────────────────────────────────────────────────────────────────
  if (IMAGE_EXTS.has(ext)) {
    const mimeType = MIME_MAP[ext] ?? "image/jpeg";
    return {
      type: "image",
      imageBlock: { media_type: mimeType, data: buffer.toString("base64") },
      filename,
    };
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  if (ext === "pdf") {
    try {
      const parser = new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      const text = textResult.text.trim();
      await parser.destroy();
      if (!text) {
        return {
          type: "document",
          filename,
          error:
            "El PDF no contiene texto extraíble. Intenta enviar una foto directamente.",
        };
      }
      return { type: "document", extractedText: text, filename };
    } catch (err: any) {
      return {
        type: "document",
        filename,
        error: `Error leyendo PDF: ${err.message as string}`,
      };
    }
  }

  // ── Word (.docx) ──────────────────────────────────────────────────────────
  if (ext === "docx") {
    try {
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.trim();
      if (!text) {
        return { type: "document", filename, error: "El documento Word está vacío." };
      }
      return { type: "document", extractedText: text, filename };
    } catch (err: any) {
      return {
        type: "document",
        filename,
        error: `Error leyendo Word: ${err.message as string}`,
      };
    }
  }

  // ── Excel (.xlsx / .xls) ─────────────────────────────────────────────────
  if (ext === "xlsx" || ext === "xls") {
    try {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map((name) => {
        const ws = workbook.Sheets[name];
        return `=== Hoja: ${name} ===\n${XLSX.utils.sheet_to_csv(ws)}`;
      });
      const text = sheets.join("\n\n").trim();
      if (!text) {
        return { type: "document", filename, error: "El archivo Excel está vacío." };
      }
      return { type: "document", extractedText: text, filename };
    } catch (err: any) {
      return {
        type: "document",
        filename,
        error: `Error leyendo Excel: ${err.message as string}`,
      };
    }
  }

  // ── Unsupported ───────────────────────────────────────────────────────────
  return {
    type: "unsupported",
    filename,
    error:
      "Tipo de archivo no soportado. Envíame imágenes (jpg/png/webp), PDF, Word (.docx) o Excel (.xlsx).",
  };
}

/** Maps common MIME types to file extensions for buffer detection. */
export function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
  };
  return map[mimeType] ?? "bin";
}
