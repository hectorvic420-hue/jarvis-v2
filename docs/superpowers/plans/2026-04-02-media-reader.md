# Media Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Jarvis to receive images and documents (PDF, Word, Excel) via Telegram and WhatsApp, extract their content, and analyze them with Claude Vision / text extraction.

**Architecture:** A new `media_processor.ts` handles buffer-to-content conversion (images→base64, docs→text). `LLMMessage` is extended with an `imageBlocks` field so Claude Vision receives images natively. `agent.ts` accepts optional `imageBlocks` and `extractedText` in `AgentOptions`. Both bots get new handlers that download files, call `media_processor`, and route to `runAgent`.

**Tech Stack:** `pdf-parse` (PDF text extraction), `mammoth` (Word .docx), `xlsx` (Excel), Anthropic Vision API (images), existing `downloadMedia` from `whatsapp.ts`, grammy `ctx.api.getFile` (Telegram).

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/bot/media_processor.ts` | Create | Download URL + process buffer by type |
| `src/llm.ts` | Modify | Add `ImageBlock` type + `imageBlocks` on `LLMMessage` + handle in `callClaude` |
| `src/agent.ts` | Modify | Add `imageBlocks?` + `extractedText?` to `AgentOptions`, build multi-part user message |
| `src/tools/whatsapp.ts` | Modify | Add `caption?` to `WaMessage`, extract from Whapi webhook payload |
| `src/bot/whatsapp.route.ts` | Modify | Handle `msg.type === "image"` and `"document"` before the `!userInput.trim()` guard |
| `src/bot/telegram.ts` | Modify | Add `bot.on("message:photo")` and `bot.on("message:document")` handlers |
| `package.json` | Modify | Add `pdf-parse`, `mammoth`, `xlsx` + `@types/pdf-parse` |

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime + type packages**

```bash
cd C:\Users\ACER\Jarvis-V2
npm install pdf-parse mammoth xlsx
npm install --save-dev @types/pdf-parse
```

Expected output: 3 packages added, no errors.

- [ ] **Step 2: Verify build still passes**

```bash
npm run build
```

Expected: `tsc` completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add pdf-parse, mammoth, xlsx for media processing"
```

---

## Task 2: Create `src/bot/media_processor.ts`

**Files:**
- Create: `src/bot/media_processor.ts`

- [ ] **Step 1: Create the file**

```typescript
// src/bot/media_processor.ts
import pdfParse from "pdf-parse";
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
      const data = await pdfParse(buffer);
      const text = data.text.trim();
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
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bot/media_processor.ts
git commit -m "feat: add media_processor — image base64 + PDF/Word/Excel text extraction"
```

---

## Task 3: Extend `src/llm.ts` — ImageBlock type + Claude Vision support

**Files:**
- Modify: `src/llm.ts`

The `LLMMessage.content` stays as `string | null`. We add an optional `imageBlocks` field. In `callClaude`, when a user message has `imageBlocks`, build a content array instead of a plain string. Other providers (`callGroq`, `callOpenRouter`) ignore `imageBlocks` entirely — the text alone is sent as fallback.

- [ ] **Step 1: Export `ImageBlock` type and add `imageBlocks` to `LLMMessage`**

In `src/llm.ts`, after the existing imports, find the `LLMMessage` interface (line 9) and add the `ImageBlock` export and the new field:

```typescript
// Add this ABOVE the LLMMessage interface (around line 9):
export interface ImageBlock {
  media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string; // base64
}

// Add `imageBlocks?` to the existing LLMMessage interface:
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  imageBlocks?: ImageBlock[];  // ← new field
}
```

- [ ] **Step 2: Handle `imageBlocks` in `callClaude`**

In `callClaude`, find the final `return` inside the `.map()` call (around line 100-103):

