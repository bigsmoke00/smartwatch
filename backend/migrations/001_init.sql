-- LogWatch — initial schema (TimescaleDB)
--
-- Convenções:
--   * Tudo em snake_case
--   * IDs UUID (com pgcrypto)
--   * Timestamps com timezone
--   * Hypertables para séries temporais (logs, metrics, audit_events)

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- ============================================================
-- Identidade
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text        UNIQUE NOT NULL,
  password_hash   text        NOT NULL,
  role            text        NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','operator','viewer')),
  active          boolean     NOT NULL DEFAULT true,
  totp_secret     text,                          -- base32; null = MFA não habilitado
  failed_logins   int         NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash text     NOT NULL,
  user_agent      text,
  ip              inet,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

-- ============================================================
-- Inventário
-- ============================================================
CREATE TABLE IF NOT EXISTS servers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  description     text,
  hostname        text,
  ip              inet,
  -- multi-cloud
  cloud           text        CHECK (cloud IN ('aws','oci','gcp','azure','onprem','other')),
  cloud_region    text,
  cloud_account   text,
  cloud_instance_id text,
  cloud_az        text,
  os              text,
  arch            text,
  agent_version   text,
  tags            jsonb       NOT NULL DEFAULT '[]',
  labels          jsonb       NOT NULL DEFAULT '{}',
  last_seen_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS servers_cloud_idx ON servers(cloud);
CREATE INDEX IF NOT EXISTS servers_tags_idx  ON servers USING gin(tags);

CREATE TABLE IF NOT EXISTS api_keys (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  prefix          text        UNIQUE NOT NULL,
  secret_hash     text        NOT NULL,
  scopes          jsonb       NOT NULL DEFAULT '["ingest"]',
  ip_allowlist    inet[]      NOT NULL DEFAULT ARRAY[]::inet[],
  active          boolean     NOT NULL DEFAULT true,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_keys_server_idx ON api_keys(server_id);

-- ============================================================
-- Logs (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS logs (
  ts              timestamptz NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL,
  server_name     text        NOT NULL,
  container_id    text,
  container_name  text,
  image           text,
  stream          text,                          -- stdout|stderr
  level           text        NOT NULL DEFAULT 'unknown',
  message         text        NOT NULL,
  meta            jsonb,
  repeat_count    integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (ts, id)
);

SELECT create_hypertable('logs', 'ts',
  chunk_time_interval => interval '6 hours',
  if_not_exists => true);

CREATE INDEX IF NOT EXISTS logs_server_ts_idx    ON logs(server_id, ts DESC);
CREATE INDEX IF NOT EXISTS logs_container_ts_idx ON logs(container_name, ts DESC);

-- Compressao cedo para manter baixo o uso de disco.
ALTER TABLE logs SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'server_id, level',
  timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy(
  'logs',
  interval '6 hours',
  schedule_interval => interval '1 hour',
  if_not_exists => true
);

SELECT add_retention_policy(
  'logs',
  interval '14 days',
  schedule_interval => interval '1 hour',
  if_not_exists => true
);

-- ============================================================
-- Métricas de host (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS host_metrics (
  ts              timestamptz NOT NULL,
  server_id       uuid        NOT NULL,
  cpu_pct         double precision,
  mem_used_bytes  bigint,
  mem_total_bytes bigint,
  swap_used_bytes bigint,
  load1           double precision,
  load5           double precision,
  load15          double precision,
  disk            jsonb,                         -- [{mount, used, total, used_pct}, ...]
  net             jsonb,                         -- [{iface, rx_bps, tx_bps}, ...]
  procs_total     int,
  procs_running   int,
  uptime_sec      bigint,
  PRIMARY KEY (ts, server_id)
);
SELECT create_hypertable('host_metrics','ts',
  chunk_time_interval => interval '1 day',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS host_metrics_server_ts_idx ON host_metrics(server_id, ts DESC);

ALTER TABLE host_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'server_id',
  timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('host_metrics', interval '7 days', if_not_exists => true);
SELECT add_retention_policy('host_metrics', interval '180 days', if_not_exists => true);

-- ============================================================
-- Containers descobertos por agent
-- ============================================================
CREATE TABLE IF NOT EXISTS containers (
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  container_id    text        NOT NULL,
  name            text        NOT NULL,
  image           text,
  state           text,                          -- running|exited|...
  status          text,
  health          text,
  restart_count   int,
  started_at      timestamptz,
  finished_at     timestamptz,
  ports           jsonb,
  labels          jsonb,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, container_id)
);
CREATE INDEX IF NOT EXISTS containers_state_idx ON containers(state);

-- ============================================================
-- Alertas + notificações
-- ============================================================
CREATE TABLE IF NOT EXISTS alert_rules (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  description     text,
  enabled         boolean     NOT NULL DEFAULT true,
  -- query no estilo logs (json filter), threshold de count em janela
  filter          jsonb       NOT NULL,          -- {q, level[], serverId, containerName}
  window_minutes  int         NOT NULL DEFAULT 5,
  threshold       int         NOT NULL DEFAULT 10,
  severity        text        NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','critical')),
  channels        uuid[]      NOT NULL DEFAULT ARRAY[]::uuid[],
  cooldown_minutes int        NOT NULL DEFAULT 15,
  last_fired_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('slack','discord','webhook','email','pagerduty','telegram')),
  config          jsonb       NOT NULL,          -- url, secret hmac, etc
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_events (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  rule_id         uuid        NOT NULL,
  rule_name       text        NOT NULL,
  severity        text        NOT NULL,
  message         text        NOT NULL,
  count_observed  int,
  payload         jsonb,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('alert_events','ts', if_not_exists => true);
CREATE INDEX IF NOT EXISTS alert_events_rule_idx ON alert_events(rule_id, ts DESC);

-- ============================================================
-- Audit log (hypertable)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_events (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  actor_id        uuid,
  actor_email     text,
  ip              inet,
  user_agent      text,
  action          text        NOT NULL,          -- e.g. user.create, server.delete
  target_type     text,
  target_id       text,
  metadata        jsonb,
  result          text        NOT NULL DEFAULT 'ok' CHECK (result IN ('ok','denied','error')),
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('audit_events','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx  ON audit_events(actor_id, ts DESC);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events(action, ts DESC);
SELECT add_retention_policy('audit_events', interval '365 days', if_not_exists => true);

-- ============================================================
-- Saved queries (filtros guardados pelo usuário)
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_queries (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        uuid        REFERENCES users(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  shared          boolean     NOT NULL DEFAULT false,
  filter          jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Automation (cache de runs do Semaphore)
-- ============================================================
CREATE TABLE IF NOT EXISTS automation_runs (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  semaphore_task_id int,
  project_id      int,
  template_id     int,
  template_name   text,
  status          text,        -- success|error|running|stopped|waiting
  started_by      uuid,
  duration_sec    int,
  output_excerpt  text,
  payload         jsonb,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('automation_runs','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS automation_runs_status_idx ON automation_runs(status, ts DESC);

-- ============================================================
-- Secrets vault (criptografados no app, nunca em claro no DB)
-- ============================================================
CREATE TABLE IF NOT EXISTS secrets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        UNIQUE NOT NULL,
  description     text,
  ciphertext      bytea       NOT NULL,          -- AES-256-GCM
  iv              bytea       NOT NULL,
  tag             bytea       NOT NULL,
  version         int         NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
