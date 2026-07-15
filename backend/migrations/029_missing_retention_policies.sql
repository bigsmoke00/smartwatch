-- Retenção faltando em hypertables ativas.
--
-- Auditoria pedida pelo usuário ("espaço só aumenta e não vejo voltar"):
-- revisei TODAS as hypertables do schema (grep por create_hypertable em
-- todas as migrations 001-028) contra quem tem add_retention_policy nativa
-- OU um purge a nível de aplicação (como logs/LogsService.purgeExpiredLogs).
-- Achei hypertables ATIVAS (recebendo INSERT hoje) sem NENHUM mecanismo de
-- retenção — cresciam pra sempre, sem chance de o espaço "voltar" porque
-- não há o que descartar:
--
--   * alert_events            — 1 linha por disparo de alert rule
--                                (AlertsService, @Cron EVERY_MINUTE avalia
--                                regras; sem retenção desde a criação em
--                                001_init.sql).
--   * pg_table_health         — 1 linha por tabela por cluster PG monitorado,
--                                a cada 30min (PgMonitorService.refreshAllTableHealth).
--   * credential_rotation_events — 1 linha por tick do scheduler de rotação
--                                (mesmo quando é só o evento simulado documentado
--                                em "Limitações conhecidas" do README).
--   * log_export_runs         — 1 linha por execução de export agendado.
--
-- NÃO mexi em terraform_runs/bastion_sessions/automation_runs: são schema
-- morto (nenhum módulo NestJS ativo escreve neles hoje — ver "Limitações
-- conhecidas" do README principal). Sem escrita ativa, não contribuem pro
-- crescimento e adicionar retenção ali seria só ruído. Se algum dia esses
-- módulos forem implementados, adicionar a política junto.

SELECT add_retention_policy('alert_events', interval '180 days', if_not_exists => true);
SELECT add_retention_policy('pg_table_health', interval '90 days', if_not_exists => true);
SELECT add_retention_policy('credential_rotation_events', interval '180 days', if_not_exists => true);
SELECT add_retention_policy('log_export_runs', interval '180 days', if_not_exists => true);
