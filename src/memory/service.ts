import db from "./db.js";
import { callLLM, callLLMCheap, LLMMessage } from "../llm.js";

// ─── Fix 4: Timezone from environment variable ────────────────────────────────
const TIMEZONE = process.env.TIMEZONE ?? "America/Bogota";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface Message {
  id?:        number;
  user_id:    string;
  role:       "user" | "assistant" | "system";
  content:    string;
  source?:    string;
  created_at?: string;
}

export interface Fact {
  id?:         number;
  user_id:     string;           // Fix 1: user_id present
  key:         string;
  value:       string;
  confidence?: number;
  source?:     string;
  created_at?: string;
  updated_at?: string;
}

export interface Task {
  id:          number;
  user_id:     string;
  title:       string;
  description: string | null;
  status:      "pending" | "in_progress" | "done" | "cancelled";
  priority:    number;
  due_at:      string | null;
  created_at:  string;
  updated_at:  string;
}

export interface Episode {
  id:         number;
  user_id:    string;
  title:      string;
  summary:    string;
  tools_used: string;   // JSON array string
  outcome:    string | null;
  created_at: string;
}

export interface MemoryContext {
  recent_messages:    Message[];
  facts:              Fact[];
  summary?:           string;
  relevant_episodes?: Episode[];
}

// ─── Prepared statements ──────────────────────────────────────────────────────
const stmts = {
  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (user_id, role, content, source)
    VALUES (@user_id, @role, @content, @source)
  `),

  getMessages: db.prepare(`
    SELECT * FROM messages
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),

  deleteOldMessages: db.prepare(`
    DELETE FROM messages
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM messages
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `),

  countMessages: db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE user_id = ?
  `),

  // Facts — Fix 1 + Fix 2: all statements scoped to user_id
  upsertFact: db.prepare(`
    INSERT INTO facts (user_id, key, value, confidence, source)
    VALUES (@user_id, @key, @value, @confidence, @source)
    ON CONFLICT(user_id, key) DO UPDATE SET
      value      = excluded.value,
      confidence = excluded.confidence,
      source     = excluded.source,
      updated_at = datetime('now')
  `),

  getFact: db.prepare(`
    SELECT * FROM facts WHERE user_id = ? AND key = ?
  `),

  // Fix 2: getAllFacts scoped by user_id
  getAllFacts: db.prepare(`
    SELECT * FROM facts
    WHERE user_id = ?
    ORDER BY updated_at DESC
  `),

  deleteFact: db.prepare(`
    DELETE FROM facts WHERE user_id = ? AND key = ?
  `),

  clearFacts: db.prepare(`
    DELETE FROM facts WHERE user_id = ?
  `),

  // Tasks
  insertTask: db.prepare(`
    INSERT INTO tasks (user_id, title, description, priority, due_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  getTasks: db.prepare(`
    SELECT * FROM tasks WHERE user_id = ?
  `),

  updateTask: db.prepare(`
    UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?
  `),

  // Conversation summaries
  insertSummary: db.prepare(`
    INSERT INTO conversation_summaries (user_id, summary, messages_covered)
    VALUES (?, ?, ?)
  `),

  getOldMessages: db.prepare(`
    SELECT * FROM messages
    WHERE user_id = ?
    ORDER BY created_at ASC
    LIMIT ?
  `),

  deleteMessages: db.prepare(`
    DELETE FROM messages
    WHERE user_id = ? AND id IN (
      SELECT id FROM messages
      WHERE user_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    )
  `),

  getLatestSummary: db.prepare(`
    SELECT summary FROM conversation_summaries
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `),

  // Episodes
  insertEpisode: db.prepare(`
    INSERT INTO episodes (user_id, title, summary, tools_used, outcome)
    VALUES (?, ?, ?, ?, ?)
  `),

  searchEpisodesFts: db.prepare(`
    SELECT e.*
    FROM episodes e
    WHERE e.user_id = ?
      AND e.id IN (
        SELECT rowid FROM episodes_fts
        WHERE episodes_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      )
    ORDER BY e.created_at DESC
    LIMIT ?
  `),

  getRecentEpisodes: db.prepare(`
    SELECT * FROM episodes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `),
};

// ─── Message operations ───────────────────────────────────────────────────────
function addMessage(
  userId: string | number,
  role: Message["role"],
  content: string,
  source = "telegram"
): void {
  stmts.insertMessage.run({ user_id: String(userId), role, content, source });
}

