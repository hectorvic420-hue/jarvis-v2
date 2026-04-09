// Importar la instancia única de db desde memory/db.ts para evitar corrupción
import db from "../memory/db.js";

// Inicializar tabla pending_orders
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
  CREATE INDEX IF NOT EXISTS idx_pending_chat_expires ON pending_orders(chat_id, expires_at);
`);

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

  db.prepare(
    `INSERT OR REPLACE INTO pending_orders
     (id, chat_id, tool, action, payload, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, chatId, tool, action, JSON.stringify(payload), now, order.expiresAt);

  return order;
}

export function getPendingOrder(id: string): PendingOrder | null {
  const row = db
    .prepare("SELECT * FROM pending_orders WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return null;

  if (Date.now() > (row.expires_at as number)) {
    deletePendingOrder(id);
    return null;
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload as string);
  } catch {
    payload = {};
  }

  return {
    id: row.id as string,
    chatId: row.chat_id as string,
    tool: row.tool as string,
    action: row.action as string,
    payload,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
  };
}

export function getPendingOrderByChatId(chatId: string): PendingOrder | null {
  const row = db
    .prepare("SELECT * FROM pending_orders WHERE chat_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .get(chatId, Date.now()) as Record<string, unknown> | undefined;

  if (!row) return null;

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload as string);
  } catch {
    payload = {};
  }

  return {
    id: row.id as string,
    chatId: row.chat_id as string,
    tool: row.tool as string,
    action: row.action as string,
    payload,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
  };
}

export function deletePendingOrder(id: string): void {
  db.prepare("DELETE FROM pending_orders WHERE id = ?").run(id);
}

export function cleanExpiredOrders(): number {
  const result = db
    .prepare("DELETE FROM pending_orders WHERE expires_at <= ?")
    .run(Date.now());
  return result.changes;
}

// Limpiar órdenes expiradas periódicamente (cada 5 minutos)
setInterval(cleanExpiredOrders, 5 * 60 * 1000);
