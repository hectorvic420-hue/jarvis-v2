import { callLLM, LLMMessage, LLMTool, LLMResponse, ImageBlock, ToolCall } from "./llm.js";
import { Tool } from "./shared/types.js";
import { memoryService } from "./memory/service.js";
import { selfRepairTool } from "./tools/self_repair.js";
import db from "./memory/db.js";

// ─── Agent Run Logging ───────────────────────────────────────────────────────────

const insertRunStmt = db.prepare(`
  INSERT INTO agent_runs (trace_id, user_id, input_preview, iterations, tools_used, provider, status, warning, duration_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function logRun(
  traceId: string,
  startTime: number,
  userId: string | number,
  result: AgentResult,
  inputPreview: string = ""
): void {
  try {
    const durationMs = Date.now() - startTime;
    const ERROR_WARNINGS = ["Circuit breaker", "Bucle", "Error de LLM", "Error fatal"];
    const status = result.warning?.includes("MAX_ITERATIONS") ? "max_iterations"
      : ERROR_WARNINGS.some(e => result.warning?.includes(e)) ? "error"
      : result.warning ? "warning"
      : "success";
    
    insertRunStmt.run(
      traceId,
      String(userId),
      inputPreview,
      result.iterations,
      JSON.stringify(result.usedTools),
      result.provider,
      status,
      result.warning || null,
      durationMs
    );
  } catch (err) {
    console.warn("[AGENT] Failed to log run:", (err as Error).message);
  }
}

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

const MAX_ITERATIONS          = 12;
const TOOL_TIMEOUT_MS         = 90_000;
const MAX_TOOL_RESPONSE_CHARS = 8_000;
const MAX_HISTORY_MESSAGES    = 40;
const MAX_SAME_TOOL_PER_RUN   = 4;  // circuit breaker: max llamadas totales por tool
const MAX_CONSEC_SAME_ARGS    = 2;  // max llamadas consecutivas con mismos args
const MAX_LOOP_BREAKS         = 3;  // avisos antes de salir definitivamente

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Errores que NO tienen sentido reintentar: permisos, auth, token inválido.
 * El agente debe informar al usuario inmediatamente.
 */
function isFatalError(response: string): boolean {
  const FATAL_PATTERNS = [
    "(#200)", "(#10)", "(#100)",
    "OAuthException",
    "access_token", "Invalid token", "token expired",
    "401", "403", "Unauthorized", "Forbidden",
    "no configurado",
    "Falta configuración", "Falta credenciales", "Falta API_KEY", "Falta TOKEN",
  ];
  const lower = response.toLowerCase();
  return FATAL_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

/**
 * Fires self-repair in background if tool errors look like fixable code bugs.
 * Does NOT await — repair happens async, notifies via Telegram.
 */
function maybeAutoRepair(
  lastToolErrors: Map<string, string>,
  userId: string
): void {
  if (lastToolErrors.size === 0) return;

  const allErrors = [...lastToolErrors.values()].join(" ");
  if (isFatalError(allErrors)) return;

  const hasRuntimeError = [...lastToolErrors.values()].some(
    e => e.includes("TypeError") || e.includes("Error:") || e.includes("Cannot read") || e.includes("undefined")
  );
  if (!hasRuntimeError) return;

  console.log("[AGENT] Auto-triggering self_repair for user", userId);
  selfRepairTool.execute({ action: "repair" }, userId).catch(err => {
    console.error("[AGENT] Auto-repair failed:", err.message);
  });
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
        () => reject(new Error(`Timeout (${TOOL_TIMEOUT_MS}ms) en herramienta '${tool.name}'`)),
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

function trimMessageHistory(messages: LLMMessage[], maxMessages: number): LLMMessage[] {
  if (messages.length <= maxMessages) return messages;

  const systemMsg = messages[0];
  const rest = messages.slice(1);

  const blocks: LLMMessage[][] = [];
  let currentBlock: LLMMessage[] = [];
  let lastAssistantWithCalls: LLMMessage | null = null;

  for (const msg of rest) {
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = [msg];
      lastAssistantWithCalls = msg;
    } else if (msg.role === "tool" && lastAssistantWithCalls) {
      currentBlock.push(msg);
    } else {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
      }
      currentBlock = [msg];
      lastAssistantWithCalls = null;
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock);
  }

  while (blocks.length > 0) {
    const totalMsgs = 1 + blocks.reduce((sum, b) => sum + b.length, 0);
    if (totalMsgs <= maxMessages) break;
    blocks.shift();
  }

  return [systemMsg, ...blocks.flat()];
}

async function compressHistorySemantically(messages: LLMMessage[], userId: string | number): Promise<LLMMessage[]> {
  if (messages.length <= 200) return messages;

  const systemMsg = messages[0];
  const toCompress = messages.slice(1, -30);
  
  if (toCompress.length < 10) return messages;

  try {
    const conversationText = toCompress.map(m => `${m.role}: ${m.content}`).join("\n\n");
    
    const response = await callLLM([
      { role: "system", content: "Resumes conversations in 1 short paragraph." },
      { role: "user", content: `Resume esta conversación en 1 párrafo corto enfocándote en decisiones, configuraciones y resultados clave.\n\nConversación:\n${conversationText.slice(0, 8000)}` },
    ]);

    const summary = response.content?.trim();
    if (!summary) return messages;

    const summaryMsg: LLMMessage = {
      role: "system",
      content: `[RESUMEN CONVERSACIÓN PREVIA]\n${summary}`,
    };

    const recentMessages = messages.slice(-30);
    memoryService.saveMessage(userId, "system", summary, "summary");

    return [systemMsg, summaryMsg, ...recentMessages];
  } catch {
    return messages;
  }
}

/**
 * Intenta reparar una "alucinación": el LLM devolvió una tool call como texto JSON
 * en lugar de usar el mecanismo nativo. Solo repara si el JSON tiene exactamente
 * la forma esperada (name + args/parameters/input).
 */
function tryRepairHallucination(
  content: string,
  toolMap: Map<string, Tool>
): ToolCall | null {
  if (!content.includes('"name"') && !content.includes('"tool"')) return null;

  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    const callName = parsed.name || parsed.tool;
    if (!callName || !toolMap.has(callName)) return null;

    const callArgs = parsed.parameters || parsed.args || parsed.input;
    if (!callArgs || typeof callArgs !== "object") return null;

    return {
      id:   `repair-${Date.now()}`,
      type: "function",
      function: {
        name:      callName,
        arguments: JSON.stringify(callArgs),
      },
    };
  } catch {
    return null;
  }
}

// ─── isConversational / needsToolUse ─────────────────────────────────────────

function isConversational(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  const greetings = [/hola/i, /buenos días/i, /buenas tardes/i, /buenas noches/i, /qué tal/i, /que tal/i, /ey/i];
  const thanks    = [/gracias/i, /perfecto/i, /ok/i, /entendido/i, /listo/i, /muy bien/i, /felicito/i];
  if (greetings.some(p => p.test(trimmed)) && trimmed.length < 15) return true;
  if (thanks.some(p => p.test(trimmed)) && trimmed.length < 25) return true;
  return false;
}

export function needsToolUse(text: string): boolean {
  if (isConversational(text)) return false;
  return (
    text.includes("tool_use") ||
    /\{.*"action":.*\}/.test(text) ||
    text.includes("execute_tool")
  );
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  options:     AgentOptions
): Promise<AgentResult> {
  const { tools, systemPrompt, userId } = options;

  const traceId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();

  // ─── Construir contexto ───
  const ctx = memoryService.getContext(userId, 15);

  const factBlock = ctx.facts.length > 0
    ? `\n\n## HECHOS DEL USUARIO:\n${ctx.facts.map(f => `- ${f.key}: ${f.value}`).join("\n")}`
    : "";

  const timeBlock =
    `\n\n## CONTEXTO TEMPORAL:\n- Fecha y hora: ${new Date().toLocaleString("es-CO")}\n- Zona: America/Bogota`;

  const latestSummary = memoryService.getLatestSummary(userId);
  const summaryBlock = latestSummary
    ? `\n\n## RESUMEN CONVERSACIÓN ANTERIOR:\n${latestSummary}`
    : "";

  const fullSystem = systemPrompt + factBlock + timeBlock + summaryBlock;

  const llmTools = buildLLMTools(tools);
  const toolMap  = new Map(tools.map((t) => [t.name, t]));

  // ─── Historial de mensajes ───
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

  // ─── Estado LOCAL por run — no hay estado global entre conversaciones ───
  const usedTools:      string[] = [];
  const toolCallCount:  Map<string, number> = new Map();   // total de veces por tool
  const lastToolErrors: Map<string, string> = new Map();   // último error por tool
  const toolCallHistory: string[] = [];                    // historial de nombres (últimas 10)

  let lastToolName:    string | null = null;  // para detección de bucle consecutivo
  let lastToolArgs:    string | null = null;
  let consecSameCount: number        = 0;     // veces seguidas con misma tool+args

  let iterations   = 0;
  let successfulToolCalls = 0;
  let lastProvider = "groq";
  let warning: string | undefined;
  let geminiWarned = false;
  let loopBreaks   = 0;
  let hasReflected = false;
  const userMessageOriginal = userMessage;

  // ─── Loop principal ───────────────────────────────────────────────────────
  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[AGENT] Iteración ${iterations}/${MAX_ITERATIONS}`);

    if (iterations > 4 && successfulToolCalls === 0) {
      const result = {
        response:  "No se pudo completar ninguna acción. Verifica la configuración.",
        iterations,
        usedTools: [...new Set(usedTools)],
        provider:  lastProvider,
        warning:   "Sin tools exitosas",
      };
      logRun(traceId, startTime, userId, result);
      return result;
    }

    if (messages.length > MAX_HISTORY_MESSAGES + 10) {
      const trimmed = await compressHistorySemantically(messages, userId);
      messages.splice(0, messages.length, ...trimmed);
    }

    // ─── Llamar al LLM ───
    let llmResponse: LLMResponse;
    try {
      llmResponse = await callLLM(messages, llmTools);

      // Intentar reparar alucinación solo si no hay tool_calls nativos
      if (!llmResponse.tool_calls && llmResponse.content) {
        const repaired = tryRepairHallucination(llmResponse.content, toolMap);
        if (repaired) {
          console.log(`[AGENT] Alucinación reparada: ${repaired.function.name}`);
          llmResponse.tool_calls = [repaired];
          llmResponse.content    = null;
        }
      }
    } catch (err) {
      const result = {
        response:  `❌ LLM no disponible: ${(err as Error).message}. Intenta de nuevo.`,
        iterations,
        usedTools: [...new Set(usedTools)],
        provider:  lastProvider,
        warning:   "Error de LLM",
      };
      logRun(traceId, startTime, userId, result);
      return result;
    }

    lastProvider = llmResponse.provider;

    if (llmResponse.provider === "gemini" && !geminiWarned) {
      geminiWarned = true;
      warning = "⚠️ Usando Gemini como fallback.";
    }

    const hasCalls = llmResponse.tool_calls && llmResponse.tool_calls.length > 0;

    // Sin tool calls → el LLM terminó, retornar respuesta final
    if (!hasCalls) {
      const responseText = llmResponse.content ?? "Sin respuesta del LLM.";

      // Reflexión: solo si no es respuesta conversacional corta y no ha reflexionado
      if (!hasReflected && responseText.length >= 50 && iterations < MAX_ITERATIONS - 1) {
        try {
          const reflection = await memoryService.reflectOnResponse(
            userMessageOriginal,
            responseText,
            usedTools
          );

          if (reflection.score < 7 && reflection.missing) {
            hasReflected = true;
            console.log(`[AGENT] Reflexión: score=${reflection.score}, missing="${reflection.missing}"`);
            
            // Agregar contexto de lo que falta y continuar el loop
            messages.push({
              role: "user",
              content: `[CONTEXTO ADICIONAL - El usuario evaluó tu respuesta como incompleta (score ${reflection.score}/10): ${reflection.missing}. Por favor completa la respuesta.]`,
            });
            continue;
          }
        } catch {
          // Fallback: no reflexionar
        }
      }

      const result = {
        response:  responseText,
        iterations,
        usedTools: [...new Set(usedTools)],
        provider:  lastProvider,
        warning,
      };
      logRun(traceId, startTime, userId, result);
      return result;
    }

    messages.push({
      role:       "assistant",
      content:    llmResponse.content,
      tool_calls: llmResponse.tool_calls,
    });

    // ─── Procesar tool calls en paralelo con validación previa ─────────────────
    interface ToolCallItem {
      toolCall: ToolCall;
      skip: boolean;
      skipMessage?: string;
      tool?: Tool;
      args?: Record<string, unknown>;
    }
    const toolCallsToProcess: ToolCallItem[] = [];

    // Fase 1: Validar todos los tool calls síncronamente
    for (const toolCall of llmResponse.tool_calls!) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments || "{}";

      toolCallHistory.push(toolName);
      if (toolCallHistory.length > 10) toolCallHistory.shift();
      usedTools.push(toolName);

      const currentCount = (toolCallCount.get(toolName) || 0) + 1;
      toolCallCount.set(toolName, currentCount);

      // Circuit breaker
      if (currentCount > MAX_SAME_TOOL_PER_RUN) {
        loopBreaks++;
        const lastErr = lastToolErrors.get(toolName);
        const errInfo = lastErr ? `\nError: ${lastErr}` : "";
        console.warn(`[AGENT] Circuit breaker '${toolName}' (${currentCount} llamadas)`);

        if (loopBreaks >= MAX_LOOP_BREAKS) {
          maybeAutoRepair(lastToolErrors, String(userId));
          const result = {
            response:  `⚠️ No puedo completar esta tarea: '${toolName}' fue llamada ${currentCount} veces sin éxito.${errInfo}\n\n${lastErr ? "Causa: " + lastErr : "Reformula tu solicitud con más detalle."}`,
            iterations,
            usedTools: [...new Set(usedTools)],
            provider:  lastProvider,
            warning:   "Circuit breaker activado",
          };
          logRun(traceId, startTime, userId, result);
          return result;
        }

        toolCallsToProcess.push({
          toolCall,
          skip: true,
          skipMessage: `[SISTEMA: '${toolName}' ya fue llamada ${currentCount} veces. NO la uses más en esta conversación. Informa directamente al usuario el resultado o el error.]`,
        });
        continue;
      }

      // Bucle consecutivos
      if (toolName === lastToolName && toolArgs === lastToolArgs) {
        consecSameCount++;
      } else {
        consecSameCount  = 1;
        lastToolName     = toolName;
        lastToolArgs     = toolArgs;
      }

      if (consecSameCount >= MAX_CONSEC_SAME_ARGS) {
        loopBreaks++;
        const lastErr = lastToolErrors.get(toolName);
        console.warn(`[AGENT] Bucle consecutivo '${toolName}' (${consecSameCount} veces con mismos args)`);

        if (loopBreaks >= MAX_LOOP_BREAKS) {
          maybeAutoRepair(lastToolErrors, String(userId));
          const result = {
            response:  `⚠️ Bucle detectado: '${toolName}' fue llamada ${consecSameCount} veces con los mismos parámetros.${lastErr ? "\nError: " + lastErr : ""}\n\n${lastErr ? "No puedo continuar: " + lastErr : "Reformula tu solicitud con instrucciones más específicas."}`,
            iterations,
            usedTools: [...new Set(usedTools)],
            provider:  lastProvider,
            warning:   "Bucle consecutivo",
          };
          logRun(traceId, startTime, userId, result);
          return result;
        }

        toolCallsToProcess.push({
          toolCall,
          skip: true,
          skipMessage: `[SISTEMA: '${toolName}' llamada ${consecSameCount} veces con argumentos idénticos — bucle detectado. Cambia de estrategia o informa el error al usuario directamente.]`,
        });
        continue;
      }

      // Bucle alternado
      if (toolCallHistory.length >= 4) {
        const [a, b, c, d] = toolCallHistory.slice(-4);
        if (a === c && b === d && a !== b) {
          loopBreaks++;
          console.warn(`[AGENT] Bucle alternado: ${a}→${b}→${c}→${d}`);

          if (loopBreaks >= MAX_LOOP_BREAKS) {
            maybeAutoRepair(lastToolErrors, String(userId));
            const allErrors = [...lastToolErrors.entries()];
            const errInfo   = allErrors.length > 0
              ? `\nErrores: ${allErrors.map(([n, e]) => `${n}: ${e}`).join("; ")}`
              : "";
            const result = {
              response:  `⚠️ Bucle alternado detectado (${a} ↔ ${b}): las herramientas están en conflicto.${errInfo}\n\nNo puedo resolver esto automáticamente. Verifica la configuración de las herramientas.`,
              iterations,
              usedTools: [...new Set(usedTools)],
              provider:  lastProvider,
              warning:   "Bucle alternado",
            };
            logRun(traceId, startTime, userId, result);
            return result;
          }

          toolCallsToProcess.push({
            toolCall,
            skip: true,
            skipMessage: `[SISTEMA: Bucle alternado (${a} ↔ ${b}). Detente y responde directamente al usuario con la información disponible. NO uses más herramientas.]`,
          });
          continue;
        }
      }

      // Verificar tool existe
      const tool = toolMap.get(toolName);
      if (!tool) {
        toolCallsToProcess.push({
          toolCall,
          skip: true,
          skipMessage: `[ERROR: Herramienta '${toolName}' no existe en el registry.]`,
        });
        continue;
      }

      // Parsear argumentos
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolArgs) as Record<string, unknown>;
      } catch {
        toolCallsToProcess.push({
          toolCall,
          skip: true,
          skipMessage: `[ERROR: JSON inválido en argumentos de '${toolName}']`,
        });
        continue;
      }

      // Tool válida, no se skipea
      toolCallsToProcess.push({ toolCall, skip: false, tool, args });
    }

    // Fase 2: Ejecutar en paralelo los no-skipeados
    const executionResults = await Promise.allSettled(
      toolCallsToProcess
        .filter(t => !t.skip && t.tool && t.args)
        .map(async (t) => {
          const { toolCall, tool, args } = t;
          const toolName = tool!.name;

          console.log(`[AGENT] Tool: ${toolName}`);

          try {
            const raw       = await executeToolWithTimeout(tool!, args!, String(userId));
            const truncated = truncateToolResponse(raw);

            if (truncated.startsWith("❌")) {
              lastToolErrors.set(toolName, truncated.slice(0, 300));
              console.warn(`[AGENT] Tool '${toolName}' error: ${truncated.slice(0, 100)}`);
            }

            return { toolCall, truncated, success: !truncated.startsWith("❌") };
          } catch (err) {
            const errMsg = (err as Error).message;
            lastToolErrors.set(toolName, errMsg);
            return { toolCall, truncated: `[ERROR en '${toolName}': ${errMsg}]`, success: false };
          }
        })
    );

    // Fase 3: Insertar resultados en messages en orden original
    let resultIndex = 0;
    for (const item of toolCallsToProcess) {
      if (item.skip) {
        messages.push({
          role:         "tool",
          tool_call_id: item.toolCall.id,
          content:      item.skipMessage!,
        });
      } else {
        const result = executionResults[resultIndex++];
        const value = result.status === "fulfilled" ? result.value : { truncated: "[ERROR: Promise rechazado]", success: false };
        const { toolCall, truncated, success } = value as any;

        if (success) {
          successfulToolCalls++;
        }

        // Error fatal
        if (isFatalError(truncated)) {
          console.warn(`[AGENT] Error fatal en '${toolCall.function.name}' — saliendo sin reintentar.`);
          const res = {
            response:  truncated,
            iterations,
            usedTools: [...new Set(usedTools)],
            provider:  lastProvider,
            warning:   `Error fatal en '${toolCall.function.name}'`,
          };
          logRun(traceId, startTime, userId, res);
          return res;
        }

        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      truncated,
        });
      }
    }

    if (messages.length > MAX_HISTORY_MESSAGES + 5) {
      const trimmed = await compressHistorySemantically(messages, userId);
      messages.splice(0, messages.length, ...trimmed);
    }
  } // fin while

  console.error(`[AGENT] MAX_ITERATIONS (${MAX_ITERATIONS}) alcanzado`);
  maybeAutoRepair(lastToolErrors, String(userId));
  const result = {
    response:  "⚠️ Límite de iteraciones alcanzado. La tarea es demasiado compleja para un solo paso. Intenta dividirla en partes más pequeñas.",
    iterations,
    usedTools: [...new Set(usedTools)],
    provider:  lastProvider,
    warning:   "MAX_ITERATIONS",
  };
  logRun(traceId, startTime, userId, result);
  return result;
}

// ─── Plan-and-Execute ────────────────────────────────────────────────────────

interface ExecutionPlan {
  steps:   string[];
  planBlock: string;   // formatted for system prompt injection
}

const COMPLEX_TASK_KEYWORDS = [
  /campa[ñn]a/i, /completo/i, /estrategia/i, /\btodo\b/i,
  /\bplan\b/i, /paso\s+a\s+paso/i, /lanzamiento/i,
];

function isComplexTask(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount > 40) return true;
  return COMPLEX_TASK_KEYWORDS.some(k => k.test(message));
}

async function generatePlan(
  userMessage: string,
  availableTools: Tool[]
): Promise<ExecutionPlan | null> {
  const toolNames = availableTools.map(t => t.name).join(", ");

  try {
    const response = await callLLM([
      {
        role: "system",
        content:
          "Eres un planificador estratégico. Analiza la solicitud y genera un plan paso a paso.\n" +
          `Herramientas disponibles: ${toolNames}\n` +
          "Responde ÚNICAMENTE con JSON válido, sin markdown ni texto adicional.\n" +
          'Formato: {"plan": ["paso 1", "paso 2"], "estimated_steps": N}\n' +
          "Máximo 6 pasos. Cada paso debe ser específico y accionable.",
      },
      {
        role: "user",
        content: `Solicitud: ${userMessage}\n\nGenera el plan de ejecución.`,
      },
    ]);

    const raw    = (response.content ?? "{}").replace(/```(?:json)?\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(raw) as { plan: string[]; estimated_steps?: number };

    if (!Array.isArray(parsed.plan) || parsed.plan.length === 0) return null;

    const steps = parsed.plan.slice(0, 6);
    const planBlock =
      `\n\n## PLAN DE EJECUCIÓN (${steps.length} pasos):\n` +
      steps.map((s, i) => `[ ] Paso ${i + 1}: ${s}`).join("\n") +
      "\n\nEjecuta los pasos en orden. Avanza automáticamente al siguiente cuando completes el anterior. " +
      "NO pidas confirmación entre pasos.";

    return { steps, planBlock };
  } catch (err) {
    console.warn("[PLAN] No se pudo generar plan:", (err as Error).message);
    return null;
  }
}

