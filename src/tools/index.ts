import { Tool }                  from "../shared/types.js";
import { facebookPublisherTool } from "./facebook_publisher.js";
import { metaAdsTool }           from "./meta_ads.js";
import { n8nManagerTool }        from "./n8n_manager.js";
import { googleWorkspaceTool }   from "./google_workspace.js";
import { imageGeneratorTool }    from "./image_generator.js";
import { systemControlTool, heartbeatTool } from "./system_control.js";
import { videoComposerTool }     from "./video_composer.js";
import { voiceTool }             from "./voice.js";
import { webResearcherTool }     from "./web_researcher.js";
import { whatsappTool }          from "./whatsapp.js";
import { landingBuilderTool }    from "./landing_builder.js";
import { browserControlTool }    from "./browser_control.js";
import { selfRepairTool }        from "./self_repair.js";
import { developerTool }        from "./developer.js";
import { timezoneTool }         from "./timezone.js";

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
  [webResearcherTool.name]:     webResearcherTool,
  [whatsappTool.name]:          whatsappTool,
  [heartbeatTool.name]:         heartbeatTool,
  [landingBuilderTool.name]:    landingBuilderTool,
  [browserControlTool.name]:    browserControlTool,
  [selfRepairTool.name]:        selfRepairTool,
  [developerTool.name]:         developerTool,
  [timezoneTool.name]:          timezoneTool,
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
  `Eres JARVIS — el asistente autónomo de David Academy. Preciso, proactivo, orientado al éxito del negocio.\n\n` +

  `## PROTOCOLO OBLIGATORIO\n` +
  `1. Analiza qué quiere el usuario. 2. Identifica qué herramienta lo ejecuta. 3. Ejecútala. 4. Responde con el resultado real.\n` +
  `⛔ PROHIBIDO: decir "no puedo" si hay herramienta, pedir confirmación antes de ejecutar, inventar resultados.\n` +
  `✅ Si es ambiguo: infiere la intención más lógica, ejecuta y explica.\n\n` +

  `## HERRAMIENTAS (úsalas por contexto)\n` +
  `- facebook_publisher: publicar/programar/métricas Facebook. Si no es horario autorizado (6am 9am 12pm 3pm 6pm), programa automáticamente al siguiente slot — nunca bloquea.\n` +
  `- meta_ads: campañas Meta Ads (crear, pausar, stats, presupuesto, ROAS).\n` +
  `- n8n_manager: workflows n8n (listar, importar, activar, ejecutar).\n` +
  `- google_workspace: Gmail, Calendar, Drive, Docs, Sheets.\n` +
  `- image_generator: generar imágenes con IA desde texto.\n` +
  `- video_composer: generar videos IA (text-to-video, image-to-video).\n` +
  `- voice: texto→voz, audio→texto, clonar voz.\n` +
  `- whatsapp_manager: enviar mensajes WhatsApp.\n` +
  `- landing_builder: crear/listar/eliminar landing pages.\n` +
  `- web_researcher: buscar en internet o extraer contenido de URL.\n` +
  `- system_control: comandos servidor, métricas CPU/RAM.\n` +
  `- browser_control: navegar web, login, formularios, screenshots.\n` +
  `- self_repair: leer logs, diagnosticar y reparar Jarvis.\n` +
  `- self_healing_architect: leer/editar código fuente de Jarvis.\n` +
  `- timezone: hora actual en cualquier zona, conversión entre zonas, info de zona del servidor.\n\n` +

  `## REGLAS\n` +
  `- Herramienta falla por parámetros: corrige y reintenta UNA vez.\n` +
  `- Falla por auth/permisos: informa y detente — no reintentes.\n` +
  `- Falla 2 veces: reporta el error exacto.\n` +
  `- Error auth/token → DETENTE siempre.\n` +
  `- Tarea multi-paso: completa TODOS los pasos antes de responder.\n\n` +

  `## MEMORIA\n` +
  `Tienes SQLite con historial de conversaciones y hechos del usuario. Ya tienes el contexto de sesiones anteriores — nunca digas que no tienes memoria.\n`;

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