```typescript
// BEFORE (existing code):
    return {
      role: m.role as "user" | "assistant",
      content: m.content ?? "",
    };

// AFTER (replace with):
    if (m.role === "user" && m.imageBlocks?.length) {
      const content: Anthropic.MessageParam["content"] = [
        ...m.imageBlocks.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.media_type,
            data: img.data,
          },
        })),
        { type: "text" as const, text: m.content ?? "" },
      ];
      return { role: "user" as const, content };
    }
    return {
      role: m.role as "user" | "assistant",
      content: m.content ?? "",
    };
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/llm.ts
git commit -m "feat: add ImageBlock type and Claude Vision support to LLMMessage"
```

---

## Task 4: Extend `src/agent.ts` — accept `imageBlocks` and `extractedText`

**Files:**
- Modify: `src/agent.ts`

- [ ] **Step 1: Import `ImageBlock` and extend `AgentOptions`**

At the top of `src/agent.ts`, the existing import from `./llm.js` is:
```typescript
import { callLLM, LLMMessage, LLMTool, LLMResponse } from "./llm.js";
```

Change it to:
```typescript
import { callLLM, LLMMessage, LLMTool, LLMResponse, ImageBlock } from "./llm.js";
```

Then extend `AgentOptions` (currently lines 7-11):

```typescript
export interface AgentOptions {
  tools:         Tool[];
  systemPrompt:  string;
  userId:        string | number;
  imageBlocks?:  ImageBlock[];   // ← new: for image analysis
  extractedText?: string;        // ← new: pre-extracted text from docs
}
```

- [ ] **Step 2: Build multi-part first user message in `runAgent`**

In `runAgent`, find the line that pushes the user message (around line 140):
```typescript
// BEFORE:
  messages.push({ role: "user", content: userMessage });

// AFTER (replace with):
  let finalUserMessage = userMessage;
  if (options.extractedText) {
    finalUserMessage =
      `[Contenido extraído del archivo:]\n${options.extractedText}\n\n` +
      `Mensaje del usuario: ${userMessage}`;
  }

  const userMsg: LLMMessage = { role: "user", content: finalUserMessage };
  if (options.imageBlocks?.length) {
    userMsg.imageBlocks = options.imageBlocks;
  }
  messages.push(userMsg);
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/agent.ts
git commit -m "feat: extend AgentOptions with imageBlocks and extractedText for media analysis"
```

---

## Task 5: Update `src/tools/whatsapp.ts` — extract caption from Whapi webhook

**Files:**
- Modify: `src/tools/whatsapp.ts`

- [ ] **Step 1: Add `caption?` to `WaMessage`**

Find the `WaMessage` interface and add the `caption` field:

```typescript
export interface WaMessage {
  message_id:  string;
  from:        string;
  from_number: string;
  body:        string;
  type: "text" | "audio" | "image" | "document" | "video" | "sticker" | "unknown";
  timestamp:   number;
  is_group:    boolean;
  caption?:    string;  // ← new: caption/text attached to image or document
}
```

- [ ] **Step 2: Extract caption in `parseWebhookPayload`**

Find the `image` and `document` branches inside `parseWebhookPayload`:

```typescript
// BEFORE:
    } else if (msg.type === "image") {
      type = "image";
    } else if (msg.type === "document") {
      type = "document";

// AFTER:
    } else if (msg.type === "image") {
      type = "image";
      text = (msg.image?.caption as string | undefined) ?? "";
    } else if (msg.type === "document") {
      type = "document";
      text = (msg.document?.caption as string | undefined) ?? "";
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/whatsapp.ts
git commit -m "feat: extract image/document caption from Whapi webhook payload"
```

---

## Task 6: Add media handling in `src/bot/whatsapp.route.ts`

**Files:**
- Modify: `src/bot/whatsapp.route.ts`

- [ ] **Step 1: Add import at the top of the file**

After the existing imports, add:

```typescript
import { processMediaBuffer, mimeTypeToExt } from "./media_processor.js";
```

- [ ] **Step 2: Fix the `!userInput.trim()` guard**

Find line 74:
```typescript
  if (!userInput.trim()) return;
```

Change to:
```typescript
  if (!userInput.trim() && msg.type === "text") return;
```

