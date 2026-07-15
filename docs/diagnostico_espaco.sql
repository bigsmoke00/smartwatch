-- ============================================================
-- 1) Tamanho REAL por hypertable (o \dt+ mente pra hypertable —
--    mostra só a tabela "pai", os dados de verdade estão em chunks
--    dentro de _timescaledb_internal). Isto revela ONDE estão os 126GB.
-- ============================================================
SELECT hypertable_name,
       pg_size_pretty(hypertable_size(format('%I.%I','public',hypertable_name)::regclass)) AS total_size
FROM timescaledb_information.hypertables
ORDER BY hypertable_size(format('%I.%I','public',hypertable_name)::regclass) DESC;

-- ============================================================
-- 2) Chunks da hypertable que aparecer maior acima — troque 'logs' se
--    outra tabela vencer no passo 1. is_compressed=false num chunk ANTIGO
--    (range_end no passado) é o sintoma exato de "DELETE descomprimiu e
--    ninguém recomprimiu de volta" (bloat 5-20x, nunca reclamado).
-- ============================================================
SELECT * FROM chunks_detailed_size('logs') ORDER BY total_bytes DESC LIMIT 25;

-- ============================================================
-- 3) Saúde dos jobs automáticos do TimescaleDB (compressão + retenção
--    nativa). total_failures alto ou last_run_status='Failed' explica o
--    "não volta o espaço" de cara.
-- ============================================================
SELECT j.hypertable_name, j.proc_name, js.last_run_status,
       js.last_successful_finish, js.total_runs, js.total_failures
FROM timescaledb_information.jobs j
LEFT JOIN timescaledb_information.job_stats js ON js.job_id = j.job_id
WHERE j.hypertable_name IS NOT NULL
ORDER BY js.total_failures DESC NULLS LAST, j.hypertable_name;

-- ============================================================
-- 4) Slots de replicação presos (retêm WAL/dados antigos indefinidamente
--    se "active=false" ou "retained_wal" gigante) — causa clássica de
--    "espaço nunca volta" que não tem nada a ver com retenção de app.
-- ============================================================
SELECT slot_name, active, slot_type,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained_wal
FROM pg_replication_slots;

-- ============================================================
-- 5) Transações penduradas há muito tempo (impedem vacuum/drop_chunks de
--    liberar espaço mesmo quando a política roda certinho).
-- ============================================================
SELECT pid, state, now() - xact_start AS xact_age, left(query, 100) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start ASC
LIMIT 10;

-- ============================================================
-- 6) Retenção configurada por servidor — servidores com retention_days
--    MENOR que o máximo da frota são exatamente os que passam pelo
--    caminho de DELETE (bloat-prone) em vez de drop_chunks (imediato).
-- ============================================================
SELECT name, retention_days, log_rate_limit_per_minute
FROM servers
ORDER BY retention_days;
