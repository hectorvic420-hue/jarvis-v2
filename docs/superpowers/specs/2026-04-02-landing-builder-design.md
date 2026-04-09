# Landing Builder — Diseño Técnico
**Fecha:** 2026-04-02  
**Proyecto:** Jarvis V2 — David Academy  

---

## Resumen

Jarvis puede crear landing pages profesionales completas a partir de un prompt o idea simple. Las landings se publican automáticamente en el servidor GCP y son accesibles por URL pública. Hay 3 canales de entrada: WhatsApp/Telegram, formulario web (wizard), y API directa.

---

## Arquitectura

```
Canal de entrada
  WhatsApp / Telegram  ──┐
  Formulario web (wizard) ──┼──→  landing_builder tool  →  Claude (LANDING_EXPERT_PROMPT)  →  HTML  →  GCP /l/[slug]
  API directa          ──┘
```

El núcleo es la `landing_builder` tool. Los 3 canales la invocan con los mismos parámetros.

---

## Archivos nuevos

| Archivo | Rol |
|---------|-----|
| `src/tools/landing_builder.ts` | Tool principal registrada en Jarvis |
| `src/tools/landing_prompts.ts` | LANDING_EXPERT_PROMPT + definición de estilos |
| `src/bot/landing_wizard.ts` | Flujo conversacional WA/TG (estado por usuario) |
| `src/routes/landings.route.ts` | Express sirve `/l/[slug]` y `/landing-wizard` |
| `src/public/wizard/` | Frontend del wizard web (HTML/CSS/JS estático) |

## Archivos modificados

| Archivo | Cambio |
|---------|--------|
| `src/tools/index.ts` | Registrar `landingBuilderTool` |
| `src/index.ts` | Montar `landingsRouter` en Express |
| `src/bot/whatsapp.route.ts` | Integrar `landing_wizard` en el flujo de mensajes |
| `src/bot/telegram.ts` | Integrar `landing_wizard` en el flujo de mensajes |

---

## Fase 1 — Núcleo: landing_builder tool

### Parámetros

```typescript
{
  action: "create_landing" | "list_landings" | "delete_landing" | "get_landing"
  prompt: string              // descripción libre del curso/producto
  style?: "futuristic" | "premium" | "energetic" | "corporate" | "natural" | "bold" | "auto"
  checkout_url?: string       // cualquier URL de pago (Hotmart, Stripe, MercadoPago, etc.)
  pixel_id?: string           // Meta Pixel ID
  ga_id?: string              // Google Analytics G-XXXXX
  countdown_hours?: number    // urgencia: horas para el timer
  video_url?: string          // YouTube o Vimeo embed
  slug?: string               // URL personalizada (auto-generada si no se provee)
}
```

### Flujo interno de `create_landing`

1. Parsear `prompt` con Claude para extraer: título, subtítulo, audiencia, beneficios, módulos, testimonios ficticios, precio, garantía, FAQ
2. Si `style === "auto"`, elegir el estilo según el nicho detectado (tech→futuristic, coaching→premium, infoproducto→energetic, etc.)
3. Llamar a Claude con `LANDING_EXPERT_PROMPT` + todos los datos estructurados
4. Claude devuelve HTML completo (un solo archivo autocontenido)
5. Generar `slug` único (ej: `curso-marketing-digital-a3f2`)
6. Guardar en `/opt/jarvis/landings/[slug].html`
7. Guardar metadata en SQLite (`landings` table): slug, title, style, checkout_url, created_at, views
8. Retornar URL pública: `https://[HOST]/l/[slug]`

### Secciones que Claude siempre genera

- **Hero**: headline impactante + subheadline + CTA principal
- **Video embed**: YouTube/Vimeo si se provee URL, placeholder elegante si no
- **Beneficios**: 6 beneficios con iconos SVG
- **Para quién es**: perfil del estudiante ideal (3 puntos)
- **Módulos/Temario**: lista de módulos con descripción
- **Sobre el autor**: bio de David + credenciales
- **Testimonios**: 3 testimonios con foto, nombre, resultado
- **FAQ**: 5 preguntas frecuentes con accordion JS
- **Garantía**: badge de garantía de satisfacción
- **Countdown timer**: JS vanilla, cuenta regresiva configurable
- **CTA múltiples**: botón de pago en hero, medio y final de página
- **Pixel de Meta**: snippet en `<head>` si se provee `pixel_id`
- **Google Analytics**: snippet GA4 si se provee `ga_id`
- **Footer**: copyright + aviso legal básico

### Estilos

