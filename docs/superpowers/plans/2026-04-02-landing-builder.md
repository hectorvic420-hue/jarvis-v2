# Landing Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Jarvis puede crear landing pages profesionales completas a partir de un prompt, publicarlas en GCP, y recibirlas desde WhatsApp/Telegram o un formulario web.

**Architecture:** La `landing_builder` tool recibe un prompt libre, llama a Claude con un prompt experto, guarda el HTML en disco y lo sirve via Express en `/l/:slug`. El wizard conversacional y el formulario web son dos canales de entrada que invocan la misma tool. SQLite guarda metadata de cada landing.

**Tech Stack:** TypeScript, Express 5, better-sqlite3, @anthropic-ai/sdk (directo, no el agente), HTML/CSS/JS vanilla para el wizard web.

---

## File Map

| Acción | Archivo | Responsabilidad |
|--------|---------|-----------------|
| Crear | `src/tools/landing_prompts.ts` | LANDING_EXPERT_PROMPT + definición de 6 estilos |
| Crear | `src/tools/landing_builder.ts` | Tool `landing_builder` registrada en Jarvis |
| Crear | `src/bot/landing_wizard.ts` | Estado del wizard conversacional por usuario |
| Crear | `src/routes/landings.route.ts` | Express: `/l/:slug`, `/api/landings`, `/landing-wizard` |
| Crear | `src/public/wizard/index.html` | Formulario web (wizard visual, HTML autocontenido) |
| Modificar | `src/memory/db.ts` | Agregar tabla `landings` |
| Modificar | `src/tools/index.ts` | Registrar `landingBuilderTool` |
| Modificar | `src/index.ts` | Montar `landingsRouter` y servir `/public` |
| Modificar | `src/bot/whatsapp.route.ts` | Interceptar wizard antes del agente |
| Modificar | `src/bot/telegram.ts` | Interceptar wizard antes del agente |

---

## Task 1: Tabla SQLite `landings`

**Files:**
- Modify: `src/memory/db.ts`

- [ ] **Step 1: Agregar migración de la tabla `landings` en `db.ts`**

Al final del bloque `db.exec(...)` existente (después de `CREATE INDEX IF NOT EXISTS idx_tasks_status`), agrega:

```typescript
// Al final del string de db.exec, antes del backtick de cierre:

  CREATE TABLE IF NOT EXISTS landings (
    slug         TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    style        TEXT NOT NULL DEFAULT 'futuristic',
    checkout_url TEXT,
    pixel_id     TEXT,
    ga_id        TEXT,
    html_path    TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    views        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_landings_created ON landings(created_at);
```

- [ ] **Step 2: Verificar que el servidor arranca sin errores**

```bash
cd C:/Users/ACER/Jarvis-V2
npm run dev
```

Esperado: `✅ Servidor Express online en puerto 8080` sin errores de SQLite.

- [ ] **Step 3: Commit**

```bash
git add src/memory/db.ts
git commit -m "feat: add landings table to SQLite"
```

---

## Task 2: Prompts expertos y definición de estilos

**Files:**
- Create: `src/tools/landing_prompts.ts`

- [ ] **Step 1: Crear `src/tools/landing_prompts.ts`**

```typescript
// src/tools/landing_prompts.ts

export interface LandingStyle {
  id:          string;
  name:        string;
  description: string;
  palette:     string;  // descripción para Claude
}

export const LANDING_STYLES: Record<string, LandingStyle> = {
  futuristic: {
    id:          "futuristic",
    name:        "Futurista",
    description: "Dark mode cyberpunk. Fondo negro #0a0a0f, acentos cyan #00d4ff y púrpura #7b2ff7. Tipografía Inter + monospace. Efectos de glow, grid de puntos en el fondo, gradientes neón. Bordes con glow effect. Botones con gradiente cyan→púrpura.",
    palette:     "#0a0a0f, #00d4ff, #7b2ff7, #ffffff",
  },
  premium: {
    id:          "premium",
    name:        "Premium",
    description: "Elegancia minimalista. Fondo crema #fafaf8, tipografía Playfair Display para títulos + Inter para cuerpo. Color dorado #b89a5a como acento. Negro #1a1a1a. Mucho espacio en blanco. Líneas finas. Sensación de lujo y exclusividad.",
    palette:     "#fafaf8, #1a1a1a, #b89a5a",
  },
  energetic: {
    id:          "energetic",
    name:        "Energético",
    description: "Alta conversión y urgencia. Gradiente naranja #ff4500 → amarillo #ffd700. Tipografía Montserrat Black para titulares en mayúsculas. Badges de urgencia, emojis de fuego, countdown prominente. Botones redondos grandes con sombra.",
    palette:     "#ff4500, #ff8c00, #ffd700, #ffffff",
  },
  corporate: {
    id:          "corporate",
    name:        "Corporativo",
    description: "Profesional y confiable. Azul marino #1a237e fondo oscuro, azul cielo #1976d2 acentos, blanco puro. Tipografía Roboto. Iconos con estilo Material. Estructura clara y ordenada. Transmite autoridad y confianza empresarial.",
    palette:     "#1a237e, #1976d2, #ffffff, #f5f5f5",
  },
  natural: {
    id:          "natural",
    name:        "Natural",
    description: "Orgánico y humano. Verde bosque #2d6a4f, crema #fefae0, tierra #bc6c25. Tipografía Lato + Georgia. Texturas sutiles, formas orgánicas redondeadas. Ideal para salud, bienestar, coaching de vida y nutrición.",
    palette:     "#2d6a4f, #fefae0, #bc6c25, #1b4332",
  },
  bold: {
    id:          "bold",
    name:        "Bold",
    description: "Impacto máximo. Fondo morado oscuro #1a0533, magenta brillante #e040fb como acento, blanco puro. Tipografía Bebas Neue para titulares + Inter. Elementos oversized, contraste extremo, energía creativa y disruptiva.",
    palette:     "#1a0533, #e040fb, #ffffff, #2d0a5e",
  },
};

export const AUTO_STYLE_RULES = `
Elige el estilo basándote en el nicho:
- Tech, IA, crypto, marketing digital, SaaS → futuristic
- Coaching de alto valor, consultoría, finanzas personales → premium
- Infoproductos, webinars, lanzamientos, cursos masivos → energetic
- B2B, formación empresarial, RRHH, liderazgo → corporate
- Salud, nutrición, bienestar, yoga, mindfulness → natural
- Música, arte, creatividad, entretenimiento, moda → bold
`;

export const LANDING_EXPERT_PROMPT = `Eres un experto mundial en diseño de landing pages de alta conversión con 15 años de experiencia. Conoces en profundidad:
- Copywriting de respuesta directa (AIDA, PAS, Story-Bridge-Offer)
- Psicología de compra y principios de Cialdini (urgencia, escasez, prueba social, autoridad)
- Diseño UI/UX mobile-first
- Optimización de tasas de conversión (CRO)
- HTML/CSS/JS moderno y semántico

