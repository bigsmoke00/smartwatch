-- Migration 005: correções necessárias para os bugs reportados
-- Idempotente.

-- ===== Soft delete em servers =====
ALTER TABLE servers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS servers_deleted_at_idx ON servers(deleted_at);

-- ===== FKs faltantes com ON DELETE CASCADE =====
-- host_metrics não tinha FK nem cascade -> métricas órfãs ao deletar server
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name='host_metrics_server_fk') THEN
    ALTER TABLE host_metrics
      ADD CONSTRAINT host_metrics_server_fk
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE;
  END IF;
END $$;

-- containers já tem FK CASCADE (ok)

-- logs: hypertable, FK não recomendado em hyper. Limpamos via DELETE no service.

-- terminal_sessions, script_files, script_executions: já têm FK ou são limpos pelo service.

-- ===== Cache de features detectadas em cada cluster PG =====
CREATE TABLE IF NOT EXISTS pg_cluster_features (
  cluster_id          uuid PRIMARY KEY REFERENCES pg_clusters(id) ON DELETE CASCADE,
  has_pg_stat_statements boolean NOT NULL DEFAULT false,
  has_pg_buffercache  boolean NOT NULL DEFAULT false,
  has_pg_repack       boolean NOT NULL DEFAULT false,
  pg_version          text,
  is_in_recovery      boolean,
  detected_at         timestamptz NOT NULL DEFAULT now(),
  last_error          text
);

-- ===== Sync runs (auditoria de cloud sync) =====
CREATE TABLE IF NOT EXISTS cloud_sync_runs (
  ts            timestamptz NOT NULL DEFAULT now(),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  cloud         text        NOT NULL CHECK (cloud IN ('aws','oci','gcp','azure')),
  account       text,
  region        text,
  resource_type text        NOT NULL,           -- ec2, rds, iam, s3, vpc, ...
  status        text        NOT NULL CHECK (status IN ('running','ok','partial','error')),
  discovered    int         NOT NULL DEFAULT 0,
  errors        jsonb,
  duration_ms   int,
  triggered_by  text,                            -- user id ou 'cron'
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('cloud_sync_runs','ts',
  chunk_time_interval => interval '14 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS sync_runs_cloud_account_idx
  ON cloud_sync_runs(cloud, account, ts DESC);

-- ===== Cloud accounts (multi-account com credenciais por conta) =====
CREATE TABLE IF NOT EXISTS cloud_accounts (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cloud         text        NOT NULL CHECK (cloud IN ('aws','oci','gcp','azure')),
  alias         text        NOT NULL,
  account_id    text        NOT NULL,                -- 12-digit AWS / OCID OCI
  vault_secret  text        NOT NULL,                -- nome no vault: { accessKeyId, secretAccessKey }
  default_region text,
  enabled       boolean     NOT NULL DEFAULT true,
  last_sync_at  timestamptz,
  last_sync_status text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE(cloud, account_id)
);

-- ===== Inventário cloud (resultado da sincronização) =====
CREATE TABLE IF NOT EXISTS cloud_resources (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid        NOT NULL REFERENCES cloud_accounts(id) ON DELETE CASCADE,
  cloud         text        NOT NULL,
  region        text,
  resource_type text        NOT NULL,        -- ec2, rds, ...
  resource_id   text        NOT NULL,        -- arn ou id
  name          text,
  state         text,
  metadata      jsonb       NOT NULL DEFAULT '{}',
  tags          jsonb       NOT NULL DEFAULT '{}',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  UNIQUE(cloud, account_id, resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS cloud_res_account_idx ON cloud_resources(account_id, resource_type);
CREATE INDEX IF NOT EXISTS cloud_res_active_idx ON cloud_resources(removed_at) WHERE removed_at IS NULL;