| ID | Nombre | Paleta | Tipografía | Ideal para |
|----|--------|--------|------------|------------|
| `futuristic` | Futurista | Negro + cyan #00d4ff + púrpura #7b2ff7 | Inter/monospace | Tech, IA, crypto, marketing digital |
| `premium` | Premium | Blanco #fafaf8 + oro #b89a5a + negro | Playfair Display + Inter | Coaching, consultoría, alto valor |
| `energetic` | Energético | Naranja #ff4500 → amarillo #ffd700 | Montserrat Black | Infoproductos, webinars, lanzamientos |
| `corporate` | Corporativo | Azul marino #1a237e + blanco | Roboto | B2B, finanzas, formación empresarial |
| `natural` | Natural | Verde #2d6a4f + crema | Lato + Georgia | Salud, bienestar, coaching de vida |
| `bold` | Bold | Morado oscuro #1a0533 + magenta #e040fb | Bebas Neue + Inter | Entretenimiento, creativos, música |

### LANDING_EXPERT_PROMPT (resumen)

Sistema: Claude actúa como un experto en diseño de landing pages de alta conversión con 10 años de experiencia. Conoce los principios de AIDA, copywriting de respuesta directa, psicología de compra y diseño UI moderno. Genera HTML/CSS/JS completo en un solo archivo. El código debe ser:
- Responsive (mobile-first)
- Sin dependencias externas (todo inline o CDN confiable para fuentes)
- Con animaciones suaves (CSS transitions, no pesadas)
- SEO básico (meta tags, og:tags)
- Velocidad optimizada

---

## Fase 2 — Flujo conversacional (WhatsApp / Telegram)

### Estado de wizard por usuario

```typescript
interface LandingWizardState {
  step: number          // 0-7
  data: Partial<LandingParams>
  channel: "whatsapp" | "telegram"
}
```

### Pasos del wizard

```
Paso 0: "¿Qué quieres vender? (curso, servicio, membresía, producto)"
Paso 1: "¿Cómo se llama? Dame el nombre y una descripción breve"
Paso 2: "¿A quién va dirigido? (ej: emprendedores que quieren escalar)"
Paso 3: "¿Cuál es el precio y la URL de pago?"
Paso 4: "¿Tienes un video de presentación? (YouTube/Vimeo) — escribe 'no' si no"
Paso 5: "¿Qué estilo visual quieres? [foto de referencia de los 6 estilos]"
Paso 6: "¿Tienes Pixel de Meta o Google Analytics? (opcional)"
Paso 7: "¡Perfecto! Generando tu landing... 🚀"
```

El wizard se activa cuando el usuario dice algo como:
- "crea una landing"
- "necesito una página de ventas"
- "hazme un funnel"
- "quiero una landing"

El wizard mantiene estado en memoria (Map<userId, LandingWizardState>). Si el usuario interrumpe con otro mensaje, el wizard pregunta "¿Seguimos con tu landing o prefieres otra cosa?"

---

## Fase 3 — Wizard web (formulario visual)

### Ruta

`GET /landing-wizard` → sirve `src/public/wizard/index.html`

### Pasos del wizard web

1. **Tipo de producto** — cards visuales: Curso / Servicio / Membresía / Producto físico
2. **Datos básicos** — nombre, descripción, precio, URL de pago
3. **Audiencia** — textarea libre
4. **Estilo visual** — 6 cards con preview real del estilo (como el visual companion)
5. **Extras** — video URL, Pixel ID, GA ID, countdown timer
6. **Generar** — POST a `/api/landings` → responde con URL pública

### Endpoint API

```
POST /api/landings
Body: LandingParams
Response: { url: string, slug: string }

GET /api/landings
Response: [{ slug, title, style, created_at, views, url }]

DELETE /api/landings/:slug
```

---

## Base de datos

Nueva tabla SQLite:

```sql
CREATE TABLE landings (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  style       TEXT NOT NULL,
  checkout_url TEXT,
  pixel_id    TEXT,
  ga_id       TEXT,
  html_path   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  views       INTEGER DEFAULT 0
);
```

---

## Servidor GCP

Las landings se guardan en `/opt/jarvis/landings/` (directorio nuevo).  
Express sirve `/l/:slug` → lee el HTML y lo devuelve.  
Un middleware incrementa `views` en SQLite por cada visita.

La variable de entorno `PUBLIC_URL` (ej: `https://tudominio.com`) se usa para construir las URLs públicas.

---

## Orden de implementación

1. `landing_prompts.ts` — prompt experto + estilos
2. `landing_builder.ts` — tool con `create_landing`, `list_landings`, `delete_landing`
3. SQLite table `landings`
4. `landings.route.ts` — `/l/:slug` + `/api/landings`
5. Registrar tool en `index.ts` + montar ruta en `index.ts`
6. `landing_wizard.ts` — flujo conversacional WA/TG
7. Integrar wizard en `whatsapp.route.ts` y `telegram.ts`
8. `src/public/wizard/` — formulario web (HTML/CSS/JS)

---

## Variables de entorno nuevas

```env
PUBLIC_URL=https://tudominio.com   # URL base del servidor GCP
LANDINGS_DIR=/opt/jarvis/landings  # Directorio donde se guardan los HTML
```