Tu tarea es generar UNA landing page completa en un SOLO archivo HTML autocontenido. El HTML debe:
1. Ser completamente responsive (mobile-first con media queries)
2. No tener dependencias externas excepto Google Fonts (CDN) y opcionalmente Font Awesome (CDN)
3. Incluir todo el CSS inline en <style> y todo el JS inline en <script>
4. Cargar rápido: sin frameworks pesados, sin jQuery
5. Tener meta tags SEO básicos y Open Graph
6. Funcionar perfectamente en Chrome, Firefox y Safari

SECCIONES OBLIGATORIAS (en este orden):
1. <head> con meta tags, OG tags, Google Fonts, y snippets de tracking (Pixel Meta si se provee, GA4 si se provee)
2. Navbar sticky minimalista con CTA
3. Hero: headline poderoso (máx 10 palabras), subheadline que amplía el beneficio, botón CTA principal que lleve al checkout_url
4. Video section: embed de YouTube/Vimeo si se provee video_url, de lo contrario una sección de "Por qué este curso" con 3 puntos clave
5. Beneficios: grid de 6 beneficios con icono SVG inline y texto. Titulares en imperativo ("Domina X", "Aprende Y")
6. Para quién es: 3 perfiles del estudiante ideal con ✅, y 3 perfiles de quién NO es con ❌
7. Módulos/Temario: lista de 5-8 módulos con número, título y descripción breve
8. Sobre el autor: foto placeholder elegante, nombre "David", bio que transmita autoridad y resultados
9. Testimonios: 3 testimonios con foto avatar SVG, nombre, cargo/contexto y resultado específico en negrita
10. Countdown timer: JS vanilla que cuenta regresiva. Si countdown_hours > 0 cuenta desde ahora, sino usa una fecha fija 7 días adelante
11. Garantía: badge visual de garantía de satisfacción de 30 días
12. FAQ: 5 preguntas frecuentes con accordion CSS puro (sin JS)
13. CTA final: sección de cierre con headline de urgencia + precio + botón grande al checkout_url
14. Footer: copyright David Academy + aviso legal mínimo

REGLAS DE COPYWRITING:
- El headline del hero debe crear curiosidad o prometer una transformación específica
- Usa números específicos ("en 30 días", "5 módulos", "+500 estudiantes")
- Los testimonios deben mencionar resultados concretos ("Generé $2,000 en mi primer mes")
- El FAQ debe responder objeciones reales de compra (precio, tiempo, garantía, resultados)
- Múltiples CTAs a lo largo de la página (después de beneficios, módulos, testimonios y al final)

RESPONDE ÚNICAMENTE CON EL HTML COMPLETO. Sin explicaciones. Sin markdown. Solo el HTML que empiece con <!DOCTYPE html>.`;
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/landing_prompts.ts
git commit -m "feat: add landing prompts and style definitions"
```

---

## Task 3: Tool `landing_builder`

**Files:**
- Create: `src/tools/landing_builder.ts`

- [ ] **Step 1: Crear `src/tools/landing_builder.ts`**

```typescript
// src/tools/landing_builder.ts
import { Tool } from "../shared/types.js";
import { LANDING_EXPERT_PROMPT, LANDING_STYLES, AUTO_STYLE_RULES } from "./landing_prompts.js";
import Anthropic from "@anthropic-ai/sdk";
import db from "../memory/db.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LANDINGS_DIR = process.env.LANDINGS_DIR || path.join(process.cwd(), "landings");
const PUBLIC_URL   = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");

function ensureLandingsDir(): void {
  if (!fs.existsSync(LANDINGS_DIR)) fs.mkdirSync(LANDINGS_DIR, { recursive: true });
}

function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

async function generateHtml(params: {
  prompt:          string;
  style:           string;
  checkout_url:    string;
  pixel_id?:       string;
  ga_id?:          string;
  countdown_hours: number;
  video_url?:      string;
}): Promise<string> {
  const styleObj = LANDING_STYLES[params.style] || LANDING_STYLES.futuristic;

  const userPrompt = `
Crea una landing page con la siguiente información:

DESCRIPCIÓN DEL PRODUCTO:
${params.prompt}

ESTILO VISUAL: ${styleObj.name}
${styleObj.description}
Paleta de colores: ${styleObj.palette}

CHECKOUT URL (todos los botones de compra deben apuntar aquí): ${params.checkout_url}

${params.video_url ? `VIDEO URL: ${params.video_url}` : "Sin video — usa sección 'Por qué este curso' con 3 puntos clave"}
${params.pixel_id ? `META PIXEL ID: ${params.pixel_id}` : ""}
${params.ga_id ? `GOOGLE ANALYTICS ID: ${params.ga_id}` : ""}
COUNTDOWN TIMER: ${params.countdown_hours > 0 ? `${params.countdown_hours} horas desde ahora` : "7 días desde hoy"}

