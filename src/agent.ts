import { callLLM, LLMMessage, LLMTool, LLMResponse } from "./llm.js";
import { Tool } from "./shared/types.js";
import { memoryService } from "./memory/service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  tools:        Tool[];
  systemPrompt: string;
  userId:       string | number;
}

export interface AgentResult {
  response:   string;
  iterations: number;
  usedTools:  string[];
  provider:   string;
  warning?:   string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_ITERATIONS              = 30;
const TOOL_TIMEOUT_MS             = 90_000;
const MAX_TOOL_RESPONSE_CHARS     = 3_000;
const CONSECUTIVE_LOOP_THRESHOLD  = 3;
const ALTERNATING_LOOP_LENGTH     = 4;

// ─── needsToolUse ─────────────────────────────────────────────────────────────

const INFORMATIVE_PATTERNS: RegExp[] = [
  /^(cómo|como)\s+(se\s+)?(funciona|hacen?|puedo|debo|puede)/i,
  /^(qué|que)\s+(es|son|significan?|quiere\s+decir)/i,
  /^(explica|explícame|explícanos|cuéntame|describe|dime\s+qué\s+es)/i,
  /^(cuál|cual)\s+es\s+la\s+(diferencia|definición|historia|razón|causa)/i,
  /^(por\s+qué|porque|porqué)\s+/i,
  /^(quién|quien)\s+(es|fue|era|inventó|creó|fundó)/i,
  /^(cuándo|cuando)\s+(fue|es|ocurrió|pasó|nació)/i,
  /^(dónde|donde)\s+(está|queda|se\s+ubica|se\s+encuentra)\s+[a-z]/i,
];

export function needsToolUse(text: string): boolean {
  // Patrones informativos que indican que la tarea ya terminó
  const informativePatterns = [
    /el post ha sido publicado/i,
    /la publicación se realizó/i,
    /tarea completada/i,
    /listo, he terminado/i,
    /aquí tienes los resultados/i,
    /no hay más acciones/i,
    /mensaje enviado/i,
    /evento creado/i,
    /archivo guardado/i,
    /publicación exitosa/i,
  ];

  if (informativePatterns.some((p) => p.test(text))) {
    return false;
  }

  return text.includes("tool_use") || /\{.*"action":.*\}/.test(text) || text.includes("execute_tool");
}

// ─── Loop detection ───────────────────────────────────────────────────────────

function detectConsecutiveLoop(history: string[]): string | null {
  if (history.length < CONSECUTIVE_LOOP_THRESHOLD) return null;
  const tail = history.slice(-CONSECUTIVE_LOOP_THRESHOLD);
  if (tail.every((t) => t === tail[0])) return tail[0];
  return null;
}

function detectAlternatingLoop(history: string[]): boolean {
  if (history.length < ALTERNATING_LOOP_LENGTH) return false;
  const [a, b, c, d] = history.slice(-ALTERNATING_LOOP_LENGTH);
  return a === c && b === d && a !== b;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildActionReminder(toolNames: string[]): string {
  return (
    `\n\n[SISTEMA: Tienes las siguientes herramientas disponibles: ` +
    `${toolNames.join(", ")}. ` +
    `Úsalas cuando sea necesario para completar la tarea. ` +
    `No inventes datos — consulta las herramientas para información real.]`
  );
}

function truncateToolResponse(response: string): string {
  if (response.length <= MAX_TOOL_RESPONSE_CHARS) return response;
  return (
    response.slice(0, MAX_TOOL_RESPONSE_CHARS) +
    `\n...[respuesta truncada a ${MAX_TOOL_RESPONSE_CHARS} chars]`
  );
}

async function executeToolWithTimeout(
  tool:   Tool,
  args:   Record<string, unknown>,
  chatId: string
): Promise<string> {
  return Promise.race([
    tool.execute(args, chatId),
    new Promise<string>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`Timeout (${TOOL_TIMEOUT_MS}ms) en herramienta '${tool.name}'`)
          ),
        TOOL_TIMEOUT_MS
      )
    ),
  ]);
}