// Maps tool names → keywords found in plan step descriptions
const TOOL_STEP_KEYWORDS: Record<string, string[]> = {
  web_researcher:     ["investiga", "busca", "research", "competencia", "analiza", "web", "información"],
  facebook_publisher: ["facebook", "publica", "post", "fb", "publicación", "publ"],
  meta_ads:           ["ads", "anunci", "campaña", "publicidad", "meta", "pauta"],
  landing_builder:    ["landing", "página", "web", "sitio", "venta"],
  google_workspace:   ["google", "docs", "drive", "correo", "email", "calendar", "sheet"],
  image_generator:    ["imagen", "foto", "visual", "diseño", "banner", "gráfico"],
  video_composer:     ["video", "reel", "clip", "edita"],
  voice:              ["voz", "audio", "narración", "podcast"],
  whatsapp_manager:   ["whatsapp", "mensaje", "wha", "chat"],
  system_control:     ["sistema", "archivo", "server", "servidor"],
};

function detectCompletedSteps(steps: string[], usedTools: string[]): Set<number> {
  const completed = new Set<number>();
  if (usedTools.length === 0) return completed;

  for (const toolName of usedTools) {
    const keywords = TOOL_STEP_KEYWORDS[toolName] ?? [toolName.replace(/_/g, " ")];
    steps.forEach((step, i) => {
      if (completed.has(i)) return;
      const low = step.toLowerCase();
      if (keywords.some(k => low.includes(k))) completed.add(i);
    });
  }

  return completed;
}

