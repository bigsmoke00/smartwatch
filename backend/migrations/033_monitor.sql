-- Migration 033: Módulo Monitor (monitoria sintética / uptime — estilo Gatus).
-- Idempotente.
--
-- Complementa a observabilidade white-box (logs/métricas/agent) com checagem
-- black-box: sonda endpoints (HTTP/TCP/UDP/ICMP/DNS/TLS) em intervalos, avalia
-- condições (mini-DSL), guarda histórico (uptime/latência) e dispara alerta
-- pelos canais de Notificações já existentes.

-- ============================================================
-- Permissões
-- ============================================================
INSERT INTO permissions(key, description, category) VALUES
  ('monitor:read',  'Ver monitores sintéticos, uptime e histórico', 'monitor'),
  ('monitor:write', 'Cadastrar/editar/importar monitores',          'monitor')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM roles WHERE name='Super Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'monitor:read'),(rid,'monitor:write') ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='DevOps Engineer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'monitor:read'),(rid,'monitor:write') ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='SRE';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'monitor:read'),(rid,'monitor:write') ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='Cloud Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'monitor:read'),(rid,'monitor:write') ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='Developer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'monitor:read')
    ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='Viewer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'monitor:read')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ============================================================
-- Endpoints monitorados (config)
-- ============================================================
CREATE TABLE IF NOT EXISTS monitor_endpoints (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  group_name            text,                                    -- agrupamento na status page
  type                  text        NOT NULL DEFAULT 'http'
                                    CHECK (type IN ('http','tcp','udp','icmp','dns','tls')),
  -- Alvo: URL (http), host:port (tcp/udp/tls), host (icmp/dns).
  target                text        NOT NULL,
  method                text        NOT NULL DEFAULT 'GET',      -- http
  request_headers       jsonb       NOT NULL DEFAULT '{}',       -- http
  request_body          text,                                    -- http
  dns_query_type        text        NOT NULL DEFAULT 'A',        -- dns (A/AAAA/CNAME/MX/TXT/NS)
  interval_seconds      int         NOT NULL DEFAULT 60 CHECK (interval_seconds >= 10),
  timeout_ms            int         NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 500 AND 120000),
  -- Lista de condições no mini-DSL estilo Gatus (ex.: "[STATUS] == 200").
  conditions            jsonb       NOT NULL DEFAULT '[]',
  follow_redirects      boolean     NOT NULL DEFAULT true,       -- http
  insecure_skip_verify  boolean     NOT NULL DEFAULT false,      -- http(s)/tls: aceita cert self-signed
  failure_threshold     int         NOT NULL DEFAULT 1 CHECK (failure_threshold >= 1),
  success_threshold     int         NOT NULL DEFAULT 1 CHECK (success_threshold >= 1),
  alert_channels        uuid[]      NOT NULL DEFAULT '{}',       -- notification_channels a avisar
  enabled               boolean     NOT NULL DEFAULT true,
  -- Estado corrente (mantido pelo scheduler)
  last_checked_at       timestamptz,
  last_status           text        NOT NULL DEFAULT 'pending'
                                    CHECK (last_status IN ('pending','up','down')),
  consecutive_failures  int         NOT NULL DEFAULT 0,
  consecutive_successes int         NOT NULL DEFAULT 0,
  created_by            uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitor_endpoints_enabled_idx ON monitor_endpoints(enabled);

-- ============================================================
-- Resultados (série temporal — uma linha por checagem)
-- ============================================================
CREATE TABLE IF NOT EXISTS monitor_results (
  ts                timestamptz NOT NULL DEFAULT now(),
  endpoint_id       uuid        NOT NULL,
  success           boolean     NOT NULL,
  status_code       int,
  response_time_ms  int,
  ip                text,
  condition_results jsonb       NOT NULL DEFAULT '[]',           -- [{condition, ok}]
  error             text
);
SELECT create_hypertable('monitor_results','ts',
  chunk_time_interval => interval '1 day', if_not_exists => true);
CREATE INDEX IF NOT EXISTS monitor_results_ep_idx ON monitor_results(endpoint_id, ts DESC);

-- Compressão + retenção (mantém o disco sob controle).
ALTER TABLE monitor_results SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'endpoint_id',
  timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('monitor_results', interval '7 days', if_not_exists => true);
SELECT add_retention_policy('monitor_results',  interval '90 days', if_not_exists => true);

-- ============================================================
-- Eventos de transição (subiu/caiu) — timeline por endpoint
-- ============================================================
CREATE TABLE IF NOT EXISTS monitor_events (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid        NOT NULL REFERENCES monitor_endpoints(id) ON DELETE CASCADE,
  type        text        NOT NULL CHECK (type IN ('up','down')),
  message     text,
  ts          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS monitor_events_ep_idx ON monitor_events(endpoint_id, ts DESC);
