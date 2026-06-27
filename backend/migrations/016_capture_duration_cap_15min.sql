-- Captura SIP/RTP/tcpdump: teto de duração baixou de 30min pra 15min.
--
-- Motivo: o agent tinha um limite de TAMANHO (50MB) que, em capturas longas
-- num proxy SIP movimentado, batia antes do tempo configurado terminar — e
-- isso virava status='failed' pro usuário, mesmo a captura tendo rodado
-- "certinha" até ali. Decisão: o limite que deve valer é TEMPO, não bytes.
-- A partir de agora:
--   - 15 minutos (900s) é o teto real de duração de uma captura.
--   - o limite de bytes (subiu pra 500MB, ver agent/src/capture.ts) passou a
--     ser só uma rede de segurança contra disco/memória, e não é mais
--     tratado como falha — só encerra a captura mais cedo com o que já tinha.
--
-- Precisa ficar em sincronia com:
--   - MAX_DURATION_SECONDS em agent/src/capture.ts
--   - @Max(900) em RequestCaptureDto.durationSeconds (backend/src/capture/capture.module.ts)
--   - clamp no frontend (frontend/app/captures/page.tsx)

-- Sessões antigas com duration_seconds > 900 (pedidas sob a regra anterior de
-- 30min) violariam o novo CHECK — normaliza pro novo teto antes de trocar a
-- constraint, senão o ALTER TABLE falha.
UPDATE capture_sessions SET duration_seconds = 900 WHERE duration_seconds > 900;

ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_duration_seconds_check;
ALTER TABLE capture_sessions ADD CONSTRAINT capture_sessions_duration_seconds_check
  CHECK (duration_seconds BETWEEN 5 AND 900);