export async function runAgentWithPlan(
  userMessage: string,
  options: AgentOptions
): Promise<AgentResult> {
  // Short-circuit for simple tasks
  if (!isComplexTask(userMessage)) {
    return runAgent(userMessage, options);
  }

  console.log("[AGENT] Tarea compleja detectada — generando plan...");

  const execPlan = await generatePlan(userMessage, options.tools);

  if (!execPlan) {
    console.warn("[AGENT] Falló generación de plan → runAgent normal");
    return runAgent(userMessage, options);
  }

  console.log(`[AGENT] Plan: ${execPlan.steps.length} pasos — ${execPlan.steps.join(" | ")}`);

  // Inject plan into system prompt
  const result = await runAgent(userMessage, {
    ...options,
    systemPrompt: options.systemPrompt + execPlan.planBlock,
  });

  // Detect which steps were completed based on tools actually used
  const completed = detectCompletedSteps(execPlan.steps, result.usedTools);

  // Build completion summary
  const stepLines = execPlan.steps.map((step, i) =>
    `${completed.has(i) ? "✅" : "⬜"} Paso ${i + 1}: ${step}`
  );
  const allDone = completed.size === execPlan.steps.length;

  const planSummary =
    `\n\n---\n📋 *Plan de ejecución:*\n${stepLines.join("\n")}\n` +
    (allDone
      ? "✅ Todos los pasos completados."
      : `⚠️ ${execPlan.steps.length - completed.size} paso(s) pendiente(s).`);

  return {
    ...result,
    response: result.response + planSummary,
  };
}
