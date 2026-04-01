import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import { ChatCompletionMessageParam } from "groq-sdk/resources/chat/completions";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
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
const CLAUDE_MODEL     = "claude-sonnet-4-6";
const GROQ_MODEL       = "llama-3.3-70b-versatile";
const OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct";
const GEMINI_MODEL     = "gemini-1.5-flash";

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

  const res = await withTimeout(
    client.messages.create(params),
    LLM_TIMEOUT_MS,
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

  // groq-sdk 1.1.2: ChatCompletionCreateParamsNonStreaming no está re-exportado
  // al namespace Groq.Chat — construimos el objeto directo con stream: false.
  const params = {
    model:       GROQ_MODEL,
    messages:    messages as ChatCompletionMessageParam[],
    temperature: 0.7,
    max_tokens:  4096,
    stream:      false as const,
    ...(tools && tools.length > 0
      ? {
          tools:       tools as Groq.Chat.Completions.ChatCompletionTool[],
          tool_choice: "auto" as const,
        }
      : {}),
  };

  const res = await withTimeout(
    client.chat.completions.create(params),
    LLM_TIMEOUT_MS,
    "Groq"
  );

  const choice = res.choices[0];
  return {
    content:      choice.message.content ?? null,
    tool_calls:   (choice.message as any).tool_calls as ToolCall[] | undefined,
    provider:     "groq",
    usedFallback: false,
  };
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

  const params: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming = {
    model:       OPENROUTER_MODEL,
    messages:    messages as OpenAI.Chat.ChatCompletionMessageParam[],
    temperature: 0.7,
    max_tokens:  4096,
    ...(tools && tools.length > 0
      ? {
          tools:       tools as OpenAI.Chat.ChatCompletionTool[],
          tool_choice: "auto" as const,
        }
      : {}),
  };

  const res = await withTimeout(
    client.chat.completions.create(params),
    LLM_TIMEOUT_MS,
    "OpenRouter"
  );

  const choice = res.choices[0];
  return {
    content:      choice.message.content ?? null,
    tool_calls:   (choice.message as any).tool_calls as ToolCall[] | undefined,
    provider:     "openrouter",
    usedFallback: true,
  };
}

async function callGemini(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  
  // Transformar tools al formato Gemini (arreglo de { functionDeclarations: [...] })
  const geminiTools = tools && tools.length > 0 
    ? [{
        functionDeclarations: tools.map(t => ({
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as any,
        }))
      }]
    : undefined;

  const model = genAI.getGenerativeModel({ 
    model: GEMINI_MODEL,
    tools: geminiTools as any,
  });

  const systemMsg    = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter((m) => m.role !== "system");

  // Gemini requiere turnos alternados user/model/tool
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
  const chat = model.startChat({
    history,
    ...(systemMsg?.content ? { systemInstruction: systemMsg.content } : {}),
  });

  const result = await withTimeout(
    chat.sendMessage(lastMsg?.content ?? "continúa"),
    LLM_TIMEOUT_MS,
    "Gemini"
  );

  const responseText = result.response.text();
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
 * Cadena de fallback: Claude → Groq → OpenRouter → Gemini.
 */
export async function callLLM(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      console.log("[LLM] Intentando Claude...");
      return await callClaude(messages, tools);
    } catch (err) {
      console.warn("[LLM] Claude falló:", (err as Error).message);
    }
  }

  try {
    console.log("[LLM] Intentando Groq...");
    return await callGroq(messages, tools);
  } catch (err) {
    console.warn("[LLM] Groq falló:", (err as Error).message);
  }

  try {
    console.log("[LLM] Intentando OpenRouter...");
    return await callOpenRouter(messages, tools);
  } catch (err) {
    console.warn("[LLM] OpenRouter falló:", (err as Error).message);
  }

  try {
    console.log("[LLM] Intentando Gemini...");
    return await callGemini(messages, tools);
  } catch (err) {
    console.error("[LLM] Gemini falló:", (err as Error).message);
    throw new Error(`Todos los proveedores LLM fallaron. Último error: ${(err as Error).message}`);
  }
}