Genera el HTML completo ahora.
`;

  const response = await client.messages.create({
    model:      "claude-opus-4-6",
    max_tokens: 8000,
    messages: [
      { role: "user", content: userPrompt },
    ],
    system: LANDING_EXPERT_PROMPT,
  });

  const text = response.content
    .filter(b => b.type === "text")
    .map(b => (b as any).text as string)
    .join("");

  // Extraer solo el HTML (Claude puede agregar texto antes/después)
  const htmlMatch = text.match(/<!DOCTYPE html>[\s\S]*/i);
  return htmlMatch ? htmlMatch[0] : text;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function createLanding(params: Record<string, any>): Promise<string> {
  const {
    prompt,
    checkout_url = "https://pay.hotmart.com/CONFIGURE_URL",
    pixel_id,
    ga_id,
    video_url,
    countdown_hours = 48,
  } = params;

  if (!prompt) return "❌ Falta el parámetro: prompt";

  // Determinar estilo
  let style = (params.style as string) || "auto";
  if (style === "auto") {
    // Pedir a Claude que elija el estilo
    const styleResponse = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 50,
      messages: [{ role: "user", content: `Basado en este producto: "${prompt}"\n\n${AUTO_STYLE_RULES}\n\nResponde SOLO con el ID del estilo (futuristic, premium, energetic, corporate, natural o bold):` }],
    });
    const chosen = (styleResponse.content[0] as any).text?.trim().toLowerCase() ?? "futuristic";
    style = Object.keys(LANDING_STYLES).includes(chosen) ? chosen : "futuristic";
  }

  ensureLandingsDir();

  // Extraer título del prompt para el slug
  const titleResponse = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 30,
    messages: [{ role: "user", content: `Extrae el nombre del curso/producto de este texto en máximo 5 palabras: "${prompt}". Responde solo el nombre, sin puntuación.` }],
  });
  const title = (titleResponse.content[0] as any).text?.trim() ?? "landing";

  const slug     = generateSlug(title);
  const htmlPath = path.join(LANDINGS_DIR, `${slug}.html`);

  // Generar HTML con Claude Opus
  const html = await generateHtml({
    prompt,
    style,
    checkout_url,
    pixel_id,
    ga_id,
    countdown_hours: Number(countdown_hours),
    video_url,
  });

  fs.writeFileSync(htmlPath, html, "utf-8");

  // Guardar en SQLite
  db.prepare(`
    INSERT INTO landings (slug, title, style, checkout_url, pixel_id, ga_id, html_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(slug, title, style, checkout_url || null, pixel_id || null, ga_id || null, htmlPath);

  const url = `${PUBLIC_URL}/l/${slug}`;

  return `✅ *Landing creada exitosamente*\n\n` +
    `🌐 URL: ${url}\n` +
    `🎨 Estilo: ${LANDING_STYLES[style]?.name ?? style}\n` +
    `📋 Título: ${title}\n` +
    `💳 Checkout: ${checkout_url}\n\n` +
    `La página ya está publicada y accesible.`;
}

function listLandings(): string {
  const rows = db.prepare(
    `SELECT slug, title, style, checkout_url, created_at, views FROM landings ORDER BY created_at DESC LIMIT 20`
  ).all() as any[];

  if (rows.length === 0) return "📭 No hay landings creadas todavía.";

  const list = rows.map((r, i) =>
    `${i + 1}. *${r.title}* (${r.style})\n   🌐 ${PUBLIC_URL}/l/${r.slug}\n   👁 ${r.views} visitas · ${r.created_at}`
  ).join("\n\n");

  return `📋 *Landings creadas (${rows.length}):*\n\n${list}`;
}

function deleteLanding(slug: string): string {
  if (!slug) return "❌ Falta el parámetro: slug";

  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) return `❌ No existe una landing con slug: ${slug}`;

  // Eliminar archivo
  try { fs.unlinkSync(row.html_path); } catch { /* ya no existía */ }

  // Eliminar de DB
  db.prepare(`DELETE FROM landings WHERE slug = ?`).run(slug);

  return `🗑 Landing *${slug}* eliminada correctamente.`;
}

