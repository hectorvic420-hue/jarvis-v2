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
