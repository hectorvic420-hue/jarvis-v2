import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImageBlock {
  media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: string; // base64
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  imageBlocks?: ImageBlock[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  provider: "claude" | "groq" | "openrouter" | "gemini";
  usedFallback: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const LLM_TIMEOUT_MS   = 120_000;

// Modelos optimizados para tool calling (ordenados por confiabilidad)
// Groq: modelos gratuitos con excelente tool calling
const GROQ_MODELS = [
  "qwen-2.5-72b-instruct",     // Mejor soporte tool calling en Groq
  "deepseek-r1-distill-qwen-32b", // Reasoning + tool calling
  "llama-3.3-70b-versatile",   // Fallback
];

// OpenRouter: modelos variados (requiere crédito o trial)
const OPENROUTER_MODELS = [
  "anthropic/claude-3.5-haiku",      // Rápido y barato
  "google/gemini-2.0-flash-exp",    // Excelente tool calling
  "deepseek/deepseek-chat-v3-0324", // Muy capaz
  "meta-llama/llama-3.3-70b-instruct", // Fallback
];

// Claude: modelo principal (requiere crédito)
const CLAUDE_MODEL = "claude-sonnet-4-6";

// Gemini directo: API gratuita con límites
const GEMINI_MODEL = "gemini-2.0-flash";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detecta errores de saldo insuficiente / API key inválida — no tiene sentido reintentar */
function isFatalProviderError(err: any): boolean {
  const msg: string = err?.message ?? "";
  const status: number = err?.status ?? err?.statusCode ?? 0;
  return (
    msg.includes("credit balance") ||
    msg.includes("too low") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing") ||
    (status === 402) ||
    (status === 401 && msg.includes("API key"))
  );
}

/** Errores transitorios que deberían activar fallback al siguiente provider */
function isRetryableError(error: any): boolean {
  const retryableMessages = [
    'credit balance is too low',
    'rate limit',
    'timeout',
    'econnrefused',
    'etimedout',
    'socket hang up',
  ];
  const errorStr = JSON.stringify(error).toLowerCase();
  return retryableMessages.some(msg => errorStr.includes(msg));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[${label}] Timeout después de ${ms}ms`)),
        ms
      )
    ),
  ]);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelayMs: number = 1000,
  label: string = "Operation"
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err as Error;

      const shouldRetry =
        attempt < maxRetries &&
        !isFatalProviderError(err) &&
        (
          err?.message?.includes("429") ||
          err?.message?.includes("rate_limit") ||
          err?.message?.includes("timeout") ||
          err?.message?.includes("ETIMEDOUT") ||
          err?.message?.includes("ECONNRESET") ||
          err?.message?.includes("network") ||
          err?.message?.includes("service_unavailable") ||
          err?.message?.includes("500") ||
          err?.message?.includes("502") ||
          err?.message?.includes("503") ||
          err?.message?.includes("Tool use failed")
        );

      if (shouldRetry) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        console.log(`[LLM] ${label}: Intento ${attempt + 1} falló. Reintentando en ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error(`${label} falló después de ${maxRetries} intentos`);
}

// ─── Providers ───────────────────────────────────────────────────────────────

async function callClaude(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemMsg = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  // Convertir mensajes al formato de Anthropic
  const anthropicMessages: Anthropic.MessageParam[] = chatMessages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user" as const,
        content: [{
          type: "tool_result" as const,
          tool_use_id: m.tool_call_id!,
          content: m.content ?? "",
        }],
      };
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const content: any[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      return { role: "assistant" as const, content };
    }
    if (m.role === "user" && m.imageBlocks?.length) {
      const content: Anthropic.MessageParam["content"] = [
        ...m.imageBlocks.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.media_type,
            data: img.data,
          },
        })),
        { type: "text" as const, text: m.content ?? "" },
      ];
      return { role: "user" as const, content };
    }
    return {
      role: m.role as "user" | "assistant",
      content: m.content ?? "",
    };
  });

  // Convertir tools al formato de Anthropic
  const anthropicTools: Anthropic.Tool[] | undefined = tools?.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool["input_schema"],
  }));

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model:      CLAUDE_MODEL,
    max_tokens: 4096,
    system:     systemMsg?.content ?? undefined,
    messages:   anthropicMessages,
    ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
  };

  const res = await retryWithBackoff(
    () => withTimeout(
      client.messages.create(params),
      LLM_TIMEOUT_MS,
      "Claude"
    ),
    2,
    1500,
    "Claude"
  );

  // Extraer tool_calls y texto
  const toolUseBlocks = res.content.filter((b) => b.type === "tool_use") as any[];
  const textBlock     = res.content.find((b) => b.type === "text") as any | undefined;

  const toolCalls: ToolCall[] | undefined = toolUseBlocks.length > 0
    ? toolUseBlocks.map((b) => ({
        id:   b.id,
        type: "function" as const,
        function: {
          name:      b.name,
          arguments: JSON.stringify(b.input),
        },
      }))
    : undefined;

  return {
    content:      textBlock?.text ?? null,
    tool_calls:   toolCalls,
    provider:     "claude",
    usedFallback: false,
  };
}

