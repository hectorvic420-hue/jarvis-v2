import { Tool }                  from "../shared/types.js";
import { facebookPublisherTool } from "./facebook_publisher.js";
import { metaAdsTool }           from "./meta_ads.js";
import { n8nManagerTool }        from "./n8n_manager.js";
import { googleWorkspaceTool }   from "./google_workspace.js";
import { imageGeneratorTool }    from "./image_generator.js";
import { systemControlTool }     from "./system_control.js";
import { videoComposerTool }     from "./video_composer.js";
import { voiceTool }             from "./voice.js";
import { binanceTool }           from "./binance.js";
import { webResearcherTool }     from "./web_researcher.js";
import { whatsappTool }          from "./whatsapp.js";

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