function getLanding(slug: string): string {
  if (!slug) return "❌ Falta el parámetro: slug";
  const row = db.prepare(`SELECT * FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) return `❌ No existe landing con slug: ${slug}`;

  return `📄 *Landing: ${row.title}*\n\n` +
    `🌐 URL: ${PUBLIC_URL}/l/${row.slug}\n` +
    `🎨 Estilo: ${row.style}\n` +
    `💳 Checkout: ${row.checkout_url ?? "no configurado"}\n` +
    `👁 Visitas: ${row.views}\n` +
    `📅 Creada: ${row.created_at}`;
}

// ─── Tool Registry ────────────────────────────────────────────────────────────

export const landingBuilderTool: Tool = {
  name: "landing_builder",
  description:
    "Crea, lista, consulta y elimina landing pages profesionales de alta conversión. " +
    "Genera HTML/CSS/JS completo con diseño experto, múltiples secciones (hero, beneficios, testimonios, FAQ, countdown, etc.) " +
    "y las publica automáticamente en el servidor con una URL pública.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create_landing", "list_landings", "delete_landing", "get_landing"],
        description: "create_landing: genera y publica una landing | list_landings: lista todas | delete_landing: elimina una | get_landing: detalles de una",
      },
      prompt: {
        type: "string",
        description: "Descripción del curso/producto/servicio. Puede ser texto libre: 'Curso de marketing digital para emprendedores, precio $197'",
      },
      style: {
        type: "string",
        enum: ["futuristic", "premium", "energetic", "corporate", "natural", "bold", "auto"],
        description: "Estilo visual. 'auto' = Jarvis elige según el nicho detectado",
      },
      checkout_url: {
        type: "string",
        description: "URL de pago (Hotmart, Stripe, MercadoPago, PayPal, etc.)",
      },
      pixel_id: {
        type: "string",
        description: "Meta Pixel ID para tracking (opcional)",
      },
      ga_id: {
        type: "string",
        description: "Google Analytics 4 ID, formato G-XXXXXXXX (opcional)",
      },
      countdown_hours: {
        type: "number",
        description: "Horas para el countdown timer de urgencia. Default: 48",
      },
      video_url: {
        type: "string",
        description: "URL de YouTube o Vimeo para embed en la landing (opcional)",
      },
      slug: {
        type: "string",
        description: "Slug de la landing para delete_landing y get_landing",
      },
    },
    required: ["action"],
  },

  async execute(params, _chatId) {
    const { action, slug } = params as Record<string, any>;
    try {
      if (action === "create_landing") return await createLanding(params);
      if (action === "list_landings")  return listLandings();
      if (action === "delete_landing") return deleteLanding(slug);
      if (action === "get_landing")    return getLanding(slug);
      return "❌ Acción inválida.";
    } catch (err: any) {
      return `❌ Error en landing_builder: ${err.message as string}`;
    }
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/tools/landing_builder.ts
git commit -m "feat: add landing_builder tool with Claude Opus HTML generation"
```

---

## Task 4: Registrar tool y rutas en Express

**Files:**
- Modify: `src/tools/index.ts`
- Create: `src/routes/landings.route.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Registrar tool en `src/tools/index.ts`**

Agrega al bloque de imports (después de la línea de `whatsapp.ts`):

```typescript
import { landingBuilderTool }    from "./landing_builder.js";
```

Agrega en el objeto `tools`:

```typescript
[landingBuilderTool.name]: landingBuilderTool,
```

Agrega también en `SYSTEM_PROMPT` (al final de las reglas de herramientas):

```typescript
`- Para crear, listar o eliminar landing pages de ventas: USA SIEMPRE 'landing_builder'. Cuando el usuario diga "hazme una landing", "crea una página de ventas", "necesito un funnel", usa landing_builder con action='create_landing'.\n`
```

- [ ] **Step 2: Crear `src/routes/landings.route.ts`**

```typescript
// src/routes/landings.route.ts
import { Router, Request, Response } from "express";
import fs   from "fs";
import path from "path";
import db   from "../memory/db.js";

const LANDINGS_DIR = process.env.LANDINGS_DIR || path.join(process.cwd(), "landings");
const router       = Router();

// ─── GET /l/:slug — Servir landing ───────────────────────────────────────────
router.get("/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;

  if (!row) {
    res.status(404).send("<h1>Landing no encontrada</h1>");
    return;
  }

  if (!fs.existsSync(row.html_path)) {
    res.status(404).send("<h1>Archivo no encontrado</h1>");
    return;
  }

  // Incrementar visitas
  db.prepare(`UPDATE landings SET views = views + 1 WHERE slug = ?`).run(slug);

  const html = fs.readFileSync(row.html_path, "utf-8");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ─── GET /api/landings — Listar landings ─────────────────────────────────────
router.get("/api/landings", (_req: Request, res: Response) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");
  const rows = db.prepare(
    `SELECT slug, title, style, checkout_url, created_at, views FROM landings ORDER BY created_at DESC`
  ).all() as any[];

  const result = rows.map(r => ({
    ...r,
    url: `${PUBLIC_URL}/l/${r.slug}`,
  }));

  res.json(result);
});

// ─── DELETE /api/landings/:slug ───────────────────────────────────────────────
router.delete("/api/landings/:slug", (req: Request, res: Response) => {
  const { slug } = req.params;
  const row = db.prepare(`SELECT html_path FROM landings WHERE slug = ?`).get(slug) as any;
  if (!row) { res.status(404).json({ error: "not found" }); return; }

  try { fs.unlinkSync(row.html_path); } catch { /* ok */ }
  db.prepare(`DELETE FROM landings WHERE slug = ?`).run(slug);
  res.json({ ok: true });
});

// ─── GET /api/landings/:slug — Detalle ───────────────────────────────────────
router.get("/api/landings/:slug", (req: Request, res: Response) => {
  const PUBLIC_URL = (process.env.PUBLIC_URL || "http://localhost:8080").replace(/\/$/, "");
  const row = db.prepare(`SELECT * FROM landings WHERE slug = ?`).get(req.params.slug) as any;
  if (!row) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ...row, url: `${PUBLIC_URL}/l/${row.slug}` });
});

export default router;
```

- [ ] **Step 3: Montar rutas en `src/index.ts`**

Agrega el import (después del import de whatsappRouter):

```typescript
import landingsRouter from "./routes/landings.route.js";
```

Agrega la ruta (después de `app.use("/webhook/whatsapp", whatsappRouter)`):

```typescript
app.use("/l", landingsRouter);
```

- [ ] **Step 4: Verificar que el servidor arranca y las rutas existen**

```bash
npm run dev
```

Luego en otro terminal:
```bash
curl http://localhost:8080/l/slug-que-no-existe
```

Esperado: `<h1>Landing no encontrada</h1>` (404)

```bash
curl http://localhost:8080/api/landings
```

Esperado: `[]` (array vacío JSON)

- [ ] **Step 5: Commit**

```bash
git add src/tools/index.ts src/routes/landings.route.ts src/index.ts
git commit -m "feat: register landing_builder tool and mount landings routes"
```

---

## Task 5: Prueba de creación de landing end-to-end

**Files:** ninguno nuevo — prueba funcional

- [ ] **Step 1: Hacer un POST de prueba con curl para crear una landing**

Con el servidor corriendo (`npm run dev`):

```bash
curl -X POST http://localhost:8080/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{
      "id": "test-001",
      "from": "573245597160@s.whatsapp.net",
      "chat_id": "573245597160@s.whatsapp.net",
      "type": "text",
      "text": {"body": "Crea una landing para mi curso de Marketing Digital con IA para emprendedores, precio $197, url de pago https://pay.hotmart.com/TEST123"},
      "timestamp": 1700000000,
      "from_me": false
    }]
  }'
```

Esperado: `{"status":"ok"}` inmediato. Después de ~30 segundos el agente habrá creado la landing.

- [ ] **Step 2: Verificar que la landing existe**

```bash
curl http://localhost:8080/api/landings
```

Esperado: array con 1 landing. Copia el `slug`.

```bash
curl http://localhost:8080/l/[SLUG-COPIADO]
```

Esperado: HTML completo de la landing (>10KB).

- [ ] **Step 3: Abrir en el navegador**

Abre `http://localhost:8080/l/[SLUG]` en el browser. Debes ver una landing completa con todas las secciones.

- [ ] **Step 4: Commit de prueba (solo si hiciste cambios para que funcione)**

```bash
git add -p  # solo archivos modificados durante la prueba
git commit -m "fix: landing end-to-end working"
```

---

## Task 6: Wizard conversacional (WhatsApp / Telegram)

**Files:**
- Create: `src/bot/landing_wizard.ts`
- Modify: `src/bot/whatsapp.route.ts`
- Modify: `src/bot/telegram.ts`

- [ ] **Step 1: Crear `src/bot/landing_wizard.ts`**

