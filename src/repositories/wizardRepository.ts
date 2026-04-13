// src/repositories/wizardRepository.ts
// Persiste el estado del wizard de landing en SQLite (tabla wizard_states)
// reemplazando el WIZARD_MAP en memoria que se perdía al reiniciar PM2.

import db from "../memory/db.js";

export interface WizardRow {
  userId:    string;
  step:      number;
  channel:   "whatsapp" | "telegram";
  data:      Record<string, any>;
  startedAt: number;
}

const stmts = {
  get: db.prepare(`
    SELECT user_id, step, data
    FROM wizard_states
    WHERE user_id = ?
      AND (expires_at IS NULL OR expires_at > datetime('now'))
  `),

  upsert: db.prepare(`
    INSERT INTO wizard_states (user_id, step, data, expires_at)
    VALUES (?, ?, ?, datetime('now', '+30 minutes'))
    ON CONFLICT(user_id) DO UPDATE SET
      step       = excluded.step,
      data       = excluded.data,
      expires_at = excluded.expires_at,
      updated_at = CURRENT_TIMESTAMP
  `),

  delete: db.prepare(`DELETE FROM wizard_states WHERE user_id = ?`),

  pruneExpired: db.prepare(`DELETE FROM wizard_states WHERE expires_at < datetime('now')`),
};

export function getWizard(userId: string): WizardRow | undefined {
  const row = stmts.get.get(userId) as { user_id: string; step: number; data: string } | undefined;
  if (!row) return undefined;

  let parsed: any = {};
  try { parsed = JSON.parse(row.data); } catch { /* corrupt row — treat as missing */ return undefined; }

  return {
    userId,
    step:      row.step,
    channel:   parsed.channel ?? "telegram",
    data:      parsed.data   ?? {},
    startedAt: parsed.startedAt ?? Date.now(),
  };
}

export function saveWizard(state: WizardRow): void {
  stmts.upsert.run(
    state.userId,
    state.step,
    JSON.stringify({ channel: state.channel, data: state.data, startedAt: state.startedAt }),
  );
}

export function removeWizard(userId: string): void {
  stmts.delete.run(userId);
}

export function pruneExpiredWizards(): void {
  stmts.pruneExpired.run();
}
