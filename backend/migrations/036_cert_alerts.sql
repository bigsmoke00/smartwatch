-- Migration 036: alerta de vencimento de certificados.
-- Config por alvo (dias de antecedência + canais) e dedup por not_after.
ALTER TABLE cert_targets ADD COLUMN IF NOT EXISTS alert_days     int    NOT NULL DEFAULT 30;
ALTER TABLE cert_targets ADD COLUMN IF NOT EXISTS alert_channels uuid[] NOT NULL DEFAULT '{}';
-- Guarda o not_after para o qual já alertamos, para não repetir a cada varredura
-- (quando o cert é renovado, o not_after muda e o alerta volta a valer).
ALTER TABLE cert_files   ADD COLUMN IF NOT EXISTS alerted_not_after timestamptz;