```typescript
// src/bot/landing_wizard.ts

export interface WizardState {
  step:           number;
  product_type?:  string;
  name?:          string;
  description?:   string;
  audience?:      string;
  price?:         string;
  checkout_url?:  string;
  video_url?:     string;
  style?:         string;
  pixel_id?:      string;
  ga_id?:         string;
}

// Estado en memoria por userId (string)
const wizardStates = new Map<string, WizardState>();

const TRIGGER_PATTERNS = [
  /crea.*landing/i,
  /hazme.*landing/i,
  /necesito.*landing/i,
  /quiero.*landing/i,
  /página.*ventas/i,
  /pagina.*ventas/i,
  /funnel/i,
  /landing.*page/i,
  /sales.*page/i,
];

export function isLandingTrigger(text: string): boolean {
  return TRIGGER_PATTERNS.some(p => p.test(text));
}

export function hasActiveWizard(userId: string): boolean {
  return wizardStates.has(userId);
}

export function startWizard(userId: string): string {
  wizardStates.set(userId, { step: 0 });
  return (
    "🚀 *Vamos a crear tu landing page.*\n\n" +
    "Paso 1/7: ¿Qué tipo de producto es?\n\n" +
    "A) 📚 Curso online\n" +
    "B) 🎯 Servicio / Consultoría\n" +
    "C) 👥 Membresía / Comunidad\n" +
    "D) 📦 Producto digital (ebook, plantilla, etc.)\n\n" +
    "Responde con la letra o escribe el tipo."
  );
}

export function processWizardStep(userId: string, text: string): { message: string; done: boolean; params?: Record<string, any> } {
  const state = wizardStates.get(userId);
  if (!state) return { message: "", done: false };

  const t = text.trim();

  switch (state.step) {
    case 0: {
      const map: Record<string, string> = { a: "Curso online", b: "Servicio / Consultoría", c: "Membresía / Comunidad", d: "Producto digital" };
      state.product_type = map[t.toLowerCase()] ?? t;
      state.step = 1;
      return { message: "Paso 2/7: ¿Cómo se llama? Dame el nombre y una descripción breve (pueden ser 2 mensajes o uno).", done: false };
    }
    case 1: {
      state.name        = t;
      state.description = t;
      state.step        = 2;
      return { message: "Paso 3/7: ¿A quién va dirigido? Describe tu cliente ideal (ej: 'emprendedores que quieren escalar su negocio con IA').", done: false };
    }
    case 2: {
      state.audience = t;
      state.step     = 3;
      return { message: "Paso 4/7: ¿Cuál es el precio y la URL de pago? (ej: '$197 — https://pay.hotmart.com/XXX')", done: false };
    }
    case 3: {
      // Extraer URL del texto
      const urlMatch = t.match(/https?:\/\/[^\s]+/);
      state.checkout_url = urlMatch ? urlMatch[0] : t;
      state.price        = t;
      state.step         = 4;
      return { message: "Paso 5/7: ¿Tienes un video de presentación? (YouTube o Vimeo). Pega la URL o escribe 'no'.", done: false };
    }
    case 4: {
      state.video_url = /^no$/i.test(t) ? undefined : t;
      state.step      = 5;
      return {
        message:
          "Paso 6/7: ¿Qué estilo visual quieres?\n\n" +
          "🌌 *futuristic* — Dark, neón, tech\n" +
          "✨ *premium* — Elegante, oro, lujo\n" +
          "🔥 *energetic* — Naranja, urgencia, conversión\n" +
          "💼 *corporate* — Azul, profesional, B2B\n" +
          "🌿 *natural* — Verde, orgánico, bienestar\n" +
          "💜 *bold* — Morado, impacto, creativo\n" +
          "🤖 *auto* — Jarvis elige el mejor\n\n" +
          "Escribe el nombre del estilo.",
        done: false,
      };
    }
    case 5: {
      const validStyles = ["futuristic", "premium", "energetic", "corporate", "natural", "bold", "auto"];
      state.style = validStyles.includes(t.toLowerCase()) ? t.toLowerCase() : "auto";
      state.step  = 6;
      return { message: "Paso 7/7 (opcional): ¿Tienes Pixel de Meta o Google Analytics? Escribe los IDs o 'no'.", done: false };
    }
    case 6: {
      if (!/^no$/i.test(t)) {
        const pixelMatch = t.match(/\b\d{10,16}\b/);
        const gaMatch    = t.match(/G-[A-Z0-9]+/i);
        if (pixelMatch) state.pixel_id = pixelMatch[0];
        if (gaMatch)    state.ga_id    = gaMatch[0].toUpperCase();
      }

      // Wizard completo — construir params
      const params = {
        action:          "create_landing",
        prompt:          `${state.product_type ?? "Curso"}: ${state.description ?? ""} — Dirigido a: ${state.audience ?? ""}`,
        style:           state.style ?? "auto",
        checkout_url:    state.checkout_url ?? "",
        video_url:       state.video_url,
        pixel_id:        state.pixel_id,
        ga_id:           state.ga_id,
        countdown_hours: 48,
      };

      wizardStates.delete(userId);

      return {
        message: "✅ ¡Perfecto! Tengo todo lo que necesito. Generando tu landing... esto toma ~30 segundos. ⏳",
        done:    true,
        params,
      };
    }
    default:
      wizardStates.delete(userId);
      return { message: "", done: false };
  }
}

export function cancelWizard(userId: string): void {
  wizardStates.delete(userId);
}
```

- [ ] **Step 2: Integrar wizard en `src/bot/whatsapp.route.ts`**

Agrega los imports al inicio del archivo:

```typescript
import { isLandingTrigger, hasActiveWizard, startWizard, processWizardStep, cancelWizard } from "./landing_wizard.js";
import { landingBuilderTool } from "../tools/landing_builder.js";
```

En la función `processMessage`, justo **antes** del bloque `// ─── Command handling`:

```typescript
  // ─── Landing Wizard ───────────────────────────────────────────────────────
  const userId = msg.from_number;

  if (hasActiveWizard(userId)) {
    const result = processWizardStep(userId, userInput);
    await sendText(msg.from, result.message);
    if (result.done && result.params) {
      try {
        const landingResult = await landingBuilderTool.execute(result.params, msg.from);
        await sendText(msg.from, landingResult);
      } catch (err: any) {
        await sendText(msg.from, `❌ Error al generar la landing: ${err.message}`);
      }
    }
    return;
  }

  if (isLandingTrigger(userInput)) {
    const welcomeMsg = startWizard(userId);
    await sendText(msg.from, welcomeMsg);
    return;
  }
```