async function callGroq(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

  for (const modelName of GROQ_MODELS) {
    try {
      const params = {
        model:       modelName,
        messages:    messages as ChatCompletionMessageParam[],
        temperature: 0.1,
        max_tokens:  4096,
        stream:      false as const,
        ...(tools && tools.length > 0
          ? {
              tools:       tools as Groq.Chat.Completions.ChatCompletionTool[],
              tool_choice: "auto" as const,
            }
          : {}),
      };

      const res = await retryWithBackoff(
        () => withTimeout(
          client.chat.completions.create(params),
          LLM_TIMEOUT_MS,
          `Groq(${modelName})`
        ),
        2,
        1500,
        `Groq(${modelName})`
      );

      const choice = res.choices[0];
      if (!choice) throw new Error("Groq no retornó choice");

      const content = choice.message.content ?? null;
      const toolCalls = (choice.message as any).tool_calls as ToolCall[] | undefined;

      if (!content && !toolCalls) {
        console.warn(`[LLM] Groq(${modelName}): respuesta vacía, intentando siguiente modelo...`);
        continue;
      }

      return {
        content:      content,
        tool_calls:   toolCalls,
        provider:     "groq",
        usedFallback: false,
      };
    } catch (err: any) {
      const isToolError =
        err?.message?.includes("Tool use failed") ||
        err?.message?.includes("tool_use_failed") ||
        err?.message?.includes("function");

      if (isToolError && modelName !== GROQ_MODELS[GROQ_MODELS.length - 1]) {
        console.warn(`[LLM] Groq(${modelName}): error con tools, intentando siguiente modelo...`);
        continue;
      }

      if (modelName === GROQ_MODELS[GROQ_MODELS.length - 1]) {
        throw err;
      }
    }
  }

  throw new Error("Todos los modelos Groq fallaron");
}

async function callOpenRouter(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const client = new OpenAI({
    apiKey:  process.env.OPENROUTER_API_KEY,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://jarvis.automatizado.agency",
      "X-Title":      "Jarvis AI Agent",
    },
  });

  for (const modelName of OPENROUTER_MODELS) {
    try {
      const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
        model:       modelName,
        messages:    messages as OpenAI.Chat.ChatCompletionMessageParam[],
        temperature: 0.1,
        max_tokens:  4096,
        ...(tools && tools.length > 0
          ? {
              tools:       tools as OpenAI.Chat.ChatCompletionTool[],
              tool_choice: "auto" as const,
            }
          : {}),
      };

      const res = await retryWithBackoff(
        () => withTimeout(
          client.chat.completions.create(params),
          LLM_TIMEOUT_MS,
          `OpenRouter(${modelName})`
        ),
        2,
        1500,
        `OpenRouter(${modelName})`
      );

      const choice = res.choices[0];
      if (!choice) throw new Error("OpenRouter no retornó choice");

      const content = choice.message.content ?? null;
      const toolCalls = (choice.message as any).tool_calls as ToolCall[] | undefined;

      if (!content && !toolCalls) {
        console.warn(`[LLM] OpenRouter(${modelName}): respuesta vacía, intentando siguiente...`);
        continue;
      }

      return {
        content:      content,
        tool_calls:   toolCalls,
        provider:     "openrouter",
        usedFallback: true,
      };
    } catch (err: any) {
      const isToolError =
        err?.message?.includes("Tool use failed") ||
        err?.message?.includes("tool_use_failed");

      if (isToolError && modelName !== OPENROUTER_MODELS[OPENROUTER_MODELS.length - 1]) {
        console.warn(`[LLM] OpenRouter(${modelName}): error con tools, intentando siguiente...`);
        continue;
      }

      if (modelName === OPENROUTER_MODELS[OPENROUTER_MODELS.length - 1]) {
        throw err;
      }
    }
  }

  throw new Error("Todos los modelos OpenRouter fallaron");
}

