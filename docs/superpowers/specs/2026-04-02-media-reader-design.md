# Media Reader — Diseño Técnico
**Fecha:** 2026-04-02  
**Proyecto:** Jarvis V2 — David Academy

---

## Resumen

Jarvis puede recibir imágenes, PDFs, Word y Excel desde Telegram y WhatsApp, extraer su contenido y analizarlo con Claude. El usuario envía el archivo con o sin texto acompañante y Jarvis responde con un análisis completo.

**Videos:** fuera de scope por ahora.

---

## Arquitectura

```
Usuario envía foto/PDF → Bot (Telegram o WhatsApp)
  ↓
media_processor.ts
  - Descarga el archivo desde la API
  - Detecta tipo: imagen | PDF | Word | Excel
  - Imagen  → base64 (jpeg/png/webp/gif)
  - PDF     → texto plano (pdf-parse)
  - Word    → texto plano (mammoth)
  - Excel   → tabla en texto (xlsx)
  ↓
runAgent(textoDelUsuario, { ..., images?, extractedText? })
  ↓
Claude Vision o Claude texto responde al usuario
```

---

## Archivos

### Nuevo

| Archivo | Rol |
|---------|-----|
| `src/bot/media_processor.ts` | Descarga archivos y extrae contenido según tipo |

### Modificados

| Archivo | Cambio |
|---------|--------|
| `src/agent.ts` | Acepta `images?: ImageBlock[]` y `extractedText?: string` en opciones de `runAgent` |
| `src/bot/telegram.ts` | Maneja `message:photo` y `message:document` |
| `src/bot/whatsapp.route.ts` | Maneja mensajes de media de Whapi |
| `package.json` | Agregar `pdf-parse`, `mammoth`, `xlsx` + sus tipos |

---

## Fase 1 — media_processor.ts

### Interfaz

```typescript
export interface MediaResult {
  type: "image" | "document";
  // Para imágenes:
  base64?: string;
  mimeType?: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  // Para documentos:
  extractedText?: string;
  filename?: string;
}

export async function processMediaUrl(
  url: string,
  filename: string,
  authHeader?: string   // para Telegram que requiere token
): Promise<MediaResult>
```

### Detección de tipo

| Extensión / MIME | Procesamiento |
|-----------------|---------------|
| jpg, jpeg, png, webp, gif | base64 → Claude Vision |
| pdf | pdf-parse → texto |
| docx | mammoth → texto |
| xlsx, xls | xlsx → tabla texto |
| Otros | Error descriptivo al usuario |

### Descarga

- Telegram: la URL de descarga requiere el bot token → `https://api.telegram.org/file/bot{TOKEN}/{file_path}`
- WhatsApp (Whapi): la URL del media viene en el webhook, puede requerir header `Authorization: Bearer {WHAPI_TOKEN}`

---

## Fase 2 — Cambios en agent.ts

### Tipo extendido

```typescript
interface RunAgentOptions {
  tools: Tool[];
  systemPrompt: string;
  userId: number;
  images?: Array<{
    type: "base64";
    media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
    data: string;
  }>;
  extractedText?: string;
}
```

### Construcción del mensaje

- Si hay `extractedText`: se antepone al mensaje del usuario como bloque de contexto
  ```
  [Contenido extraído del archivo "nombre.pdf":]
  <texto extraído>
  
  Mensaje del usuario: <mensaje>
  ```
- Si hay `images`: el mensaje inicial a Claude se construye como `content: [{ type: "image", ... }, { type: "text", text: ... }]`

---

## Fase 3 — Telegram

### Handler `message:photo`

```typescript
bot.on("message:photo", async (ctx) => {
  const photo = ctx.message.photo.at(-1)!;  // mayor resolución
  const file  = await ctx.api.getFile(photo.file_id);
  const url   = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const caption = ctx.message.caption ?? "Describe esta imagen";

  const media = await processMediaUrl(url, "photo.jpg");
  const result = await runAgent(caption, { tools, systemPrompt, userId, images: [media] });
  await sendLong(ctx, result.response);
});
```

### Handler `message:document`

```typescript
bot.on("message:document", async (ctx) => {
  const doc  = ctx.message.document;
  const file = await ctx.api.getFile(doc.file_id);
  const url  = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;
  const caption = ctx.message.caption ?? "Analiza este documento";

  const media = await processMediaUrl(url, doc.file_name ?? "documento");
  if (media.type === "image") {
    result = await runAgent(caption, { ..., images: [media] });
  } else {
    result = await runAgent(caption, { ..., extractedText: media.extractedText });
  }
  await sendLong(ctx, result.response);
});
```

El handler genérico `bot.on("message")` pasa a ser solo fallback para tipos no soportados (video, sticker, audio).

---

## Fase 4 — WhatsApp (Whapi)

Los mensajes de media de Whapi llegan en el webhook con:
```json
{
  "type": "image" | "document",
  "image": { "link": "...", "caption": "..." },
  "document": { "link": "...", "filename": "...", "caption": "..." }
}
```

El handler en `whatsapp.route.ts` detecta estos tipos, llama a `processMediaUrl` con el header `Authorization: Bearer ${WHAPI_TOKEN}` y luego pasa el resultado a `runAgent`.

---

## Dependencias nuevas

```bash
npm install pdf-parse mammoth xlsx
npm install --save-dev @types/pdf-parse @types/mammoth
```

`xlsx` ya incluye sus tipos.

---

## Límites y errores

| Caso | Respuesta al usuario |
|------|----------------------|
| Tipo no soportado (video, audio, sticker) | "No puedo procesar ese tipo de archivo aún. Envíame imágenes, PDFs, Word o Excel." |
| Archivo > 20MB | "El archivo es muy grande. Máximo 20MB." |
| PDF sin texto (solo imágenes escaneadas) | "El PDF no contiene texto extraíble. Intenta enviar una foto directamente." |
| Error de descarga | "No pude descargar el archivo. Intenta de nuevo." |

---

## Orden de implementación

1. `npm install` dependencias
2. `src/bot/media_processor.ts`
3. Modificar `src/agent.ts` — soporte de `images` y `extractedText`
4. Modificar `src/bot/telegram.ts` — handlers photo y document
5. Modificar `src/bot/whatsapp.route.ts` — handlers media Whapi
