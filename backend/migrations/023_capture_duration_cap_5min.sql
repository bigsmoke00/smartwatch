-- Captura SIP/RTP/tcpdump: teto de duração baixou de 15min (900s) para 5min
-- (300s), a pedido. A captura fecha sozinha ao bater esse tempo.
--
-- Precisa ficar em sincronia com:
--   - MAX_DURATION_SECONDS em agent/src/capture.ts
--   - @Max(300) em RequestCaptureDto.durationSeconds (capture.module.ts)
--   - este CHECK constraint
--
-- Sessões antigas pedidas sob a regra anterior (>300) são normalizadas pra
-- caber no novo teto.
UPDATE capture_sessions SET duration_seconds = 300 WHERE duration_seconds > 300;

ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_duration_seconds_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_duration_seconds_check
  CHECK (duration_seconds BETWEEN 5 AND 300);
