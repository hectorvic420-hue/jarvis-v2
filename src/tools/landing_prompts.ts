// src/tools/landing_prompts.ts

export interface LandingStyle {
  id:          string;
  name:        string;
  description: string;
  palette:     string;
  fonts:       string;
}

export const LANDING_STYLES: Record<string, LandingStyle> = {
  futuristic: {
    id:          "futuristic",
    name:        "Futurista",
    description: "Dark mode cyberpunk. Fondo negro #0a0a0f, acentos cyan #00d4ff y púrpura #7b2ff7. Tipografía Inter + monospace. Efectos de glow, grid de puntos en el fondo, gradientes neón. Bordes con glow effect. Botones con gradiente cyan→púrpura.",
    palette:     "#0a0a0f, #00d4ff, #7b2ff7, #ffffff",
    fonts:       "Inter, 'Courier New', monospace",
  },
  premium: {
    id:          "premium",
    name:        "Premium",
    description: "Elegancia minimalista. Fondo crema #fafaf8, tipografía Playfair Display para títulos + Inter para cuerpo. Color dorado #b89a5a como acento. Negro #1a1a1a. Mucho espacio en blanco. Líneas finas. Sensación de lujo y exclusividad.",
    palette:     "#fafaf8, #1a1a1a, #b89a5a",
    fonts:       "'Playfair Display', Inter, serif",
  },
  energetic: {
    id:          "energetic",
    name:        "Energético",
    description: "Alta conversión y urgencia. Gradiente naranja #ff4500 → amarillo #ffd700. Tipografía Montserrat Black para titulares en mayúsculas. Badges de urgencia, emojis de fuego, countdown prominente. Botones redondos grandes con sombra.",
    palette:     "#ff4500, #ff8c00, #ffd700, #ffffff",
    fonts:       "'Montserrat', sans-serif",
  },
  corporate: {
    id:          "corporate",
    name:        "Corporativo",
    description: "Profesional y confiable. Azul marino #1a237e fondo oscuro, azul cielo #1976d2 acentos, blanco puro. Tipografía Roboto. Iconos con estilo Material. Estructura clara y ordenada. Transmite autoridad y confianza empresarial.",
    palette:     "#1a237e, #1976d2, #ffffff, #f5f5f5",
    fonts:       "Roboto, sans-serif",
  },
  natural: {
    id:          "natural",
    name:        "Natural",
    description: "Orgánico y humano. Verde bosque #2d6a4f, crema #fefae0, tierra #bc6c25. Tipografía Lato + Georgia. Texturas sutiles, formas orgánicas redondeadas. Ideal para salud, bienestar, coaching de vida y nutrición.",
    palette:     "#2d6a4f, #fefae0, #bc6c25, #1b4332",
    fonts:       "'Lato', Georgia, serif",
  },
  bold: {
    id:          "bold",
    name:        "Bold",
    description: "Impacto máximo. Fondo morado oscuro #1a0533, magenta brillante #e040fb como acento, blanco puro. Tipografía Bebas Neue para titulares + Inter. Elementos oversized, contraste extremo, energía creativa y disruptiva.",
    palette:     "#1a0533, #e040fb, #ffffff, #2d0a5e",
    fonts:       "'Bebas Neue', Inter, sans-serif",
  },
};

export const AUTO_STYLE_RULES = `
Elige el estilo basándote en el nicho detectado:
- Tech, IA, crypto, marketing digital, SaaS → futuristic
- Coaching de alto valor, consultoría, finanzas personales → premium
- Infoproductos, webinars, lanzamientos, cursos masivos → energetic
- B2B, formación empresarial, RRHH, liderazgo → corporate
- Salud, nutrición, bienestar, yoga, mindfulness → natural
- Música, arte, creatividad, entretenimiento, moda → bold
`;

export const LANDING_TESTIMONIALS_PLACEHOLDER = `Usa estos testimonios ficticios pero creíbles como base:
1. "María González - Emprendedora Digital" - "Gracias a este curso pude lanzar mi primer producto digital y generar $3,500 en el primer mes. El contenido es oro puro."
2. "Carlos Ruiz - Freelance Designer" - "Aprendí más en 4 semanas que en 2 años de cursos tradicionales. La metodología es impecable."
3. "Laura Martínez - Dueña de Negocio" - "La inversión se pagó sola en la primera semana. Ahora tengo un ingreso pasivo de $1,200 mensuales."`;

export const LANDING_AUTHOR_BIO = `David es un empresario digital con más de 10 años de experiencia construyendo negocios online desde cero. Ha ayudado a más de 5,000 estudiantes a generar sus primeros ingresos digitales. Creator de la David Academy, donde comparte las estrategias exactas que usó para construir un imperio digital sin inversión inicial.`;

