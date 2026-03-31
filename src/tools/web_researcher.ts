import { Tool } from "../shared/types.js";
import axios from "axios";

const TAVILY_API_URL = "https://api.tavily.com/search";

async function searchWeb(query: string): Promise<string> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return "❌ Error: TAVILY_API_KEY no configurada en el .env.";

    try {
        const response = await axios.post(TAVILY_API_URL, {
            api_key: apiKey,
            query,
            search_depth: "advanced",
            include_answer: true,
            max_results: 5,
        });

        const data   = response.data;
        const answer = data.answer ? `💡 Resumen: ${data.answer as string}\n\n` : "";
        const results = (data.results as any[])
            .map((r, i) => `${i + 1}. [${r.title as string}](${r.url as string})\n   ${r.content as string}`)
            .join("\n\n");

        return `${answer}🔍 *Resultados de búsqueda:*\n\n${results}`;
    } catch (err: any) {
        return `❌ Error en búsqueda web: ${err.message as string}`;
    }
}

async function extractContent(url: string): Promise<string> {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return "❌ Error: TAVILY_API_KEY no configurada.";

    try {
        const response = await axios.post("https://api.tavily.com/extract", {
            api_key: apiKey,
            urls: [url],
        });

        const data = response.data;
        if (data.results && data.results.length > 0) {
            return `📄 *Contenido extraído de ${url}:*\n\n${data.results[0].raw_content.slice(0, 5000) as string}`;
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