function getMessages(userId: string | number, limit = 20): Message[] {
  return stmts.getMessages.all(String(userId), limit).reverse() as Message[];
}

function getLatestSummary(userId: string | number): string | null {
  const row = stmts.getLatestSummary.get(String(userId)) as { summary: string } | undefined;
  return row?.summary ?? null;
}

function pruneMessages(userId: string | number, keepLast = 200): void {
  stmts.deleteOldMessages.run(String(userId), String(userId), keepLast);
}

function countMessages(userId: string | number): number {
  const row = stmts.countMessages.get(String(userId)) as { count: number };
  return row.count;
}

async function compressOldMessages(userId: string): Promise<void> {
  if (countMessages(userId) <= 100) return;

  try {
    const oldMessages = stmts.getOldMessages.all(userId, 100) as Message[];
    if (oldMessages.length === 0) return;

    const conversationText = oldMessages.map((m) => `${m.role}: ${m.content}`).join("\n\n");

    const summaryResponse = await callLLMCheap([
      { role: "system", content: "Resume conversaciones en máximo 150 palabras. Solo decisiones, configuraciones y resultados clave." },
      { role: "user", content: `Resume:\n${conversationText}` },
    ]);

    const summary = summaryResponse.content?.trim();
    if (!summary) return;

    stmts.insertSummary.run(userId, summary, oldMessages.length);

    stmts.deleteMessages.run(userId, userId, oldMessages.length);
  } catch {
    // Best-effort
  }
}

async function reflectOnResponse(
  userRequest: string,
  agentResponse: string,
  usedTools: string[]
): Promise<{ score: number; missing?: string }> {
  const prompt = `Usuario pidió: ${userRequest.slice(0, 200)}. Respuesta: ${agentResponse.slice(0, 300)}. Tools: ${usedTools.join(", ")}. Escala 1-10 completitud. Si <7 qué faltó. JSON: {score:N, missing:'...'}`;

  try {
    const response = await callLLMCheap([
      { role: "system", content: "Responde solo JSON válido: {score:N, missing:'...'}" },
      { role: "user", content: prompt },
    ]);

    const jsonMatch = response.content?.match(/\{[^}]+\}/);
    if (!jsonMatch) return { score: 5 };

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 5,
      missing: parsed.missing || undefined,
    };
  } catch {
    return { score: 5 };
  }
}

// ─── Fact operations ──────────────────────────────────────────────────────────
function upsertFact(
  userId: string | number,
  key: string,
  value: string,
  confidence = 1.0,
  source = "inferred"
): void {
  stmts.upsertFact.run({ user_id: String(userId), key, value, confidence, source });
}

function getFact(userId: string | number, key: string): Fact | undefined {
  return stmts.getFact.get(String(userId), key) as Fact | undefined;
}

// Fix 2: getAllFacts accepts userId as parameter
function getAllFacts(userId: string | number): Fact[] {
  return stmts.getAllFacts.all(String(userId)) as Fact[];
}

function deleteFact(userId: string | number, key: string): boolean {
  const result = stmts.deleteFact.run(String(userId), key);
  return result.changes > 0;
}

function clearFacts(userId: string | number): void {
  stmts.clearFacts.run(String(userId));
}

async function extractAndSaveFacts(userId: string, conversation: Message[]): Promise<void> {
  if (conversation.length < 4) return;

  const recent = conversation.slice(-6);
  const conversationText = recent.map((m) => `${m.role}: ${m.content}`).join("\n\n");

  const messages: LLMMessage[] = [
    { role: "system", content: "Extrae hechos permanentes del usuario (nombre, negocio, preferencias). JSON: [{\"key\":\"...\",\"value\":\"...\"}] o []" },
    { role: "user", content: conversationText },
  ];

  try {
    const response = await callLLMCheap(messages);
    const content = response.content ?? "[]";

    let facts: { key: string; value: string }[];
    try {
      facts = JSON.parse(content);
    } catch {
      return;
    }

    if (!Array.isArray(facts)) return;

    for (const fact of facts) {
      if (fact.key && fact.value) {
        upsertFact(userId, fact.key, fact.value, 0.8, "conversation");
      }
    }
  } catch {
    // Best-effort, ignore errors
  }
}

// ─── Episode operations ───────────────────────────────────────────────────────

