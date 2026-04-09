import { Tool } from "../shared/types.js";
import { sanitizeWebContent } from "../shared/sanitize.js";

const TAVILY_API_URL = "https://api.tavily.com/search";
const FETCH_TIMEOUT = 30000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWeb(query: string): Promise<string> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return "❌ Error: TAVILY_API_KEY no configurada en el .env.";

    try {
        const response = await fetchWithTimeout(TAVILY_API_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                search_depth: "advanced",
                include_answer: true,
                max_results: 5,
            }),
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json() as any;
        const answer = data.answer ? `💡 Resumen: ${data.answer as string}\n\n` : "";
        const results = (data.results as any[] || [])
            .map((r, i) => `${i + 1}. [${r.title as string}](${r.url as string})\n   ${r.content as string}`)
            .join("\n\n");

        if (!results && !answer) return "❌ No se encontraron resultados.";
        return `${answer}🔍 *Resultados de búsqueda:*\n\n${results}`;
    } catch (err: any) {
        return `❌ Error en búsqueda web: ${err.message as string}`;
    }
}

async function extractContent(url: string): Promise<string> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return "❌ Error: TAVILY_API_KEY no configurada.";

    try {
        const response = await fetchWithTimeout("https://api.tavily.com/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: apiKey,
                urls: [url],
            }),
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json() as any;
        if (data.results && data.results.length > 0 && data.results[0].raw_content) {
            const rawContent = (data.results[0].raw_content as string).slice(0, 5000);
            return `📄 *Contenido extraído de ${url}:*\n\n${sanitizeWebContent(rawContent)}`;
        }
        return "❌ No se pudo extraer contenido de la URL.";
    } catch (err: any) {
        return `❌ Error al extraer contenido: ${err.message as string}`;
    }
}

export const webResearcherTool: Tool = {
    name: "web_researcher",
    description: 
        "Usa esta herramienta para BUSCAR información técnica en Google/Bing (ej: documentación de n8n, soluciones a errores) " +
        "o para EXTRAER el contenido de texto de una URL específica para aprender a resolver dudas del usuario.",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["search", "extract"] },
            query:  { type: "string", description: "Término de búsqueda" },
            url:    { type: "string", description: "URL de la que extraer información" },
        },
        required: ["action"],
    },
    async execute(params, _chatId) {
        const { action, query, url } = params as Record<string, any>;

        if (action === "search") {
            if (!query) return "❌ Falta parámetro: query";
            return searchWeb(query as string);
        } else if (action === "extract") {
            if (!url) return "❌ Falta parámetro: url";
            return extractContent(url as string);
        }
        return "❌ Acción desconocida.";
    },
};
