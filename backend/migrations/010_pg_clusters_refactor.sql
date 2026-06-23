-- ============================================================
-- Refatoração do módulo PostgreSQL Monitor: soft delete em pg_clusters
-- (mesmo padrão usado em patroni_clusters), pra permitir remover um
-- cluster sem perder o histórico em pg_metrics/pg_top_queries/pg_table_health
-- (que referenciam cluster_id sem FK) e sem quebrar consultas históricas.
-- ============================================================
ALTER TABLE pg_clusters ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS pg_clusters_active_idx ON pg_clusters(deleted_at) WHERE deleted_at IS NULL;
