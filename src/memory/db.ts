import Database, { Database as DatabaseType } from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";

const DB_DIR  = process.env.DB_DIR || "./data/db";
const DB_PATH = path.join(DB_DIR, "jarvis.db");

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db: DatabaseType = new Database(DB_PATH);

// ─── Pragmas ──────────────────────────────────────────────────────────────────
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");

// ─── Migrations ───────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content     TEXT    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'telegram',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_user_created ON messages(user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS facts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    confidence  REAL    NOT NULL DEFAULT 1.0,
    source      TEXT    NOT NULL DEFAULT 'inferred',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_facts_user_id ON facts(user_id);
  CREATE INDEX IF NOT EXISTS idx_facts_user_key ON facts(user_id, key);

  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT    NOT NULL,
    title       TEXT    NOT NULL,
    description TEXT,
    status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending', 'in_progress', 'done', 'cancelled')),
    priority    INTEGER NOT NULL DEFAULT 2,
    due_at      TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);

  CREATE TABLE IF NOT EXISTS landings (
    slug         TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    style        TEXT NOT NULL DEFAULT 'futuristic',
    checkout_url TEXT,
    pixel_id     TEXT,
    ga_id        TEXT,
    html_path    TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    views        INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_landings_created ON landings(created_at);

  CREATE TABLE IF NOT EXISTS self_repair_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now')),
    action        TEXT NOT NULL,
    file_patched  TEXT,
    backup_path   TEXT,
    error_summary TEXT,
    fix_summary   TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT UNIQUE,
    user_id TEXT NOT NULL,
    input_preview TEXT,
    iterations INTEGER DEFAULT 0,
    tools_used TEXT DEFAULT '[]',
    provider TEXT,
    status TEXT DEFAULT 'unknown',
    warning TEXT,
    duration_ms INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id);
  CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
`);

// ─── Graceful Shutdown ─────────────────────────────────────────────────────────
function closeDb(): void {
  try {
    db.close();
    console.log("[DB] Conexión cerrada correctamente");
  } catch (err) {
    console.error("[DB] Error al cerrar conexión:", err);
  }
}

export default db;
export { closeDb };