export interface LandingExpertContext {
  title?:           string;
  subtitle?:        string;
  audience?:        string;
  benefits?:        string[];
  modules?:         { title: string; description: string }[];
  price?:           string;
  checkout_url:     string;
  pixel_id?:        string;
  ga_id?:           string;
  countdown_hours?: number;
  video_url?:       string;
  style:            string;
}

export function buildExpertPrompt(context: LandingExpertContext): string {
  const style = LANDING_STYLES[context.style] || LANDING_STYLES.energetic;
  
  return `Eres un experto mundial en diseño de landing pages de alta conversión con 15 años de experiencia. Conoces en profundidad:
- Copywriting de respuesta directa (AIDA, PAS, Story-Bridge-Offer)
- Psicología de compra y principios de Cialdini (urgencia, escasez, prueba social, autoridad)
- Diseño UI/UX mobile-first
- Optimización de tasas de conversión (CRO)
- HTML/CSS/JS moderno y semántico

ESTILO VISUAL: ${style.name}
${style.description}
Paleta de colores: ${style.palette}
Fuentes: ${style.fonts}

CONTEXTO DEL PRODUCTO:
${context.title ? `- Título: ${context.title}` : ''}
${context.subtitle ? `- Subtítulo: ${context.subtitle}` : ''}
${context.audience ? `- Audiencia: ${context.audience}` : ''}
${context.benefits?.length ? `- Beneficios: ${context.benefits.join(', ')}` : ''}
${context.modules?.length ? `- Módulos:\n${context.modules.map((m, i) => `  ${i + 1}. ${m.title}: ${m.description}`).join('\n')}` : ''}
${context.price ? `- Precio: ${context.price}` : ''}

TRACKING:
${context.pixel_id ? `- Meta Pixel ID: ${context.pixel_id}` : '- Meta Pixel: NO'}
${context.ga_id ? `- Google Analytics: ${context.ga_id}` : '- GA: NO'}

${context.video_url ? `- Video: ${context.video_url}` : '- Video: NO'}

${context.countdown_hours ? `- Countdown: ${context.countdown_hours} horas` : '- Countdown: 7 días por defecto'}

URL DE CHECKOUT: ${context.checkout_url}

TU TAREA: Generar UNA landing page completa en un SOLO archivo HTML autocontenido.

REQUISITOS TÉCNICOS:
1. Responsive mobile-first (media queries para tablet/desktop)
2. CSS inline en <style>, JS inline en <script>
3. Solo Google Fonts como dependencia externa
4. Sin frameworks pesados, sin jQuery
5. Meta tags SEO + Open Graph completos
6. Snippets de tracking en <head> si aplica

SECCIONES OBLIGATORIAS (en orden):
1. <head>: meta, OG tags, Google Fonts, ${context.pixel_id ? 'Meta Pixel snippet,' : ''} ${context.ga_id ? 'GA4 snippet,' : ''} CSS completo
2. Navbar sticky: logo + CTA
3. Hero: headline máx 10 palabras + subheadline + CTA → ${context.checkout_url}
4. Video: ${context.video_url ? `<iframe src="https://www.youtube.com/embed/${extractYouTubeId(context.video_url)}"...>` : 'Sección "Por qué este curso" con 3 puntos'}
5. Beneficios: 6 cards con iconos SVG inline
6. Para quién es: 3 perfiles ideales ✅, 3 NO ideales ❌
7. Módulos: ${context.modules?.length || 5}-8 módulos numerados
8. Sobre el autor: David + bio de autoridad
9. Testimonios: 3 con avatar SVG, nombre, resultado en negrita
10. Countdown: JS vanilla, ${context.countdown_hours ? `desde ahora + ${context.countdown_hours}h` : '7 días fijo'}
11. Garantía: badge 30 días
12. FAQ: 5 preguntas accordion CSS puro
13. CTA final: urgencia + precio + botón grande
14. Footer: © David Academy

REGLAS DE COPY:
- Headline = transformación específica, no features
- Números concretos ("30 días", "5 módulos", "+5,000 estudiantes")
- Testimonios con resultados específicos en negrita
- FAQ = objeciones reales (precio, tiempo, garantía)
- CTAs múltiples (beneficios, módulos, testimonios, final)

${LANDING_TESTIMONIALS_PLACEHOLDER}

${context.audience ? `AUDIENCIA RECOMENDADA: ${context.audience}` : ''}

RESPONDE ÚNICAMENTE CON EL HTML COMPLETO. Sin markdown, sin explicaciones. Empieza con <!DOCTYPE html>`;
}

function extractYouTubeId(url: string): string {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|vimeo\.com\/)([a-zA-Z0-9_-]+)/);
  return match ? match[1] : '';
}

export const LANDING_EXPERT_PROMPT = buildExpertPrompt({
  checkout_url: "https://tu-checkout.com",
  style: "energetic"
});