function saveEpisode(
  userId: string | number,
  data: { title: string; summary: string; tools_used: string[]; outcome?: string }
): void {
  try {
    stmts.insertEpisode.run(
      String(userId),
      data.title.slice(0, 120),
      data.summary.slice(0, 400),
      JSON.stringify(data.tools_used),
      data.outcome ?? "success"
    );
  } catch (err) {
    console.warn("[MEMORY] saveEpisode failed:", (err as Error).message);
  }
}

/** Sanitize a free-text query for FTS5: strip special syntax chars, keep Spanish letters */
function sanitizeFtsQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^\wáéíóúñüÁÉÍÓÚÑÜ\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 8)          // max 8 terms to avoid query explosion
    .join(" ");
}

function searchEpisodes(
  userId: string | number,
  query: string,
  limit = 3
): Episode[] {
  try {
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) {
      // No usable terms → fall back to most recent episodes
      return stmts.getRecentEpisodes.all(String(userId), limit) as Episode[];
    }
    const results = stmts.searchEpisodesFts.all(String(userId), ftsQuery, limit) as Episode[];
    // If FTS found nothing, fall back to recents
    if (results.length === 0) {
      return stmts.getRecentEpisodes.all(String(userId), limit) as Episode[];
    }
    return results;
  } catch {
    // FTS can throw on malformed queries — silent fallback
    return stmts.getRecentEpisodes.all(String(userId), limit) as Episode[];
  }
}

// ─── Task operations ──────────────────────────────────────────────────────────
function saveTask(userId: string | number, title: string, description?: string, priority = 2, dueAt?: string): number {
  const result = stmts.insertTask.run(String(userId), title, description ?? null, priority, dueAt ?? null);
  return result.lastInsertRowid as number;
}

function getTasks(userId: string | number): Task[] {
  return stmts.getTasks.all(String(userId)) as Task[];
}

// ─── Context builder ──────────────────────────────────────────────────────────
function getContext(userId: string | number, messageLimit = 20): MemoryContext {
  const recentMessages = getMessages(userId, messageLimit);
  const facts          = getAllFacts(userId);
  const summary        = getLatestSummary(userId) ?? undefined;

  return { recent_messages: recentMessages, facts, summary };
}

// ─── Format context for LLM system prompt ────────────────────────────────────
function formatContextForPrompt(userId: string | number, messageLimit = 20): string {
  const ctx = getContext(userId, messageLimit);
  const lines: string[] = [];

  const now = new Date().toLocaleString("es-CO", { timeZone: TIMEZONE });
  lines.push(`Fecha y hora actual: ${now} (${TIMEZONE})`);

  if (ctx.facts.length > 0) {
    lines.push("\n## Hechos conocidos del usuario:");
    ctx.facts.forEach((f) => {
      lines.push(`- ${f.key}: ${f.value}${f.confidence && f.confidence < 1 ? ` (confianza: ${f.confidence})` : ""}`);
    });
  }

  if (ctx.recent_messages.length > 0) {
    lines.push("\n## Historial reciente:");
    ctx.recent_messages.forEach((m) => {
      const label = m.role === "user" ? "Usuario" : "JARVIS";
      lines.push(`${label}: ${m.content}`);
    });
  }

  return lines.join("\n");
}

// ─── Legacy/Placeholders ─────────────────────────────────────────────────────
function auditLog(action: string, _payload?: unknown, userId?: string | number, status: "ok" | "error" = "ok"): void {
  console.log(`[AUDIT] ${action} | User: ${userId} | Status: ${status}`);
}

function upsertCapital(asset: string, amount: number, _source?: string): void {
  console.log(`[CAPITAL] Mock update for ${asset}: ${amount}`);
}

// ─── Fix 3: Export as const object ───────────────────────────────────────────
export const memoryService = {
  // Messages
  addMessage,
  saveMessage: addMessage, // Alias para compatibilidad
  getMessages,
  getHistory: getMessages, // Alias para compatibilidad
  getLatestSummary,
  pruneMessages,
  countMessages,

  // Facts
  upsertFact,
  setFact: upsertFact,     // Alias para compatibilidad
  getFact,
  getAllFacts,
  deleteFact,
  clearFacts,

  // Tasks
  saveTask,
  getTasks,

  // Context
  getContext,
  formatContextForPrompt,

  // Facts extraction
  extractAndSaveFacts,

  // Message compression
  compressOldMessages,

  // Response reflection
  reflectOnResponse,

  // Episodes (episodic memory)
  saveEpisode,
  searchEpisodes,

  // Misc
  auditLog,
  upsertCapital
} as const;