- [ ] **Step 3: Integrar wizard en `src/bot/telegram.ts`**

Agrega los imports (después de los imports existentes):

```typescript
import { isLandingTrigger, hasActiveWizard, startWizard, processWizardStep, cancelWizard } from "./landing_wizard.js";
import { landingBuilderTool } from "../tools/landing_builder.js";
```

En el handler `bot.on("message:text", ...)`, antes de la sección de comandos, agrega el bloque del wizard. Busca el handler de texto existente y añade al inicio del handler:

```typescript
  const userId = String(ctx.from!.id);

  // ─── Landing Wizard ───────────────────────────────────────────────────────
  if (hasActiveWizard(userId)) {
    const result = processWizardStep(userId, text);
    if (result.message) await ctx.reply(result.message, { parse_mode: "Markdown" });
    if (result.done && result.params) {
      try {
        const landingResult = await landingBuilderTool.execute(result.params, String(ctx.chat!.id));
        await sendLong(ctx, landingResult);
      } catch (err: any) {
        await ctx.reply(`❌ Error: ${(err as Error).message}`);
      }
    }
    return;
  }

  if (isLandingTrigger(text)) {
    const welcomeMsg = startWizard(userId);
    await ctx.reply(welcomeMsg, { parse_mode: "Markdown" });
    return;
  }
```

- [ ] **Step 4: Verificar que el wizard no rompe el flujo normal**

```bash
npm run dev
```

Envía un mensaje normal al bot de Telegram. Debe responder normalmente sin activar el wizard.

- [ ] **Step 5: Commit**

```bash
git add src/bot/landing_wizard.ts src/bot/whatsapp.route.ts src/bot/telegram.ts
git commit -m "feat: add landing wizard conversational flow for WA and Telegram"
```

---

## Task 7: Wizard web (formulario visual)

**Files:**
- Create: `src/public/wizard/index.html`
- Modify: `src/index.ts` (servir archivos estáticos)

- [ ] **Step 1: Crear directorio y el formulario web**

```bash
mkdir -p src/public/wizard
```

