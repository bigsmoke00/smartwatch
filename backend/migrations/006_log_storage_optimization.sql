-- Reduz a amplificacao de armazenamento dos logs.
--
-- Antes, cada mensagem era mantida como texto, tsvector e em dois indices GIN.
-- Para streams intensos, os indices podiam ocupar varias vezes o dado original.

ALTER TABLE logs
  ADD COLUMN IF NOT EXISTS repeat_count integer NOT NULL DEFAULT 1;

DROP TRIGGER IF EXISTS logs_fts_tg ON logs;
DROP FUNCTION IF EXISTS logs_fts_trigger();
DROP INDEX IF EXISTS logs_fts_idx;
DROP INDEX IF EXISTS logs_message_trgm_idx;
DROP INDEX IF EXISTS logs_level_ts_idx;
ALTER TABLE logs DROP COLUMN IF EXISTS fts;

-- O histograma passa a ser calculado sob demanda e respeita repeat_count.
-- Remover o continuous aggregate evita uma segunda copia do volume de logs.
DROP MATERIALIZED VIEW IF EXISTS logs_per_min CASCADE;

-- Chunks menores liberam e comprimem espaco mais cedo.
SELECT set_chunk_time_interval('logs', interval '6 hours');

SELECT remove_compression_policy('logs', if_exists => true);
SELECT add_compression_policy(
  'logs',
  interval '6 hours',
  schedule_interval => interval '1 hour',
  if_not_exists => true
);

-- Retencao operacional padrao: 14 dias.
SELECT remove_retention_policy('logs', if_exists => true);
SELECT add_retention_policy(
  'logs',
  interval '14 days',
  schedule_interval => interval '1 hour',
  if_not_exists => true
);
SELECT drop_chunks('logs', older_than => interval '14 days');
