-- Suporte a busca por call UUID (integração Unity/FreeSWITCH).
--
-- Contexto: um cliente tem um servidor FreeSWITCH (Unity) cujo log de trace
-- de dialplan/chamada é extremamente verboso (~10MB por rotação, a cada
-- poucos minutos) e a maioria das linhas começa com o UUID da chamada como
-- primeiro token. O objetivo é colar um call UUID e ver todas as linhas
-- daquela chamada.
--
-- Decisão de arquitetura: em vez de criar uma tabela/módulo novo, reaproveita
-- a hypertable `logs` já existente (mesma retenção, FTS/ILIKE, WS de tail),
-- só com mais um campo estruturado (call_uuid) extraído no backend a partir
-- da mensagem crua (ver LogsService.ingest) — o agent continua mandando a
-- linha exatamente como está hoje, sem nenhuma mudança de código.
--
-- Como o volume desse servidor é MUITO maior que o resto da frota, a cota de
-- linhas armazenadas/minuto (hoje só uma env global) ganha um override
-- opcional por servidor.

ALTER TABLE logs ADD COLUMN IF NOT EXISTS call_uuid uuid;

-- Índice parcial (só linhas com call_uuid) — mantém pequeno e rápido mesmo
-- com o volume alto do FreeSWITCH; ORDER BY ts DESC já embutido pra bater
-- direto com a query de "todas as linhas dessa chamada, mais recentes primeiro".
CREATE INDEX IF NOT EXISTS idx_logs_call_uuid_ts
  ON logs (call_uuid, ts DESC)
  WHERE call_uuid IS NOT NULL;

ALTER TABLE servers ADD COLUMN IF NOT EXISTS log_rate_limit_per_minute integer;

COMMENT ON COLUMN servers.log_rate_limit_per_minute IS
  'Override opcional (por servidor) do teto de linhas de log ARMAZENADAS por minuto (NULL = usa o default global LOGWATCH_MAX_STORED_ROWS_PER_MINUTE). Pensado para fontes de altíssimo volume, como o trace de dialplan do FreeSWITCH/Unity.';
