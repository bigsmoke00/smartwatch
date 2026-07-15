-- Remove `pg_table_health` — write-only, 118GB de puro desperdício.
--
-- Auditoria de espaço em disco pedida pelo usuário (2026-07-15): a
-- hypertable `pg_table_health` (criada em 004_modules_5.sql) era escrita a
-- cada poll do PgMonitorService (pollCluster(), gatilho *_/10 * * * * *
-- cron, na prática a cada `poll_seconds` — default 10s) — uma linha por
-- TABELA de cada database de cada cluster monitorado. Confirmado (grep no
-- backend/frontend inteiro) que NADA NUNCA leu essa tabela: a tela "Saúde"
-- usa collectTableHealth()/tableHealth() (outro código, mais recente), que
-- consulta pg_stat_user_tables AO VIVO no cluster monitorado e cacheia o
-- resultado no Redis — nunca tocou nesta tabela SQL. O INSERT morto (nunca
-- removido quando a tela migrou pro Redis) rodava sem parar desde a criação
-- e sozinho chegou a 118GB nesta instância, sem NENHUM consumidor.
--
-- O código que fazia o INSERT foi removido em pg-monitor.service.ts (ver
-- comentário no lugar). Esta migration:
--   1. Remove a retention_policy adicionada por engano em
--      029_missing_retention_policies.sql (a tabela deixa de existir, não
--      faz sentido ter política de retenção nela).
--   2. DROP TABLE — ao contrário de DELETE, devolve os 118GB ao SO
--      IMEDIATAMENTE, sem precisar de VACUUM depois (é a hypertable
--      inteira, todos os chunks, de uma vez).
--
-- Se um dia for reintroduzido um histórico de bloat por tabela, crie de
-- novo do zero com um consumidor real (endpoint + tela) definido ANTES de
-- ligar a escrita — não reintroduzir só o INSERT.

SELECT remove_retention_policy('pg_table_health', if_exists => true);
DROP TABLE IF EXISTS pg_table_health;
