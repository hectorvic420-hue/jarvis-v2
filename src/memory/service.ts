import { db } from "./db";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Role = "user" | "assistant" | "system";

export interface Message {
  id: number;
  role: Role;
  content: string;
  user_id: number;
  ts: number;
}

export interface Fact {
  id: number;
  key: string;
  value: string;
  updated: number;
}

export interface AuditEntry {
  id: number;
  action: string;
  payload: string | null;
  user_id: number | null;
  status: "ok" | "error";
  ts: number;
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export function saveMessage(role: Role, content: string, userId: number): void {
  db.prepare(
    `INSERT INTO messages (role, content, user_id) VALUES (?, ?, ?)`
  ).run(role, content, userId);
}

export function getHistory(userId: number, limit = 20): Message[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE user_id = ?
       ORDER BY ts DESC
       LIMIT ?`
    )
    .all(userId, limit)
    .reverse() as Message[];
}

export function clearHistory(userId: number): void {
  db.prepare(`DELETE FROM messages WHERE user_id = ?`).run(userId);
}

export function countMessages(userId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM messages WHERE user_id = ?`)
    .get(userId) as { n: number };
  return row.n;
}

// ─── Facts (memoria permanente) ───────────────────────────────────────────────

export function setFact(key: string, value: string): void {
  db.prepare(
    `INSERT INTO facts (key, value, updated)
     VALUES (?, ?, strftime('%s','now'))
     ON CONFLICT(key) DO UPDATE
       SET value   = excluded.value,
           updated = excluded.updated`
  ).run(key, value);
}

export function getFact(key: string): string | null {
  const row = db
    .prepare(`SELECT value FROM facts WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getAllFacts(): Fact[] {
  return db
    .prepare(`SELECT * FROM facts ORDER BY key`)
    .all() as Fact[];
}

export function deleteFact(key: string): boolean {
  const result = db
    .prepare(`DELETE FROM facts WHERE key = ?`)
    .run(key);
  return result.changes > 0;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export function auditLog(
  action: string,
  payload?: unknown,
  userId?: number,
  status: "ok" | "error" = "ok"
): void {
  db.prepare(
    `INSERT INTO audit_log (action, payload, user_id, status)
     VALUES (?, ?, ?, ?)`
  ).run(
    action,
    payload !== undefined ? JSON.stringify(payload) : null,
    userId ?? null,
    status
  );
}

export function getAuditLog(limit = 50): AuditEntry[] {
  return db
    .prepare(`SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?`)
    .all(limit) as AuditEntry[];
}

// ─── Capital ──────────────────────────────────────────────────────────────────

export function upsertCapital(asset: string, amount: number, source?: string): void {
  db.prepare(
    `INSERT INTO capital_state (asset, amount, source, updated)
     VALUES (?, ?, ?, strftime('%s','now'))
     ON CONFLICT DO NOTHING`
  ).run(asset, amount, source ?? null);

  db.prepare(
    `UPDATE capital_state
     SET amount = ?, source = ?, updated = strftime('%s','now')
     WHERE asset = ?`
  ).run(amount, source ?? null, asset);
}

export function getCapital(): { asset: string; amount: number; source: string | null }[] {
  return db
    .prepare(`SELECT asset, amount, source FROM capital_state ORDER BY asset`)
    .all() as { asset: string; amount: number; source: string | null }[];
}