function buildLLMTools(tools: Tool[]): LLMTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name:        t.name,
      description: t.description,
      parameters:  t.parameters,
    },
  }));
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  options:     AgentOptions
): Promise<AgentResult> {
  const { tools, systemPrompt, userId } = options;

  // ── Memory & Context injection ───────────────────────────────────────────
  const ctx = memoryService.getContext(userId, 15);
  
  const factBlock = ctx.facts.length > 0
    ? `\n\n## HECHOS DEL USUARIO:\n${ctx.facts.map(f => `- ${f.key}: ${f.value}`).join("\n")}`
    : "";

  const timeBlock = `\n\n## CONTEXTO TEMPORAL:\n- Fecha y hora: ${new Date().toLocaleString("es-CO")}\n- Zona: America/Bogota`;

  const fullSystem = systemPrompt + factBlock + timeBlock;

  const toolNames = tools.map((t) => t.name);
  const llmTools  = buildLLMTools(tools);

  // ── Message assembly ───────────────────────────────────────────────────
  const messages: LLMMessage[] = [
    { role: "system", content: fullSystem },
  ];

  // Inyectar historial previo
  ctx.recent_messages.forEach(m => {
    messages.push({ role: m.role as "user" | "assistant" | "tool", content: m.content });
  });

  const shouldUseTool = tools.length > 0 && needsToolUse(userMessage);
  const userContent   = shouldUseTool
    ? userMessage + buildActionReminder(toolNames)
    : userMessage;

  // Agregar mensaje actual del usuario
  messages.push({ role: "user", content: userContent });

  // ── State ────────────────────────────────────────────────────────────────
  const usedTools:   string[] = [];
  const toolHistory: string[] = [];
  const toolMap       = new Map(tools.map((t) => [t.name, t]));
  let iterations   = 0;
  let lastProvider = "groq";
  let warning: string | undefined;
  let geminiWarned = false;

  // ── Agent loop ───────────────────────────────────────────────────────────
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[AGENT] Iteración ${iterations}/${MAX_ITERATIONS}`);

    const activeTools = shouldUseTool ? llmTools : undefined;
    let llmResponse: LLMResponse;

    try {
      llmResponse = await callLLM(messages, activeTools);
    } catch (err) {
      throw new Error(`LLM no disponible: ${(err as Error).message}`);
    }

    lastProvider = llmResponse.provider;

    if (llmResponse.provider === "gemini" && !geminiWarned) {
      geminiWarned = true;
      warning = "⚠️ *Fallback a Gemini* — herramientas no disponibles en esta respuesta.";
    }

    // ── Final answer ──────────────────────────────────────────────────────
    const hasCalls =
      llmResponse.tool_calls && llmResponse.tool_calls.length > 0;

    if (!hasCalls) {
      return {
        response:  llmResponse.content ?? "Sin respuesta del LLM.",
        iterations,
        usedTools: [...new Set(usedTools)],
        provider:  lastProvider,
        warning,
      };
    }

    // ── Append assistant turn ─────────────────────────────────────────────
    messages.push({
      role:       "assistant",
      content:    llmResponse.content,
      tool_calls: llmResponse.tool_calls,
    });

    // ── Execute each tool call ────────────────────────────────────────────
    for (const toolCall of llmResponse.tool_calls!) {
      const toolName = toolCall.function.name;
      toolHistory.push(toolName);
      usedTools.push(toolName);

      console.log(`[AGENT] Tool: ${toolName}`);

      // Loop: consecutive
      const consecutiveTool = detectConsecutiveLoop(toolHistory);
      if (consecutiveTool) {
        console.warn(`[AGENT] Bucle consecutivo: ${consecutiveTool}`);
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:
            `[SISTEMA: Bucle detectado — '${consecutiveTool}' llamada ` +
            `${CONSECUTIVE_LOOP_THRESHOLD} veces seguidas. Cambia de estrategia.]`,
        });
        continue;
      }

      // Loop: alternating
      if (detectAlternatingLoop(toolHistory)) {
        console.warn("[AGENT] Bucle alternado detectado (ABAB)");
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:
            "[SISTEMA: Bucle alternado (ABAB) detectado. " +
            "Responde directamente con la información disponible.]",
        });
        continue;
      }

      // Tool not found
      const tool = toolMap.get(toolName);
      if (!tool) {
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content: `[ERROR: Herramienta '${toolName}' no existe.]`,
        });
        continue;
      }

      // Parse args
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content: `[ERROR: JSON inválido en args de '${toolName}': ${toolCall.function.arguments}]`,
        });
        continue;
      }

      // Execute
      try {
        const raw       = await executeToolWithTimeout(tool, args, String(userId));
        const truncated = truncateToolResponse(raw);
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          name:         toolName,
          content:      truncated,
        });
      } catch (err) {
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content: `[ERROR en '${toolName}': ${(err as Error).message}]`,
        });
      }
    }
  }

  // ── Max iterations ────────────────────────────────────────────────────────
  console.error(`[AGENT] MAX_ITERATIONS (${MAX_ITERATIONS}) alcanzado`);
  return {
    response:
      "⚠️ Se alcanzó el límite de iteraciones sin completar la tarea. " +
      "Reformula tu solicitud con más detalle.",
    iterations,
    usedTools: [...new Set(usedTools)],
    provider:  lastProvider,
    warning:   "MAX_ITERATIONS alcanzado",
  };
}
