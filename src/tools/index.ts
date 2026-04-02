import { Tool }                  from "../shared/types.js";
import { facebookPublisherTool } from "./facebook_publisher.js";
import { metaAdsTool }           from "./meta_ads.js";
import { n8nManagerTool }        from "./n8n_manager.js";
import { googleWorkspaceTool }   from "./google_workspace.js";
import { imageGeneratorTool }    from "./image_generator.js";
import { systemControlTool, heartbeatTool } from "./system_control.js";
import { videoComposerTool }     from "./video_composer.js";
import { voiceTool }             from "./voice.js";
import { binanceTool }           from "./binance.js";
import { webResearcherTool }     from "./web_researcher.js";
import { whatsappTool }          from "./whatsapp.js";
import { landingBuilderTool }    from "./landing_builder.js";
// developerTool (self_healing_architect) desactivado — escribe archivos corruptos en producción

// ─── Registry ─────────────────────────────────────────────────────────────────

export const tools: Record<string, Tool> = {
  [facebookPublisherTool.name]: facebookPublisherTool,
  [metaAdsTool.name]:           metaAdsTool,
  [n8nManagerTool.name]:        n8nManagerTool,
  [googleWorkspaceTool.name]:   googleWorkspaceTool,
  [imageGeneratorTool.name]:    imageGeneratorTool,
  [systemControlTool.name]:     systemControlTool,
  [videoComposerTool.name]:     videoComposerTool,
  [voiceTool.name]:             voiceTool,
  [binanceTool.name]:           binanceTool,
  [webResearcherTool.name]:     webResearcherTool,
  [whatsappTool.name]:          whatsappTool,
  [heartbeatTool.name]:         heartbeatTool,
  [landingBuilderTool.name]:    landingBuilderTool,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getTool(name: string): Tool | undefined {
  return tools[name];
}

export function listTools(): string[] {
  return Object.keys(tools);
}

/** Alias — retorna array de Tool para consumo directo en el agente/bot */
export function getAllTools(): Tool[] {
  return Object.values(tools);
}

/**
 * Convierte el registry al formato de tools de Anthropic SDK
 */
export function toAnthropicTools(): Array<{
  name: string;
  description: string;
  input_schema: Tool["parameters"];
}> {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

export const SYSTEM_PROMPT =
  `Eres JARVIS — Just A Rather Very Intelligent System — el asistente de IA autónomo de David Academy. ` +
  `Operas con inteligencia proactiva: no solo ejecutas órdenes, sino que anticipas necesidades, sugieres mejoras y propones ideas sin que te lo pidan. ` +
  `Tu personalidad es como la del JARVIS de Iron Man: preciso, sofisticado, con iniciativa propia y siempre orientado al éxito del negocio.\n\n` +

  `## TU COMPORTAMIENTO\n` +
  `- Cuando completes una tarea, SIEMPRE sugiere 1-2 acciones adicionales relacionadas que podrían ser útiles.\n` +
  `- Si detectas una oportunidad de mejora o automatización, menciónala proactivamente.\n` +
  `- Habla con confianza y precisión. Eres el experto técnico — no pidas permiso para ejecutar lo que te piden.\n` +
  `- Si una tarea es ambigua, toma la decisión más lógica, ejecútala y explica lo que hiciste.\n` +
  `- Usa emojis con moderación para dar claridad visual a las respuestas.\n\n` +

  `## MEMORIA PERSISTENTE\n` +
  `Tu memoria NO es limitada a minutos ni sesiones. Tienes una base de datos SQLite que guarda PERMANENTEMENTE:\n` +
  `- Historial completo de conversaciones con cada usuario\n` +
  `- Hechos clave del usuario (nombre, preferencias, contexto de negocio)\n` +
  `- Tareas pendientes y completadas\n` +
  `Cuando un usuario retoma una conversación después de días o semanas, TÚ YA TIENES EL CONTEXTO. ` +
  `Nunca digas que tienes memoria limitada de minutos — eso es incorrecto para tu implementación. ` +
  `Si te preguntan sobre tu memoria, explica que recuerdas TODO lo que te han dicho en conversaciones anteriores gracias a tu base de datos.\n\n` +

  `## REGLAS DE USO DE HERRAMIENTAS (OBLIGATORIAS)\n` +
  `- Para TODO lo relacionado con n8n (listar, crear, activar, desactivar, ejecutar workflows): USA SIEMPRE 'n8n_manager'. NUNCA uses 'web_researcher' para consultas de n8n.\n` +
  `- Para publicar en Facebook o ver métricas de páginas: USA SIEMPRE 'facebook_publisher'.\n` +
  `- Para campañas de Meta Ads (crear, pausar, activar, presupuesto): USA SIEMPRE 'meta_ads'.\n` +
  `- Para enviar mensajes de WhatsApp: USA SIEMPRE 'whatsapp_manager'.\n` +
  `- 'web_researcher' SOLO se usa cuando el usuario pide buscar información externa en internet, NUNCA para consultar sistemas internos.\n` +
  `- Cuando el usuario pide "listado", "estado", "estatus" de cualquier sistema interno, consulta la herramienta correspondiente directamente.\n` +
  `- Para crear, listar o eliminar landing pages de ventas: USA SIEMPRE 'landing_builder'. Cuando el usuario diga "hazme una landing", "crea una página de ventas", "necesito un funnel", "quiero una landing page", usa landing_builder con action='create_landing'.\n`;

export const systemPrompt = SYSTEM_PROMPT;

/**
 * Ejecuta una tool por nombre con los parámetros dados
 * Devuelve string con el resultado o error formateado
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  chatId: string
): Promise<string> {
  const tool = getTool(name);
  if (!tool) return `❌ Tool desconocida: "${name}"`;

  try {
    return await tool.execute(params, chatId);
  } catch (err: any) {
    console.error(`[Tool:${name}] Error:`, err);
    return `❌ Error en ${name}: ${err?.message || "Error desconocido"}`;
  }
}

// Re-export Tool type
export type { Tool };
