import Database, { type Database as DB } from "better-sqlite3";
import path from "path";
import fs from "fs";
import { env } from "../config/env";

// Garantiza que el directorio exista (disco persistente en GCP)
const dbDir = path.dirname(env.DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db: DB = new Database(env.DB_PATH);

// Pragmas de rendimiento y seguridad
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

db.exec(`
  -- Historial de conversación por usuario
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT    NOT NULL CHECK(role IN ('user','assistant','system')),
    content   TEXT    NOT NULL,
    user_id   INTEGER NOT NULL,
    ts        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Registro de auditoría de acciones
  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    action    TEXT    NOT NULL,
    payload   TEXT,
    user_id   INTEGER,
    status    TEXT    NOT NULL DEFAULT 'ok',
    ts        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Estado de capital por asset
  CREATE TABLE IF NOT EXISTS capital_state (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    asset     TEXT    NOT NULL,
    amount    REAL    NOT NULL,
    source    TEXT,
    updated   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Historial de trades
  CREATE TABLE IF NOT EXISTS trade_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol    TEXT    NOT NULL,
    side      TEXT    NOT NULL CHECK(side IN ('buy','sell')),
    qty       REAL    NOT NULL,
    price     REAL    NOT NULL,
    pnl       REAL    DEFAULT 0,
    ts        INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Memoria permanente (nunca se borra automáticamente)
  CREATE TABLE IF NOT EXISTS facts (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    key       TEXT    NOT NULL UNIQUE,
    value     TEXT    NOT NULL,
    updated   INTEGER NOT NULL DEFAULT (strftime('%s','now'))
  );

  -- Índices
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_ts   ON messages(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_ts      ON audit_log(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_facts_key     ON facts(key);
`);

console.log(`✅ DB lista: ${env.DB_PATH}`);
