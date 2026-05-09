-- Migration 004: Script Manager + Log Downloader + Zero Trust + PG Monitor + Topologia
-- Idempotente. Adiciona ~30 permissions novas ao catálogo existente.

-- ============================================================
-- Permissões novas (5 módulos)
-- ============================================================
INSERT INTO permissions(key, description, category) VALUES
  -- Scripts (Module 1)
  ('scripts:read',     'Listar arquivos e ler conteúdo',         'scripts'),
  ('scripts:write',    'Criar/editar arquivos',                  'scripts'),
  ('scripts:execute',  'Executar scripts em servidores',         'scripts'),
  ('scripts:approve',  'Aprovar execuções em produção',          'scripts'),
  -- Log downloader (Module 2)
  ('logs:download',    'Baixar logs em massa (export)',          'logs'),
  ('logs:schedule',    'Agendar exports automáticos',            'logs'),
  -- Zero Trust (Module 3)
  ('terminal:request', 'Solicitar acesso a terminal web',        'zero_trust'),
  ('terminal:approve', 'Aprovar sessões de terminal',            'zero_trust'),
  ('terminal:open',    'Abrir terminal aprovado',                'zero_trust'),
  ('runbook:read',     'Ver runbooks',                           'zero_trust'),
  ('runbook:write',    'Criar/editar runbooks',                  'zero_trust'),
  ('runbook:execute',  'Executar runbooks pré-aprovados',        'zero_trust'),
  ('bastion:read',     'Ver registros de SSH bastion',           'zero_trust'),
  -- PostgreSQL Monitor (Module 4)
  ('pg:read',          'Ver dashboards de Postgres',             'database'),
  ('pg:write',         'Configurar conexões a clusters',         'database'),
  ('pg:terminate',     'Matar queries (pg_terminate_backend)',   'database'),
  ('pg:explain',       'Rodar EXPLAIN em queries',               'database'),
  -- Topologia (Module 5)
  ('topology:read',    'Ver mapa topológico',                    'topology'),
  ('topology:write',   'Editar relações manuais',                'topology')
ON CONFLICT (key) DO NOTHING;

-- Adiciona permissões aos roles padrão
DO $$
DECLARE
  rid uuid;
BEGIN
  -- Super Admin: tudo
  SELECT id INTO rid FROM roles WHERE name='Super Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key)
    SELECT rid, key FROM permissions
    WHERE key IN (
      'scripts:read','scripts:write','scripts:execute','scripts:approve',
      'logs:download','logs:schedule',
      'terminal:request','terminal:approve','terminal:open',
      'runbook:read','runbook:write','runbook:execute','bastion:read',
      'pg:read','pg:write','pg:terminate','pg:explain',
      'topology:read','topology:write'
    )
    ON CONFLICT DO NOTHING;
  END IF;

  -- DevOps Engineer: scripts (read/write/execute), logs:download, terminal:open, runbook:read/execute, pg:read/explain, topology:read
  SELECT id INTO rid FROM roles WHERE name='DevOps Engineer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'scripts:read'),(rid,'scripts:write'),(rid,'scripts:execute'),
      (rid,'logs:download'),
      (rid,'terminal:request'),(rid,'terminal:open'),
      (rid,'runbook:read'),(rid,'runbook:execute'),
      (rid,'pg:read'),(rid,'pg:explain'),
      (rid,'topology:read')
      ON CONFLICT DO NOTHING;
  END IF;

  -- SRE: tudo de db + scripts:read + topology + runbook + terminal:request
  SELECT id INTO rid FROM roles WHERE name='SRE';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'scripts:read'),
      (rid,'logs:download'),(rid,'logs:schedule'),
      (rid,'terminal:request'),(rid,'terminal:open'),
      (rid,'runbook:read'),(rid,'runbook:execute'),
      (rid,'bastion:read'),
      (rid,'pg:read'),(rid,'pg:terminate'),(rid,'pg:explain'),
      (rid,'topology:read')
      ON CONFLICT DO NOTHING;
  END IF;

  -- Cloud Admin: bastion, pg admin, topology
  SELECT id INTO rid FROM roles WHERE name='Cloud Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'logs:download'),(rid,'logs:schedule'),
      (rid,'bastion:read'),
      (rid,'pg:read'),(rid,'pg:write'),
      (rid,'topology:read'),(rid,'topology:write'),
      (rid,'terminal:approve'),
      (rid,'scripts:approve')
      ON CONFLICT DO NOTHING;
  END IF;

  -- Developer: scripts:read, logs:download, runbook:read/execute, terminal:request, pg:read, topology:read
  SELECT id INTO rid FROM roles WHERE name='Developer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'scripts:read'),
      (rid,'logs:download'),
      (rid,'terminal:request'),
      (rid,'runbook:read'),(rid,'runbook:execute'),
      (rid,'pg:read'),
      (rid,'topology:read')
      ON CONFLICT DO NOTHING;
  END IF;

  -- Viewer: apenas read
  SELECT id INTO rid FROM roles WHERE name='Viewer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'scripts:read'),
      (rid,'pg:read'),
      (rid,'topology:read'),
      (rid,'runbook:read')
      ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- Marca servidores como produção (usado pela aprovação de execução de scripts)
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'staging'
    CHECK (environment IN ('production','staging','development','sandbox'));