Crea `src/public/wizard/index.html`:

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Jarvis — Crear Landing Page</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #0a0a0f; color: #fff; min-height: 100vh; }
    .container { max-width: 700px; margin: 0 auto; padding: 40px 20px; }
    h1 { font-size: 2rem; font-weight: 800; margin-bottom: 8px; background: linear-gradient(135deg, #00d4ff, #7b2ff7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: rgba(255,255,255,0.5); margin-bottom: 40px; }
    .step { display: none; }
    .step.active { display: block; }
    .step-indicator { font-size: 12px; color: #00d4ff; letter-spacing: 2px; margin-bottom: 12px; }
    h2 { font-size: 1.4rem; margin-bottom: 20px; }
    .options-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 24px; }
    .option-card { border: 2px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s; background: rgba(255,255,255,0.03); }
    .option-card:hover { border-color: #00d4ff; background: rgba(0,212,255,0.05); }
    .option-card.selected { border-color: #00d4ff; background: rgba(0,212,255,0.1); }
    .option-card .icon { font-size: 1.8rem; margin-bottom: 8px; }
    .option-card h3 { font-size: 0.9rem; font-weight: 700; margin-bottom: 4px; }
    .option-card p { font-size: 0.75rem; color: rgba(255,255,255,0.5); }
    label { display: block; font-size: 0.85rem; color: rgba(255,255,255,0.7); margin-bottom: 8px; }
    input, textarea { width: 100%; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 12px 16px; color: #fff; font-size: 0.95rem; margin-bottom: 16px; outline: none; transition: border-color 0.2s; }
    input:focus, textarea:focus { border-color: #00d4ff; }
    textarea { resize: vertical; min-height: 80px; }
    .btn { display: inline-block; padding: 14px 32px; border-radius: 8px; font-weight: 700; font-size: 1rem; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-primary { background: linear-gradient(135deg, #00d4ff, #7b2ff7); color: #fff; width: 100%; }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-secondary { background: rgba(255,255,255,0.1); color: #fff; margin-right: 12px; }
    .style-preview { height: 80px; border-radius: 8px; margin-bottom: 8px; }
    .result-box { background: rgba(0,212,255,0.1); border: 1px solid #00d4ff; border-radius: 12px; padding: 24px; text-align: center; }
    .result-url { font-size: 1.2rem; color: #00d4ff; word-break: break-all; margin: 16px 0; }
    .loading { text-align: center; padding: 40px; }
    .spinner { width: 48px; height: 48px; border: 4px solid rgba(0,212,255,0.2); border-top-color: #00d4ff; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .optional-tag { font-size: 11px; color: rgba(255,255,255,0.3); margin-left: 6px; }
    .nav { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    @media (max-width: 500px) { .options-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <h1>Jarvis Landing Builder</h1>
  <p class="subtitle">Crea una landing de alta conversión en 2 minutos</p>

  <!-- Step 1: Tipo -->
  <div class="step active" id="step-1">
    <div class="step-indicator">PASO 1 DE 5</div>
    <h2>¿Qué tipo de producto es?</h2>
    <div class="options-grid">
      <div class="option-card" onclick="selectOption('product_type','Curso online',this)">
        <div class="icon">📚</div><h3>Curso Online</h3><p>Video clases, tutoriales</p>
      </div>
      <div class="option-card" onclick="selectOption('product_type','Servicio / Consultoría',this)">
        <div class="icon">🎯</div><h3>Servicio / Consultoría</h3><p>Asesoría, coaching 1:1</p>
      </div>
      <div class="option-card" onclick="selectOption('product_type','Membresía / Comunidad',this)">
        <div class="icon">👥</div><h3>Membresía</h3><p>Acceso recurrente, comunidad</p>
      </div>
      <div class="option-card" onclick="selectOption('product_type','Producto digital',this)">
        <div class="icon">📦</div><h3>Producto Digital</h3><p>Ebook, plantilla, software</p>
      </div>
    </div>
    <button class="btn btn-primary" onclick="goStep(2)" id="btn-step1" disabled>Continuar →</button>
  </div>

  <!-- Step 2: Datos básicos -->
  <div class="step" id="step-2">
    <div class="step-indicator">PASO 2 DE 5</div>
    <h2>Cuéntame sobre tu producto</h2>
    <label>Nombre del producto *</label>
    <input type="text" id="name" placeholder="ej: Curso de Marketing Digital con IA" />
    <label>Descripción <span class="optional-tag">(qué aprenden, qué resultados logran)</span></label>
    <textarea id="description" placeholder="ej: Aprende a crear campañas de marketing con inteligencia artificial en 30 días, aunque partas desde cero..."></textarea>
    <label>Audiencia objetivo *</label>
    <input type="text" id="audience" placeholder="ej: Emprendedores que quieren escalar su negocio online" />
    <div class="nav">
      <button class="btn btn-secondary" onclick="goStep(1)">← Atrás</button>
      <button class="btn btn-primary" onclick="goStep(3)" style="flex:1">Continuar →</button>
    </div>
  </div>

  <!-- Step 3: Precio y pago -->
  <div class="step" id="step-3">
    <div class="step-indicator">PASO 3 DE 5</div>
    <h2>Precio y checkout</h2>
    <label>URL de pago (Hotmart, Stripe, etc.) *</label>
    <input type="url" id="checkout_url" placeholder="https://pay.hotmart.com/..." />
    <label>Video de presentación <span class="optional-tag">(YouTube o Vimeo)</span></label>
    <input type="url" id="video_url" placeholder="https://youtube.com/watch?v=..." />
    <label>Meta Pixel ID <span class="optional-tag">(opcional)</span></label>
    <input type="text" id="pixel_id" placeholder="1234567890123456" />
    <label>Google Analytics ID <span class="optional-tag">(opcional)</span></label>
    <input type="text" id="ga_id" placeholder="G-XXXXXXXXXX" />
    <div class="nav">
      <button class="btn btn-secondary" onclick="goStep(2)">← Atrás</button>
      <button class="btn btn-primary" onclick="goStep(4)" style="flex:1">Continuar →</button>
    </div>
  </div>

  <!-- Step 4: Estilo -->
  <div class="step" id="step-4">
    <div class="step-indicator">PASO 4 DE 5</div>
    <h2>Elige el estilo visual</h2>
    <div class="options-grid">
      <div class="option-card" onclick="selectOption('style','futuristic',this)">
        <div class="style-preview" style="background:linear-gradient(135deg,#0a0a0f,#1a0a2e);border:1px solid #00d4ff44;display:flex;align-items:center;justify-content:center;color:#00d4ff;font-size:11px;letter-spacing:2px;">FUTURISTA</div>
        <h3>Futurista</h3><p>Dark, neón, tech, IA</p>
      </div>
      <div class="option-card" onclick="selectOption('style','premium',this)">
        <div class="style-preview" style="background:#fafaf8;border:1px solid #b89a5a44;display:flex;align-items:center;justify-content:center;color:#b89a5a;font-size:11px;letter-spacing:2px;font-family:serif;">PREMIUM</div>
        <h3>Premium</h3><p>Elegante, oro, lujo</p>
      </div>
      <div class="option-card" onclick="selectOption('style','energetic',this)">
        <div class="style-preview" style="background:linear-gradient(135deg,#ff4500,#ffd700);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:900;letter-spacing:2px;">ENERGÉTICO</div>
        <h3>Energético</h3><p>Alta conversión, urgencia</p>
      </div>
      <div class="option-card" onclick="selectOption('style','corporate',this)">
        <div class="style-preview" style="background:linear-gradient(135deg,#1a237e,#1976d2);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;letter-spacing:2px;">CORPORATIVO</div>
        <h3>Corporativo</h3><p>Profesional, B2B</p>
      </div>
      <div class="option-card" onclick="selectOption('style','natural',this)">
        <div class="style-preview" style="background:linear-gradient(135deg,#1b4332,#2d6a4f);display:flex;align-items:center;justify-content:center;color:#fefae0;font-size:11px;letter-spacing:2px;">NATURAL</div>
        <h3>Natural</h3><p>Salud, bienestar</p>
      </div>
      <div class="option-card" onclick="selectOption('style','bold',this)">
        <div class="style-preview" style="background:linear-gradient(135deg,#1a0533,#2d0a5e);display:flex;align-items:center;justify-content:center;color:#e040fb;font-size:11px;letter-spacing:2px;">BOLD</div>
        <h3>Bold</h3><p>Impacto, creatividad</p>
      </div>
      <div class="option-card" onclick="selectOption('style','auto',this)" style="grid-column:1/-1">
        <div class="icon">🤖</div><h3>Auto — Jarvis elige</h3><p>Jarvis selecciona el estilo más adecuado para tu nicho</p>
      </div>
    </div>
    <div class="nav">
      <button class="btn btn-secondary" onclick="goStep(3)">← Atrás</button>
      <button class="btn btn-primary" onclick="generate()" id="btn-generate" disabled style="flex:1">🚀 Generar Landing</button>
    </div>
  </div>

  <!-- Loading -->
  <div class="step" id="step-loading">
    <div class="loading">
      <div class="spinner"></div>
      <h2>Jarvis está creando tu landing...</h2>
      <p style="color:rgba(255,255,255,0.5);margin-top:8px;">Esto toma entre 20 y 40 segundos</p>
    </div>
  </div>

  <!-- Result -->
  <div class="step" id="step-result">
    <div class="result-box">
      <div style="font-size:3rem;margin-bottom:16px;">🎉</div>
      <h2>¡Tu landing está lista!</h2>
      <div class="result-url" id="result-url"></div>
      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
        <a id="btn-open" href="#" target="_blank" class="btn btn-primary" style="text-decoration:none">Abrir landing →</a>
        <button class="btn btn-secondary" onclick="location.reload()">Crear otra</button>
      </div>
    </div>
  </div>
</div>

<script>
const data = {};

function selectOption(key, value, el) {
  data[key] = value;
  const siblings = el.parentElement.querySelectorAll('.option-card');
  siblings.forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');

  if (key === 'product_type') document.getElementById('btn-step1').disabled = false;
  if (key === 'style') document.getElementById('btn-generate').disabled = false;
}

function goStep(n) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById('step-' + n).classList.add('active');
}

async function generate() {
  data.name         = document.getElementById('name').value.trim();
  data.description  = document.getElementById('description').value.trim();
  data.audience     = document.getElementById('audience').value.trim();
  data.checkout_url = document.getElementById('checkout_url').value.trim();
  data.video_url    = document.getElementById('video_url').value.trim() || undefined;
  data.pixel_id     = document.getElementById('pixel_id').value.trim() || undefined;
  data.ga_id        = document.getElementById('ga_id').value.trim() || undefined;

  if (!data.name || !data.checkout_url) {
    alert('Nombre y URL de pago son requeridos.');
    goStep(2);
    return;
  }

  goStep('loading');

  const body = {
    action:          'create_landing',
    prompt:          data.product_type + ': ' + data.name + '. ' + (data.description || '') + ' — Dirigido a: ' + (data.audience || ''),
    style:           data.style || 'auto',
    checkout_url:    data.checkout_url,
    video_url:       data.video_url,
    pixel_id:        data.pixel_id,
    ga_id:           data.ga_id,
    countdown_hours: 48,
  };

  try {
    const res  = await fetch('/api/landing-generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();

    if (json.url) {
      document.getElementById('result-url').textContent = json.url;
      document.getElementById('btn-open').href = json.url;
      goStep('result');
    } else {
      alert('Error: ' + (json.error || 'No se pudo generar la landing'));
      goStep(4);
    }
  } catch (err) {
    alert('Error de conexión. Intenta de nuevo.');
    goStep(4);
  }
}
</script>
</body>
</html>
```

- [ ] **Step 2: Agregar endpoint `/api/landing-generate` y servir el wizard en `src/routes/landings.route.ts`**

Agrega al inicio del archivo (con los imports):

```typescript
import { landingBuilderTool } from "../tools/landing_builder.js";
import { Request as ExpressRequest, Response as ExpressResponse } from "express";
```

Agrega estas rutas al router (antes del `export default router`):

```typescript
// ─── GET /landing-wizard — Formulario web ────────────────────────────────────
router.get("/wizard", (_req: Request, res: Response) => {
  const wizardPath = path.join(process.cwd(), "src", "public", "wizard", "index.html");
  res.sendFile(wizardPath);
});

// ─── POST /api/landing-generate — Generar desde wizard web ───────────────────
router.post("/api/landing-generate", async (req: Request, res: Response) => {
  try {
    const result = await landingBuilderTool.execute(req.body as Record<string, unknown>, "web");
    const urlMatch = result.match(/https?:\/\/[^\s\n]+/);
    const url = urlMatch ? urlMatch[0] : null;
    if (url) {
      res.json({ url });
    } else {
      res.status(500).json({ error: result });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

Ajusta el mount en `src/index.ts` — cambia `/l` por rutas separadas:

```typescript
// En src/index.ts, reemplaza:
// app.use("/l", landingsRouter);
// Por:
app.use("/l", landingsRouter);
app.use("/landing-wizard", landingsRouter);  // sirve /landing-wizard/wizard
app.use("/", landingsRouter);               // para /api/landing-generate y /api/landings
```

- [ ] **Step 3: Verificar el wizard web**

```bash
npm run dev
```

Abre `http://localhost:8080/landing-wizard/wizard` en el browser. Debes ver el formulario de 4 pasos con estilos visuales.

- [ ] **Step 4: Commit**

```bash
git add src/public/wizard/index.html src/routes/landings.route.ts src/index.ts
git commit -m "feat: add web wizard UI and /api/landing-generate endpoint"
```

---

## Task 8: Deploy al servidor GCP

**Files:** `.env` del servidor (no en repo)

- [ ] **Step 1: Push al repositorio**

```bash
git push origin main
```

- [ ] **Step 2: Conectar al servidor y hacer pull**

```bash
ssh usuario@IP_DEL_SERVIDOR
cd /opt/jarvis/jarvis-v2
git pull origin main
npm install
npm run build
```

- [ ] **Step 3: Agregar variables de entorno en el servidor**

```bash
# Edita el .env del servidor:
echo "PUBLIC_URL=https://TU_DOMINIO_O_IP" >> .env
echo "LANDINGS_DIR=/opt/jarvis/landings" >> .env
mkdir -p /opt/jarvis/landings
```

Sustituye `TU_DOMINIO_O_IP` con la IP pública del servidor GCP o el dominio si tienes uno.

- [ ] **Step 4: Reiniciar con PM2**

```bash
export $(grep -v '^#' /opt/jarvis/jarvis-v2/.env | xargs) && pm2 restart jarvis-v2 --update-env
pm2 logs jarvis-v2 --lines 30
```

Esperado: logs sin errores, `✅ Servidor Express online`.

- [ ] **Step 5: Prueba en producción**

```bash
curl https://TU_DOMINIO_O_IP/api/landings
```

Esperado: `[]`

Envía un mensaje a Jarvis por Telegram: "Crea una landing para mi curso de marketing digital, precio $197, https://pay.hotmart.com/TEST"

Esperado: Jarvis responde con la URL de la landing en producción.

---

## Self-Review

**Spec coverage:**
- ✅ Tool `landing_builder` con `create_landing`, `list_landings`, `delete_landing`, `get_landing` → Task 3
- ✅ Tabla SQLite `landings` → Task 1
- ✅ LANDING_EXPERT_PROMPT + 6 estilos → Task 2
- ✅ Express `/l/:slug` + counter de vistas → Task 4
- ✅ `/api/landings` GET/DELETE → Task 4
- ✅ Registro en `tools/index.ts` → Task 4
- ✅ Wizard conversacional WhatsApp → Task 6
- ✅ Wizard conversacional Telegram → Task 6
- ✅ Formulario web con selector visual → Task 7
- ✅ `/api/landing-generate` endpoint → Task 7
- ✅ Variables `PUBLIC_URL` y `LANDINGS_DIR` → Task 8
- ✅ Deploy GCP → Task 8
- ✅ Prueba end-to-end → Task 5

**Placeholders:** ninguno — todos los pasos tienen código real.

**Type consistency:** `WizardState`, `LandingStyle`, `landingBuilderTool.execute()` — consistentes en Tasks 2, 3, 6.