- [ ] **Step 3: Add image and document handlers in `processMessage`**

After the audio handling block (after the `if (msg.type === "audio" && msg.message_id)` block and before `if (!userInput.trim() && msg.type === "text") return;`), add:

```typescript
  // ── Image ──────────────────────────────────────────────────────────────────
  if (msg.type === "image") {
    const mediaData = await downloadMedia(msg.message_id, msg.from);
    if (!mediaData) {
      await sendText(msg.from, "❌ No pude descargar la imagen. Intenta de nuevo.");
      return;
    }
    const mediaResult = await processMediaBuffer(mediaData.buffer, "photo.jpg");
    if (mediaResult.error) {
      await sendText(msg.from, mediaResult.error);
      return;
    }
    const caption = userInput || "Describe esta imagen en detalle";
    const uid = parseInt(userId.replace(/\D/g, ""), 10) || 0;
    memoryService.addMessage(uid, "user", `[imagen] ${caption}`, "whatsapp");
    const agentResult = await runAgent(caption, {
      tools: Object.values(toolRegistry),
      systemPrompt: SYSTEM_PROMPT,
      userId: uid,
      imageBlocks: mediaResult.imageBlock ? [mediaResult.imageBlock] : undefined,
    });
    memoryService.addMessage(uid, "assistant", agentResult.response, "whatsapp");
    const chunks = splitMessage(agentResult.response, 4000);
    for (const chunk of chunks) await sendText(msg.from, chunk);
    return;
  }

  // ── Document ──────────────────────────────────────────────────────────────
  if (msg.type === "document") {
    const mediaData = await downloadMedia(msg.message_id, msg.from);
    if (!mediaData) {
      await sendText(msg.from, "❌ No pude descargar el documento. Intenta de nuevo.");
      return;
    }
    const ext = mimeTypeToExt(mediaData.mimetype);
    const mediaResult = await processMediaBuffer(mediaData.buffer, `documento.${ext}`);
    if (mediaResult.error) {
      await sendText(msg.from, mediaResult.error);
      return;
    }
    const caption = userInput || "Analiza este documento y explica su contenido";
    const uid = parseInt(userId.replace(/\D/g, ""), 10) || 0;
    memoryService.addMessage(uid, "user", `[documento] ${caption}`, "whatsapp");
    const agentResult = await runAgent(caption, {
      tools: Object.values(toolRegistry),
      systemPrompt: SYSTEM_PROMPT,
      userId: uid,
      imageBlocks: mediaResult.imageBlock ? [mediaResult.imageBlock] : undefined,
      extractedText: mediaResult.extractedText,
    });
    memoryService.addMessage(uid, "assistant", agentResult.response, "whatsapp");
    const chunks = splitMessage(agentResult.response, 4000);
    for (const chunk of chunks) await sendText(msg.from, chunk);
    return;
  }
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/bot/whatsapp.route.ts
git commit -m "feat: handle image and document messages in WhatsApp bot"
```

---

## Task 7: Add media handlers in `src/bot/telegram.ts`

**Files:**
- Modify: `src/bot/telegram.ts`

- [ ] **Step 1: Add imports**

At the top of `src/bot/telegram.ts`, add after existing imports:

```typescript
import { processMediaBuffer } from "./media_processor.js";
```

- [ ] **Step 2: Add `message:photo` handler**

Inside `createTelegramBot()`, add this handler BEFORE the `bot.on("message")` catch-all (which is near the end, around line 352):

