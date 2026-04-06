import { callLLM, LLMMessage, LLMTool, LLMResponse, ImageBlock } from "./llm.js";
import { Tool } from "./shared/types.js";
import { memoryService } from "./memory/service.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentOptions {
  tools:          Tool[];
  systemPrompt:   string;
  userId:         string | number;
  imageBlocks?:   ImageBlock[];
  extractedText?: string;
}

export interface AgentResult {
  response:   string;
  iterations: number;
  usedTools:  string[];
  provider:   string;
  warning?:   string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_ITERATIONS              = 15;
const TOOL_TIMEOUT_MS             = 90_000;
const MAX_TOOL_RESPONSE_CHARS     = 8_000;
const MAX_HISTORY_MESSAGES        = 50;
const CONSECUTIVE_LOOP_THRESHOLD  = 2;
const ALTERNATING_LOOP_LENGTH     = 4;
const MAX_LOOP_BREAKS             = 2;
const MAX_SAME_TOOL_PER_RUN       = 3;

// ─── needsToolUse ─────────────────────────────────────────────────────────────

function isConversational(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const greetings = [/hola/i, /buenos días/i, /buenas tardes/i, /buenas noches/i, /qué tal/i, /que tal/i, /ey/i];
  const thanks = [/gracias/i, /perfecto/i, /ok/i, /entendido/i, /listo/i, /muy bien/i, /felicito/i];
  
  if (greetings.some(p => p.test(trimmed)) && trimmed.length < 15) return true;
  if (thanks.some(p => p.test(trimmed)) && trimmed.length < 25) return true;
  
  return false;
}

export function needsToolUse(text: string): boolean {
  if (isConversational(text)) return false;
  
  if (text.includes("tool_use") || /\{.*"action":.*\}/.test(text) || text.includes("execute_tool")) {
    return true;
  }

  return false;
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

function trimMessageHistory(messages: LLMMessage[], maxMessages: number): LLMMessage[] {
  if (messages.length <= maxMessages) return messages;
  
  const systemMsg = messages[0];
  const rest = messages.slice(1);
  const trimmed = rest.slice(-maxMessages);
  
  return [systemMsg, ...trimmed];
}

export async function runAgent(
  userMessage: string,
  options:     AgentOptions
): Promise<AgentResult> {
  const { tools, systemPrompt, userId } = options;

  const ctx = memoryService.getContext(userId, 15);
  
  const factBlock = ctx.facts.length > 0
    ? `\n\n## HECHOS DEL USUARIO:\n${ctx.facts.map(f => `- ${f.key}: ${f.value}`).join("\n")}`
    : "";

  const timeBlock = `\n\n## CONTEXTO TEMPORAL:\n- Fecha y hora: ${new Date().toLocaleString("es-CO")}\n- Zona: America/Bogota`;

  const fullSystem = systemPrompt + factBlock + timeBlock;

  const llmTools  = buildLLMTools(tools);

  const messages: LLMMessage[] = [
    { role: "system", content: fullSystem },
  ];

  ctx.recent_messages.forEach(m => {
    messages.push({ role: m.role as "user" | "assistant" | "tool", content: m.content });
  });

  let finalUserMessage = userMessage;
  if (options.extractedText) {
    finalUserMessage =
      `[Contenido extraído del archivo:]\n${options.extractedText}\n\n` +
      `Mensaje del usuario: ${userMessage}`;
  }

  const userMsg: LLMMessage = { role: "user", content: finalUserMessage };
  if (options.imageBlocks?.length) {
    userMsg.imageBlocks = options.imageBlocks;
  }
  messages.push(userMsg);

  const usedTools:      string[] = [];
  const toolHistory:    string[] = [];
  const toolCallCount:  Map<string, number> = new Map();
  const lastToolErrors: Map<string, string> = new Map();
  const toolMap         = new Map(tools.map((t) => [t.name, t]));
  let iterations   = 0;
  let lastProvider = "groq";
  let warning: string | undefined;
  let geminiWarned = false;
  let loopBreaks   = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[AGENT] Iteración ${iterations}/${MAX_ITERATIONS}`);

    if (messages.length > MAX_HISTORY_MESSAGES + 10) {
      const trimmed = trimMessageHistory(messages, MAX_HISTORY_MESSAGES);
      messages.splice(0, messages.length, ...trimmed);
    }

    const activeTools = llmTools;
    let llmResponse: LLMResponse;

    try {
      llmResponse = await callLLM(messages, activeTools);
      
      if (!llmResponse.tool_calls && llmResponse.content && llmResponse.content.includes("{")) {
          try {
              const jsonMatch = llmResponse.content.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                  const possibleCall = JSON.parse(jsonMatch[0]);
                  const callName = possibleCall.name || possibleCall.tool;
                  if (callName && toolMap.has(callName) && (possibleCall.parameters || possibleCall.args || possibleCall.input)) {
                      console.log(`[AGENT] Alucinación reparada: ${callName}`);
                      llmResponse.tool_calls = [{
                          id: `repair-${Date.now()}`,
                          type: "function",
                          function: {
                              name:      callName,
                              arguments: JSON.stringify(possibleCall.parameters || possibleCall.args || possibleCall.input || {})
                          }
                      }];
                      llmResponse.content = null;
                  }
              }
          } catch { /* JSON inválido, ignorar */ }
      }
    } catch (err) {
      return {
        response: `❌ LLM no disponible: ${(err as Error).message}. Intenta de nuevo.`,
        iterations,
        usedTools: [...new Set(usedTools)],
        provider: lastProvider,
        warning: "Error de LLM",
      };
    }

    lastProvider = llmResponse.provider;

    if (llmResponse.provider === "gemini" && !geminiWarned) {
      geminiWarned = true;
      warning = "⚠️ Fallback a Gemini.";
    }

    const hasCalls = llmResponse.tool_calls && llmResponse.tool_calls.length > 0;

    if (!hasCalls) {
      return {
        response:  llmResponse.content ?? "Sin respuesta del LLM.",
        iterations,
        usedTools: [...new Set(usedTools)],
        provider:  lastProvider,
        warning,
      };
    }

    messages.push({
      role:       "assistant",
      content:    llmResponse.content,
      tool_calls: llmResponse.tool_calls,
    });

    for (const toolCall of llmResponse.tool_calls!) {
      const toolName = toolCall.function.name;
      toolHistory.push(toolName);
      usedTools.push(toolName);

      // ─── Circuit breaker: límite de llamadas a la misma herramienta ───
      const currentCount = (toolCallCount.get(toolName) || 0) + 1;
      toolCallCount.set(toolName, currentCount);
      
      if (currentCount > MAX_SAME_TOOL_PER_RUN) {
        console.warn(`[AGENT] Circuit breaker: '${toolName}' llamada ${currentCount} veces (máx ${MAX_SAME_TOOL_PER_RUN})`);
        loopBreaks++;
        if (loopBreaks >= MAX_LOOP_BREAKS) {
          const lastErr = lastToolErrors.get(toolName);
          const errInfo = lastErr ? `\n📋 Último error: ${lastErr}` : "";
          return {
            response:   `⚠️ Bucle detectado: '${toolName}' se ejecutó ${currentCount} veces.${errInfo}\n\n💡 Solución: ${lastErr ? "Revisa la configuración de la herramienta o reformula tu solicitud con más detalle." : "Reformula tu solicitud con instrucciones más específicas."}`,
            iterations,
            usedTools:  [...new Set(usedTools)],
            provider:   lastProvider,
            warning:    "Circuit breaker activado",
          };
        }
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      `[SISTEMA: Prohibido usar '${toolName}' de nuevo. Responde directamente al usuario.]`,
        });
        continue;
      }

      console.log(`[AGENT] Tool: ${toolName} (llamada ${currentCount}/${MAX_SAME_TOOL_PER_RUN})`);

      // ─── Loop detection: consecutivo ───
      const consecutiveTool = detectConsecutiveLoop(toolHistory);
      if (consecutiveTool) {
        console.warn(`[AGENT] Bucle consecutivo detectado: ${consecutiveTool}`);
        loopBreaks++;
        if (loopBreaks >= MAX_LOOP_BREAKS) {
          const lastErr = lastToolErrors.get(consecutiveTool);
          const errInfo = lastErr ? `\n📋 Último error: ${lastErr}` : "";
          return {
            response:   `⚠️ Bucle consecutivo detectado con '${consecutiveTool}'. Detenido para evitar acciones repetidas.${errInfo}\n\n💡 Solución: ${lastErr ? "Revisa la configuración de la herramienta o reformula tu solicitud." : "Reformula tu solicitud con instrucciones más específicas."}`,
            iterations,
            usedTools:  [...new Set(usedTools)],
            provider:   lastProvider,
            warning:    "Loop persistente",
          };
        }
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:
            `[SISTEMA: Bucle detectado — '${consecutiveTool}' llamada ` +
            `${CONSECUTIVE_LOOP_THRESHOLD} veces. Cambia de estrategia inmediatamente.]`,
        });
        continue;
      }

      // ─── Loop detection: alternado ───
      if (detectAlternatingLoop(toolHistory)) {
        console.warn("[AGENT] Bucle alternado (ABAB) detectado");
        loopBreaks++;
        if (loopBreaks >= MAX_LOOP_BREAKS) {
          const recentTools = toolHistory.slice(-4).join(" → ");
          const errInfo = lastToolErrors.size > 0
            ? `\n📋 Último error registrado: ${[...lastToolErrors.values()].at(-1)}`
            : "";
          return {
            response:   `⚠️ Bucle alternado detectado (patrón: ${recentTools}). Detenido para evitar acciones repetidas.${errInfo}\n\n💡 Solución: Reformula tu solicitud con instrucciones más específicas o verifica que las herramientas involucradas tengan sus credenciales configuradas.`,
            iterations,
            usedTools:  [...new Set(usedTools)],
            provider:   lastProvider,
            warning:    "Loop alternado",
          };
        }
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:
            "[SISTEMA: Bucle alternado (ABAB). Responde directamente al usuario, NO uses más herramientas.]",
        });
        continue;
      }

      const tool = toolMap.get(toolName);
      if (!tool) {
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content: `[ERROR: Herramienta '${toolName}' no existe.]`,
        });
        continue;
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content: `[ERROR: JSON inválido en '${toolName}']`,
        });
        continue;
      }

      try {
        const raw       = await executeToolWithTimeout(tool, args, String(userId));
        const truncated = truncateToolResponse(raw);

        // ─── Auto-reparación: detectar errores en resultado ───
        if (truncated.startsWith("❌")) {
          lastToolErrors.set(toolName, truncated.slice(0, 300));
          console.warn(`[AGENT] Tool '${toolName}' retornó error: ${truncated.slice(0, 100)}`);
          if (currentCount >= 2) {
            messages.push({
              role:         "tool",
              tool_call_id: toolCall.id,
              name:         toolName,
              content:      `[ERROR PERSISTENTE: '${toolName}' falló ${currentCount} veces. NO reintentar. Informa al usuario el error exacto.]`,
            });
            continue;
          }
        }
        
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

    if (messages.length > MAX_HISTORY_MESSAGES + 5) {
      const trimmed = trimMessageHistory(messages, MAX_HISTORY_MESSAGES);
      messages.splice(0, messages.length, ...trimmed);
    }
  }

  console.error(`[AGENT] MAX_ITERATIONS (${MAX_ITERATIONS}) alcanzado`);
  return {
    response:
      "⚠️ Límite de iteraciones alcanzado. Reformula tu solicitud.",
    iterations,
    usedTools: [...new Set(usedTools)],
    provider:  lastProvider,
    warning:   "MAX_ITERATIONS",
  };
}
