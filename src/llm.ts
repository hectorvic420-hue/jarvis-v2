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
  provider: "groq" | "openrouter" | "gemini";
  usedFallback: boolean;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const LLM_TIMEOUT_MS   = 120_000;
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

async function callGemini(messages: LLMMessage[]): Promise<LLMResponse> {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const systemMsg    = messages.find((m) => m.role === "system");
  const chatMessages = messages.filter(
    (m) => m.role !== "system" && m.role !== "tool"
  );

  // Gemini requiere turnos alternados user/model — fusionamos mismo-rol consecutivo
  const history: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const m of chatMessages.slice(0, -1)) {
    const role = m.role === "assistant" ? "model" : "user";
    const last = history[history.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: m.content ?? "" });
    } else {
      history.push({ role, parts: [{ text: m.content ?? "" }] });
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

  return {
    content:      result.response.text(),
    tool_calls:   undefined,
    provider:     "gemini",
    usedFallback: true,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Cadena de fallback: Groq → OpenRouter → Gemini.
 * Gemini no soporta tools — si se alcanza, las tools se omiten.
 */
export async function callLLM(
  messages: LLMMessage[],
  tools?: LLMTool[]
): Promise<LLMResponse> {
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
    console.log("[LLM] Intentando Gemini (sin tools)...");
    if (tools && tools.length > 0) {
      console.warn("[LLM] Gemini no soporta tools — se omiten.");
    }
    return await callGemini(messages);
  } catch (err) {
    console.error("[LLM] Gemini falló:", (err as Error).message);
    throw new Error("Todos los proveedores LLM fallaron.");
  }
}
