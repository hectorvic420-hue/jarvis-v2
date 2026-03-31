import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.resolve(process.env.DB_PATH || "./data/jarvis.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_orders (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

export interface PendingOrder {
  id: string;
  chatId: string;
  tool: string;
  action: string;
  payload: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutos

export function savePendingOrder(
  id: string,
  chatId: string,
  tool: string,
  action: string,
  payload: Record<string, unknown>
): PendingOrder {
  const now = Date.now();
  const order: PendingOrder = {
    id,
    chatId,
    tool,
    action,
    payload,
    createdAt: now,
    expiresAt: now + TTL_MS,
  };

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_orders
       (id, chat_id, tool, action, payload, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, chatId, tool, action, JSON.stringify(payload), now, order.expiresAt);

  return order;
}

export function getPendingOrder(id: string): PendingOrder | null {
  const row = getDb()
    .prepare("SELECT * FROM pending_orders WHERE id = ?")
    .get(id) as any;

  if (!row) return null;

  if (Date.now() > row.expires_at) {
    deletePendingOrder(id);
    return null;
  }

  return {
    id: row.id,
    chatId: row.chat_id,
    tool: row.tool,
    action: row.action,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function getPendingOrderByChatId(chatId: string): PendingOrder | null {
  const row = getDb()
    .prepare(
      "SELECT * FROM pending_orders WHERE chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(chatId, Date.now()) as any;

  if (!row) return null;

  return {
    id: row.id,
    chatId: row.chat_id,
    tool: row.tool,
    action: row.action,
    payload: JSON.parse(row.payload),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function deletePendingOrder(id: string): void {
  getDb().prepare("DELETE FROM pending_orders WHERE id = ?").run(id);
}

export function cleanExpiredOrders(): number {
  const result = getDb()
    .prepare("DELETE FROM pending_orders WHERE expires_at <= ?")
    .run(Date.now());
  return result.changes;
}