async function callGemini(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  
  const geminiTools = tools && tools.length > 0 
    ? [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as any,
        }))
      }]
    : undefined;

  const systemMsg    = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    tools: geminiTools as any,
    ...(systemMsg?.content ? {
      systemInstruction: { role: "user", parts: [{ text: systemMsg.content }] }
    } : {}),
  });

  const history: any[] = [];
  for (let i = 0; i < chatMessages.length - 1; i++) {
    const m = chatMessages[i];
    const role = m.role === "assistant" ? "model" : (m.role === "tool" ? "function" : "user");
    
    if (role === "function") {
      history.push({
        role: "function",
        parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }]
      });
    } else {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls) {
        m.tool_calls.forEach(tc => {
          parts.push({ 
            functionCall: { 
              name: tc.function.name, 
              args: JSON.parse(tc.function.arguments) 
            } 
          });
        });
      }
      history.push({ role, parts });
    }
  }

  const lastMsg = chatMessages[chatMessages.length - 1];
  const chat = model.startChat({ history });

  const result = await retryWithBackoff(
    () => withTimeout(
      chat.sendMessage(lastMsg?.content ?? "continúa"),
      LLM_TIMEOUT_MS,
      "Gemini"
    ),
    2,
    1500,
    "Gemini"
  );

  const responseText = result.response.text?.() || null;
  const functionCalls = result.response.candidates?.[0]?.content?.parts?.filter(p => p.functionCall);
  
  const toolCalls: ToolCall[] | undefined = functionCalls?.map((fc, idx) => ({
    id: `gemini-${Date.now()}-${idx}`,
    type: "function",
    function: {
      name: fc.functionCall!.name,
      arguments: JSON.stringify(fc.functionCall!.args),
    }
  }));

  return {
    content:      responseText || null,
    tool_calls:   toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    provider:     "gemini",
    usedFallback: true,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Cadena de fallback inteligente:
 * 1. Claude (mejor calidad, requiere crédito)
 * 2. Groq (modelos gratuitos con tool calling)
 * 3. OpenRouter (modelos variados)
 * 4. Gemini (API gratuita)
 */
export async function callLLM(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const providers = [];

  // 1. Claude: prioridad principal (mejor calidad) — omitir si DISABLE_CLAUDE=true
  if (process.env.ANTHROPIC_API_KEY && process.env.DISABLE_CLAUDE !== "true") {
    providers.push({ name: "Claude", fn: () => callClaude(messages, tools) });
  }

  // 2. Groq: fallback gratuito
  if (process.env.GROQ_API_KEY) {
    providers.push({ name: "Groq", fn: () => callGroq(messages, tools) });
  }

  // 3. OpenRouter: modelos variados
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({ name: "OpenRouter", fn: () => callOpenRouter(messages, tools) });
  }

  // 4. Gemini: API gratuita
  if (process.env.GOOGLE_API_KEY) {
    providers.push({ name: "Gemini", fn: () => callGemini(messages, tools) });
  }

  if (providers.length === 0) {
    throw new Error(
      "No hay proveedores LLM configurados. " +
      "Configura al menos una API key: GROQ_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY o ANTHROPIC_API_KEY"
    );
  }

  let lastError: Error | undefined;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const isLast = i === providers.length - 1;

    try {
      console.log(`[LLM] Intentando ${provider.name}...`);
      return await provider.fn();
    } catch (err) {
      lastError = err as Error;

      if (isRetryableError(lastError)) {
        console.warn(`[LLM] ${provider.name} falló con error retryable, intentando fallback...`);
      } else if (isFatalProviderError(lastError)) {
        console.warn(`[LLM] ${provider.name} sin créditos/inválido — pasando al siguiente provider...`);
      } else {
        console.warn(`[LLM] ${provider.name} falló:`, lastError.message);
        if (isLast) throw lastError; // Error fatal en último provider — no hay más opciones
      }
    }
  }

  throw new Error(
    `Todos los proveedores LLM fallaron (${providers.map(p => p.name).join(", ")}). ` +
    `Último error: ${lastError?.message}`
  );
}

/**
 * Versión económica: usa Groq → OpenRouter → Gemini, saltando Claude.
 * Para tareas auxiliares (reflexión, plan, extracción de hechos, resúmenes)
 * donde no se necesita la máxima calidad y el costo importa.
 */
export async function callLLMCheap(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const providers = [];

  if (process.env.GROQ_API_KEY) {
    providers.push({ name: "Groq", fn: () => callGroq(messages, tools) });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.push({ name: "OpenRouter", fn: () => callOpenRouter(messages, tools) });
  }
  if (process.env.GOOGLE_API_KEY) {
    providers.push({ name: "Gemini", fn: () => callGemini(messages, tools) });
  }
  // Último recurso: Claude (evitar si es posible) — omitir si DISABLE_CLAUDE=true
  if (process.env.ANTHROPIC_API_KEY && process.env.DISABLE_CLAUDE !== "true") {
    providers.push({ name: "Claude", fn: () => callClaude(messages, tools) });
  }

  if (providers.length === 0) {
    throw new Error("No hay proveedores LLM configurados.");
  }

  let lastError: Error | undefined;
  for (const provider of providers) {
    try {
      return await provider.fn();
    } catch (err) {
      lastError = err as Error;
    }
  }

  throw new Error(`callLLMCheap: todos fallaron. Último: ${lastError?.message}`);
}
