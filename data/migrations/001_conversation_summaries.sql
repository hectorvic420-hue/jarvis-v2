-- migration_001_conversation_summaries.sql
-- Añade metadata, updated_at, índices y trigger a conversation_summaries
-- Seguro de re-ejecutar (IF NOT EXISTS / ignorar errores de columna duplicada)

-- Nuevas columnas (fallan silenciosamente si ya existen en SQLite)
ALTER TABLE conversation_summaries ADD COLUMN metadata TEXT;
ALTER TABLE conversation_summaries ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

-- Índices
CREATE INDEX IF NOT EXISTS idx_summaries_user    ON conversation_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON conversation_summaries(created_at);

-- Trigger para updated_at automático
CREATE TRIGGER IF NOT EXISTS trg_summaries_updated
AFTER UPDATE ON conversation_summaries
BEGIN
  UPDATE conversation_summaries SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Verificar resultado
SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_summaries';