-- ============================================================
-- M1: Script Manager
-- ============================================================
CREATE TABLE IF NOT EXISTS script_files (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  path            text        NOT NULL,                 -- caminho absoluto no host
  size_bytes      bigint,
  sha256          text,
  last_modified   timestamptz,
  cached_content  text,                                  -- snapshot opcional (até 1MB)
  UNIQUE(server_id, path)
);

CREATE TABLE IF NOT EXISTS script_versions (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  file_id         uuid        NOT NULL REFERENCES script_files(id) ON DELETE CASCADE,
  author_id       uuid        REFERENCES users(id) ON DELETE SET NULL,
  author_email    text,
  content         text        NOT NULL,
  sha256          text        NOT NULL,
  comment         text,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('script_versions','ts',
  chunk_time_interval => interval '30 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS script_versions_file_idx ON script_versions(file_id, ts DESC);

CREATE TABLE IF NOT EXISTS script_executions (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL,
  path            text        NOT NULL,
  args            text,
  cwd             text,
  requested_by    uuid,
  approved_by     uuid,                                  -- null se servidor não-prod
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','running','succeeded','failed','cancelled')),
  exit_code       int,
  stdout          text,
  stderr          text,
  duration_ms     int,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('script_executions','ts',
  chunk_time_interval => interval '14 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS script_exec_server_idx ON script_executions(server_id, ts DESC);
CREATE INDEX IF NOT EXISTS script_exec_status_idx ON script_executions(status);
SELECT add_retention_policy('script_executions', interval '365 days', if_not_exists => true);

-- ============================================================
-- M2: Log Downloader
-- ============================================================
CREATE TABLE IF NOT EXISTS log_export_schedules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  filter          jsonb       NOT NULL,                  -- {serverId, containerId, q, level[]}
  format          text        NOT NULL DEFAULT 'log' CHECK (format IN ('log','csv','json','gz')),
  schedule_cron   text        NOT NULL,                  -- ex: '0 2 * * *' (diário 2h)
  destination     jsonb       NOT NULL,                  -- {type:'email'|'s3', email|bucket|key|...}
  enabled         boolean     NOT NULL DEFAULT true,
  last_run_at     timestamptz,
  last_status     text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS log_export_runs (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  schedule_id     uuid,
  status          text        NOT NULL,
  bytes           bigint,
  destination     text,
  error           text,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('log_export_runs','ts', if_not_exists => true);

-- ============================================================
-- M3: Zero Trust
-- ============================================================
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  requested_by    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  reason          text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','approved','rejected','active','closed','expired')),
  ttl_minutes     int         NOT NULL DEFAULT 30,
  command         text        NOT NULL DEFAULT '/bin/sh',
  expires_at      timestamptz,
  closed_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS term_session_server_idx ON terminal_sessions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS term_session_user_idx   ON terminal_sessions(requested_by, created_at DESC);

-- Gravação completa de I/O da sessão (linha por chunk)
CREATE TABLE IF NOT EXISTS terminal_session_events (
  ts              timestamptz NOT NULL DEFAULT clock_timestamp(),
  session_id      uuid        NOT NULL,
  direction       text        NOT NULL CHECK (direction IN ('input','output')),
  data            text        NOT NULL,
  PRIMARY KEY (ts, session_id)
);
SELECT create_hypertable('terminal_session_events','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS term_events_session_idx ON terminal_session_events(session_id, ts);
SELECT add_retention_policy('terminal_session_events', interval '180 days', if_not_exists => true);

-- Runbooks (lista de comandos pré-aprovados)
CREATE TABLE IF NOT EXISTS runbooks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        UNIQUE NOT NULL,
  description     text,
  category        text,                                 -- ex: linux, kubernetes, postgres
  -- Comando ou JSON com lista; placeholders {{var}} permitidos
  command_template text       NOT NULL,
  -- JSON schema simples: { vars: [{name, label, default?, options?}] }
  variables       jsonb       NOT NULL DEFAULT '[]',
  allowed_envs    text[]      NOT NULL DEFAULT ARRAY['staging','development','sandbox'],
  -- Servidores permitidos (label match: ex: ['db','api'])
  allowed_tags    text[]      DEFAULT ARRAY[]::text[],
  approver_required boolean   NOT NULL DEFAULT false,
  created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runbook_executions (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  runbook_id      uuid        NOT NULL,
  server_id       uuid,
  executed_by     uuid,
  vars            jsonb,
  resolved_command text,
  exit_code       int,
  stdout          text,
  stderr          text,
  duration_ms     int,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('runbook_executions','ts', if_not_exists => true);
CREATE INDEX IF NOT EXISTS runbook_exec_rb_idx ON runbook_executions(runbook_id, ts DESC);
SELECT add_retention_policy('runbook_executions', interval '365 days', if_not_exists => true);

-- Bastion: registros de conexões SSH que passaram pela plataforma
CREATE TABLE IF NOT EXISTS bastion_sessions (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id         uuid,
  user_email      text,
  source_ip       inet,
  target_host     text        NOT NULL,
  target_user     text        NOT NULL,
  target_port     int         NOT NULL DEFAULT 22,
  duration_sec    int,
  bytes_in        bigint,
  bytes_out       bigint,
  closed_at       timestamptz,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('bastion_sessions','ts', if_not_exists => true);
CREATE INDEX IF NOT EXISTS bastion_user_idx ON bastion_sessions(user_id, ts DESC);

-- ============================================================
-- M4: PostgreSQL Monitor
-- ============================================================
CREATE TABLE IF NOT EXISTS pg_clusters (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        UNIQUE NOT NULL,
  description     text,
  -- credenciais lidas do vault (segredo nomeado: pg_<id>)
  vault_secret    text        NOT NULL,
  -- conexões (host:port,host2:port2 — multi-host pra Patroni)
  hosts           text        NOT NULL,
  database        text        NOT NULL DEFAULT 'postgres',
  enabled         boolean     NOT NULL DEFAULT true,
  poll_seconds    int         NOT NULL DEFAULT 10,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Snapshots de pg_stat_database / activity / bgwriter
CREATE TABLE IF NOT EXISTS pg_metrics (
  ts              timestamptz NOT NULL,
  cluster_id      uuid        NOT NULL,
  -- métricas globais
  conn_total      int,
  conn_active     int,
  conn_idle       int,
  conn_idle_xact  int,
  max_connections int,
  tps             double precision,        -- transactions per sec (delta)
  cache_hit_pct   double precision,
  db_size_bytes   bigint,
  bgwriter_checkpoints_timed int,
  bgwriter_checkpoints_req   int,
  bgwriter_buffers_clean     bigint,
  replica_lag_bytes bigint,
  PRIMARY KEY (ts, cluster_id)
);
SELECT create_hypertable('pg_metrics','ts',
  chunk_time_interval => interval '1 day',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS pg_metrics_cluster_idx ON pg_metrics(cluster_id, ts DESC);
ALTER TABLE pg_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'cluster_id',
  timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('pg_metrics', interval '7 days', if_not_exists => true);
SELECT add_retention_policy('pg_metrics', interval '180 days', if_not_exists => true);

-- Top queries (snapshots periódicos de pg_stat_statements)
CREATE TABLE IF NOT EXISTS pg_top_queries (
  ts              timestamptz NOT NULL,
  cluster_id      uuid        NOT NULL,
  queryid         bigint      NOT NULL,
  query_text      text,
  calls           bigint,
  total_exec_ms   double precision,
  mean_exec_ms    double precision,
  rows            bigint,
  shared_blks_hit bigint,
  shared_blks_read bigint,
  PRIMARY KEY (ts, cluster_id, queryid)
);
SELECT create_hypertable('pg_top_queries','ts',
  chunk_time_interval => interval '1 day',
  if_not_exists => true);
SELECT add_retention_policy('pg_top_queries', interval '90 days', if_not_exists => true);

-- Saúde de tabelas (bloat, vacuum)
CREATE TABLE IF NOT EXISTS pg_table_health (
  ts              timestamptz NOT NULL,
  cluster_id      uuid        NOT NULL,
  schema_name     text,
  relname         text,
  n_live_tup      bigint,
  n_dead_tup      bigint,
  dead_pct        double precision,
  last_vacuum     timestamptz,
  last_autovacuum timestamptz,
  last_analyze    timestamptz,
  last_autoanalyze timestamptz,
  total_size_bytes bigint,
  PRIMARY KEY (ts, cluster_id, schema_name, relname)
);
SELECT create_hypertable('pg_table_health','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);

-- ============================================================
-- M5: Topologia
-- ============================================================
-- Tipos de nós: server, container, database, lb, service
CREATE TABLE IF NOT EXISTS topology_nodes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text        NOT NULL CHECK (kind IN ('server','container','database','lb','service','external')),
  name            text        NOT NULL,
  -- referencia opcional pra outras tabelas
  ref_type        text,                      -- 'servers' / 'containers' / 'pg_clusters'
  ref_id          text,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  position        jsonb,                     -- {x,y} salvo no canvas pelo usuário
  status          text        NOT NULL DEFAULT 'unknown'
                              CHECK (status IN ('healthy','degraded','down','unknown')),
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, ref_type, ref_id)
);

CREATE TABLE IF NOT EXISTS topology_edges (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  src_id          uuid        NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
  dst_id          uuid        NOT NULL REFERENCES topology_nodes(id) ON DELETE CASCADE,
  -- tipo de relação: hosts, connects_to, depends_on, replicates_to
  kind            text        NOT NULL DEFAULT 'connects_to',
  protocol        text,                      -- tcp/http/https/grpc/etc
  port            int,
  metadata        jsonb       NOT NULL DEFAULT '{}',
  source          text        NOT NULL DEFAULT 'manual',  -- agent_discovery | manual
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_id, dst_id, kind, port)
);
CREATE INDEX IF NOT EXISTS topology_edges_src_idx ON topology_edges(src_id);
CREATE INDEX IF NOT EXISTS topology_edges_dst_idx ON topology_edges(dst_id);
