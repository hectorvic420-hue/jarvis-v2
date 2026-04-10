// src/db/migrations.ts
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'create_conversation_summaries',
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_user ON conversation_summaries(user_id);
      CREATE INDEX IF NOT EXISTS idx_summaries_created ON conversation_summaries(created_at);
    `
  },
  {
    version: 2,
    name: 'create_wizard_states',
    sql: `
      CREATE TABLE IF NOT EXISTS wizard_states (
        user_id TEXT PRIMARY KEY,
        step INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL DEFAULT '{}',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_wizard_expires ON wizard_states(expires_at);
    `
  },
  {
    version: 3,
    name: 'create_rate_limit_audit',
    sql: `
      CREATE TABLE IF NOT EXISTS rate_limit_violations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        attempted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_violations_user ON rate_limit_violations(user_id);
      CREATE INDEX IF NOT EXISTS idx_violations_time ON rate_limit_violations(attempted_at);
    `
  }
];

export class MigrationManager {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.initMigrationTable();
  }

  private initMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        name TEXT NOT NULL
      )
    `);
  }

  getCurrentVersion(): number {
    const row = this.db.prepare('SELECT MAX(version) as version FROM schema_migrations').get() as any;
    return row?.version || 0;
  }

  migrate(): void {
    const currentVersion = this.getCurrentVersion();
    console.log(`[DB] Versión actual: ${currentVersion}`);

    for (const migration of MIGRATIONS) {
      if (migration.version > currentVersion) {
        console.log(`[DB] Aplicando migración ${migration.version}: ${migration.name}`);

        try {
          this.db.exec(migration.sql);
          this.db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
            .run(migration.version, migration.name);

          console.log(`[DB] ✅ Migración ${migration.version} aplicada`);
        } catch (err) {
          console.error(`[DB] ❌ Error en migración ${migration.version}:`, err);
          throw err;
        }
      }
    }

    const newVersion = this.getCurrentVersion();
    if (newVersion > currentVersion) {
      console.log(`[DB] Migración completa. Nueva versión: ${newVersion}`);
    } else {
      console.log('[DB] No hay migraciones pendientes');
    }
  }

  rollback(steps: number = 1): void {
    // Implementar si es necesario
    console.warn('[DB] Rollback no implementado');
  }

  close(): void {
    this.db.close();
  }
}

// Uso en index.ts al iniciar
export function runMigrations(dbPath: string): void {
  const manager = new MigrationManager(dbPath);
  try {
    manager.migrate();
  } finally {
    manager.close();
  }
}
