-- Migration 040: CD v2 — contrato oficial do SmartOne (integracao-smartone-smartgard.md v1.0).
--
-- Mudanças do contrato:
--   * eventos: test_connection, gmud_pipeline_preparar, gmud_execution_started, gmud_rollback_started
--   * payload traz um ARRAY `componentes`, cada um com a própria callback_url (token de uso único)
--   * NÃO vem servidor: o alvo sai do catálogo do SmartGard, mapeado pelo componente_id do SmartOne
--   * vem `script` explícito e `env_variables_description` em texto livre
--   * callback: repetir só em 5xx/falha de rede; 404 = já processado; 400 = não repetir igual

-- ------------------------------------------------------------ catálogo
ALTER TABLE deploy_apps
  ADD COLUMN IF NOT EXISTS smartone_component_id text,   -- componente_id (UUID) do catálogo do SmartOne
  ADD COLUMN IF NOT EXISTS script                text,   -- script padrão dentro do working_dir (ex.: unity.sh)
  -- O que fazer quando a GMUD vier com env_variables_required=true (texto livre, não automatizável):
  --   block  -> recusa na preparação e dá erro na execução (alguém tem que aplicar manualmente)
  --   script -> segue; o script recebe a descrição em GMUD_ENV_DESCRIPTION e é responsável por aplicar
  ADD COLUMN IF NOT EXISTS env_mode              text NOT NULL DEFAULT 'block';

DO $$ BEGIN
  ALTER TABLE deploy_apps ADD CONSTRAINT deploy_apps_env_mode_check CHECK (env_mode IN ('block','script'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS deploy_apps_smartone_component_uk
  ON deploy_apps(smartone_component_id) WHERE smartone_component_id IS NOT NULL;

-- ------------------------------------------------------------ execuções
ALTER TABLE deploy_executions DROP CONSTRAINT IF EXISTS deploy_executions_kind_check;
ALTER TABLE deploy_executions ADD CONSTRAINT deploy_executions_kind_check
  CHECK (kind IN ('deploy','rollback','prepare'));

ALTER TABLE deploy_executions
  ADD COLUMN IF NOT EXISTS component_id      text,        -- componente_id do SmartOne
  ADD COLUMN IF NOT EXISTS script            text,
  ADD COLUMN IF NOT EXISTS env_description   text,        -- env_variables_description recebida
  -- Estado do callback (reenvio só em 5xx / falha de rede)
  ADD COLUMN IF NOT EXISTS callback_body     jsonb,
  ADD COLUMN IF NOT EXISTS callback_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_state    text,        -- pending | done | failed
  ADD COLUMN IF NOT EXISTS callback_next_at  timestamptz;

-- Idempotência: cada callback_url (token de uso único) corresponde a UMA execução.
-- Se o SmartOne reenviar o mesmo evento, não roda de novo.
CREATE UNIQUE INDEX IF NOT EXISTS deploy_exec_callback_url_uk
  ON deploy_executions(callback_url) WHERE callback_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS deploy_exec_callback_pending_idx
  ON deploy_executions(callback_next_at) WHERE callback_state = 'pending';
