-- Migration 002: FinOps + Terraform CP + SLO/SLI + GitHub Actions + rotação de credenciais
-- Idempotente. Roda automaticamente pelo entrypoint do backend.

-- ============================================================
-- FinOps: snapshots diários de custo por serviço/conta
-- ============================================================
CREATE TABLE IF NOT EXISTS finops_costs (
  ts            timestamptz NOT NULL,
  cloud         text        NOT NULL CHECK (cloud IN ('aws','oci','gcp','azure')),
  account       text        NOT NULL,        -- account id / tenancy
  service       text        NOT NULL,        -- ex: EC2, S3, ComputeInstances
  region        text,
  currency      text        NOT NULL DEFAULT 'USD',
  cost          numeric(14,4) NOT NULL,
  usage_qty     numeric(18,4),
  usage_unit    text,
  tags          jsonb,
  PRIMARY KEY (ts, cloud, account, service, region)
);
SELECT create_hypertable('finops_costs','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS finops_cloud_account_idx ON finops_costs(cloud, account, ts DESC);
SELECT add_retention_policy('finops_costs', interval '730 days', if_not_exists => true);

CREATE MATERIALIZED VIEW IF NOT EXISTS finops_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', ts) AS bucket,
  cloud, account, service, region, currency,
  sum(cost) AS cost,
  sum(usage_qty) AS usage_qty
FROM finops_costs
GROUP BY 1, cloud, account, service, region, currency
WITH NO DATA;
SELECT add_continuous_aggregate_policy('finops_daily',
  start_offset => interval '60 days',
  end_offset   => interval '1 hour',
  schedule_interval => interval '1 hour',
  if_not_exists => true);

-- Budgets / anomalia simples (usuário define limite mensal por conta+serviço)
CREATE TABLE IF NOT EXISTS finops_budgets (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cloud         text        NOT NULL,
  account       text        NOT NULL,
  service       text,                          -- null = qualquer
  monthly_limit numeric(14,2) NOT NULL,
  currency      text        NOT NULL DEFAULT 'USD',
  alert_at_pct  int         NOT NULL DEFAULT 80,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Terraform Control Plane
-- ============================================================
CREATE TABLE IF NOT EXISTS terraform_workspaces (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        UNIQUE NOT NULL,
  description   text,
  repo_url      text        NOT NULL,        -- ex: https://github.com/org/repo.git
  repo_path     text        NOT NULL DEFAULT '.', -- subdir do tf
  branch        text        NOT NULL DEFAULT 'main',
  cloud         text,                          -- aws/oci/gcp/azure (informativo)
  vars_secret   text,                          -- nome no secrets vault
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS terraform_runs (
  ts            timestamptz NOT NULL DEFAULT now(),
  id            uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id  uuid        NOT NULL,
  workspace_name text       NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('plan','apply','destroy')),
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','running','succeeded','failed','approved','rejected')),
  triggered_by  uuid,                           -- user id
  pr_number     int,
  pr_url        text,
  commit_sha    text,
  output        text,
  add_count     int,
  change_count  int,
  destroy_count int,
  duration_sec  int,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('terraform_runs','ts',
  chunk_time_interval => interval '14 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS tf_runs_workspace_idx ON terraform_runs(workspace_id, ts DESC);
CREATE INDEX IF NOT EXISTS tf_runs_status_idx    ON terraform_runs(status);

-- ============================================================
-- Rotação automática de credenciais cloud
-- ============================================================
CREATE TABLE IF NOT EXISTS credential_rotations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cloud           text        NOT NULL CHECK (cloud IN ('aws','oci','gcp','azure')),
  account         text        NOT NULL,
  iam_user        text        NOT NULL,
  vault_secret    text        NOT NULL,        -- nome do segredo no vault interno
  policy_arn      text,                          -- AWS only (informativo)
  rotation_days   int         NOT NULL DEFAULT 90,
  last_rotated_at timestamptz,
  next_rotation_at timestamptz,
  enabled         boolean     NOT NULL DEFAULT true,
  status          text        NOT NULL DEFAULT 'idle'
                              CHECK (status IN ('idle','rotating','error')),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credential_rotation_events (
  ts              timestamptz NOT NULL DEFAULT now(),
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  rotation_id     uuid        NOT NULL,
  status          text        NOT NULL,
  message         text,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('credential_rotation_events','ts', if_not_exists => true);

-- ============================================================
-- SLO / SLI
-- ============================================================
CREATE TABLE IF NOT EXISTS slos (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        UNIQUE NOT NULL,
  description     text,
  -- Tipo de SLI: availability (% sucesso) ou latency (% sob threshold)
  sli_type        text        NOT NULL CHECK (sli_type IN ('availability','latency','custom')),
  -- Filtro de escopo (igual ao do log query / alert rule)
  filter          jsonb       NOT NULL DEFAULT '{}',
  -- Para availability: % de sucesso; para latency: p95 alvo em ms
  target          numeric(10,4) NOT NULL,
  window_days     int         NOT NULL DEFAULT 28,    -- janela de cálculo
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Snapshots calculados periodicamente (job a cada 5 min)
CREATE TABLE IF NOT EXISTS slo_snapshots (
  ts              timestamptz NOT NULL DEFAULT now(),
  slo_id          uuid        NOT NULL,
  good_events     bigint      NOT NULL,
  total_events    bigint      NOT NULL,
  sli_value       numeric(10,4) NOT NULL,    -- % atual
  budget_remaining numeric(10,4),             -- % de error budget restante
  PRIMARY KEY (ts, slo_id)
);
SELECT create_hypertable('slo_snapshots','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS slo_snap_slo_idx ON slo_snapshots(slo_id, ts DESC);
SELECT add_retention_policy('slo_snapshots', interval '365 days', if_not_exists => true);

-- ============================================================
-- GitHub Actions: ingest de webhooks
-- ============================================================
CREATE TABLE IF NOT EXISTS github_repos (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name       text        UNIQUE NOT NULL,    -- org/repo
  webhook_secret  text,                            -- HMAC verify
  enabled         boolean     NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS github_workflow_runs (
  ts              timestamptz NOT NULL,
  id              uuid        NOT NULL DEFAULT gen_random_uuid(),
  repo_full_name  text        NOT NULL,
  run_id          bigint      NOT NULL,
  workflow_name   text,
  branch          text,
  event           text,
  actor           text,
  status          text,                            -- queued|in_progress|completed
  conclusion      text,                            -- success|failure|cancelled|skipped...
  url             text,
  duration_sec    int,
  raw             jsonb,
  PRIMARY KEY (ts, id)
);
SELECT create_hypertable('github_workflow_runs','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS gh_runs_repo_idx ON github_workflow_runs(repo_full_name, ts DESC);
CREATE INDEX IF NOT EXISTS gh_runs_run_id_idx ON github_workflow_runs(run_id);
SELECT add_retention_policy('github_workflow_runs', interval '180 days', if_not_exists => true);
