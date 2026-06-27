-- Retenção de logs configurável por servidor.
--
-- Antes, a retenção era fixa em 14 dias pra TODOS os servidores via
-- add_retention_policy do TimescaleDB (job que dropa chunks inteiros da
-- hypertable 'logs'), e o ingest também rejeitava qualquer entrada com mais
-- de 14 dias na chegada. Isso não dá pra cobrir casos onde um servidor
-- precisa guardar logs por mais tempo (ex: compliance, auditoria) e outro
-- precisa de bem menos (ex: ambiente de teste).
--
-- TimescaleDB não tem retenção por linha/coluna — add_retention_policy só
-- droppa chunk inteiro (todos os servidores misturados no mesmo chunk de
-- tempo). Então a estratégia agora é:
--   1. retention_days por servidor, configurável na criação/edição.
--   2. Um job da aplicação (LogsService.purgeExpiredLogs, @Cron) roda de
--      hora em hora e faz DELETE per-server respeitando o valor de cada um.
--   3. A política do TimescaleDB deixa de ser o mecanismo de enforcement e
--      passa a ser só uma rede de segurança: dropa chunks com mais de 400
--      dias (bem acima do máximo permitido de 365) pra garantir que nada
--      fique acumulando pra sempre se o job da aplicação falhar.

ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS retention_days integer NOT NULL DEFAULT 14
    CHECK (retention_days BETWEEN 1 AND 365);

COMMENT ON COLUMN servers.retention_days IS
  'Dias de retenção de logs deste servidor. Enforced pelo cron LogsService.purgeExpiredLogs; a retention_policy do TimescaleDB é só rede de segurança (400 dias).';

SELECT remove_retention_policy('logs', if_exists => true);
SELECT add_retention_policy(
  'logs',
  interval '400 days',
  schedule_interval => interval '6 hours',
  if_not_exists => true
);