```typescript
  // ── Fotos ─────────────────────────────────────────────────────────────────
  bot.on("message:photo", async (ctx) => {
    const userId  = ctx.from.id;
    const photo   = ctx.message.photo.at(-1)!;  // highest resolution
    const caption = ctx.message.caption ?? "Describe esta imagen en detalle";

    const processingMsg = await ctx.reply("⏳ Analizando imagen...");
    try {
      const fileInfo = await ctx.api.getFile(photo.file_id);
      const url      = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res      = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer   = Buffer.from(await res.arrayBuffer());

      const media = await processMediaBuffer(buffer, "photo.jpg");
      if (media.error) {
        await tryDelete(ctx, processingMsg.message_id);
        await ctx.reply(media.error);
        return;
      }

      const tools = Object.values(toolRegistry);
      memoryService.addMessage(userId, "user", `[imagen] ${caption}`, "telegram");

      const result = await runAgent(caption, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
        imageBlocks: media.imageBlock ? [media.imageBlock] : undefined,
      });

      await tryDelete(ctx, processingMsg.message_id);
      memoryService.addMessage(userId, "assistant", result.response, "telegram");
      await sendLong(ctx, result.response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      await ctx.reply(`❌ Error analizando imagen: ${(err as Error).message}`);
    }
  });
```

Note: `token` is the variable already defined at the top of `createTelegramBot()`:
```typescript
const token = process.env.TELEGRAM_BOT_TOKEN;
```

- [ ] **Step 3: Add `message:document` handler**

Immediately after the photo handler, add:

```typescript
  // ── Documentos ───────────────────────────────────────────────────────────
  bot.on("message:document", async (ctx) => {
    const userId   = ctx.from.id;
    const doc      = ctx.message.document;
    const caption  = ctx.message.caption ?? "Analiza este documento y explica su contenido";
    const filename = doc.file_name ?? "documento.bin";

    const processingMsg = await ctx.reply("⏳ Leyendo documento...");
    try {
      const fileInfo = await ctx.api.getFile(doc.file_id);
      const url      = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
      const res      = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer   = Buffer.from(await res.arrayBuffer());

      const media = await processMediaBuffer(buffer, filename);
      if (media.error) {
        await tryDelete(ctx, processingMsg.message_id);
        await ctx.reply(media.error);
        return;
      }

      const tools = Object.values(toolRegistry);
      memoryService.addMessage(userId, "user", `[doc: ${filename}] ${caption}`, "telegram");

      const result = await runAgent(caption, {
        tools,
        systemPrompt: SYSTEM_PROMPT,
        userId,
        imageBlocks:   media.imageBlock   ? [media.imageBlock]   : undefined,
        extractedText: media.extractedText,
      });

      await tryDelete(ctx, processingMsg.message_id);
      memoryService.addMessage(userId, "assistant", result.response, "telegram");
      await sendLong(ctx, result.response);
    } catch (err) {
      await tryDelete(ctx, processingMsg.message_id);
      await ctx.reply(`❌ Error leyendo documento: ${(err as Error).message}`);
    }
  });
```

- [ ] **Step 4: Update the catch-all `bot.on("message")` message**

Find:
```typescript
  bot.on("message", async (ctx) => {
    await ctx.reply(
      "📎 Por ahora solo proceso texto. Envíame tu consulta en texto."
    );
  });
```

Replace with:
```typescript
  bot.on("message", async (ctx) => {
    await ctx.reply(
      "❌ No puedo procesar ese tipo de archivo. Envíame texto, fotos, PDFs, Word (.docx) o Excel (.xlsx)."
    );
  });
```

- [ ] **Step 5: Build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/bot/telegram.ts
git commit -m "feat: handle photo and document messages in Telegram bot"
```

---

## Task 8: Deploy and test

- [ ] **Step 1: Push to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Deploy on server**

SSH into the server and run:

```bash
cd /opt/jarvis/jarvis-v2
git pull origin main && npm install && npm run build && pm2 restart jarvis-v2
```

Note: `npm install` is required (not just build) because `pdf-parse`, `mammoth`, and `xlsx` need to be installed on the server too.

- [ ] **Step 3: Test images in Telegram**

Send a photo to the Telegram bot. Expected: Jarvis replies with a description of the image.

- [ ] **Step 4: Test PDF in Telegram**

Send a PDF file to the Telegram bot with caption "resume este documento". Expected: Jarvis replies with a summary.

- [ ] **Step 5: Test unsupported type**

Send a video to the Telegram bot. Expected: "No puedo procesar ese tipo de archivo..."
