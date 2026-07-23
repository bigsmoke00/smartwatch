-- Migration 031: Módulo de CD (Continuous Deployment) — integração SmartOne <> SmartWatch.
-- Idempotente.
--
-- Fluxo: SmartOne aprova+inicia uma GMUD -> chama o webhook do SmartWatch ->
-- o SmartWatch resolve qual "aplicação de deploy" (sistema+componente+ambiente)
-- corresponde, ajusta o arquivo no host (env/compose/script) e executa o
-- deploy/rollback via agent -> devolve o resultado pro SmartOne (callback).

-- ============================================================
-- Permissões
-- ============================================================
INSERT INTO permissions(key, description, category) VALUES
  ('deploy:read',    'Ver aplicações de deploy e histórico de execuções', 'deploy'),
  ('deploy:write',   'Cadastrar/editar aplicações de deploy',             'deploy'),
  ('deploy:trigger', 'Disparar deploy/rollback manualmente',              'deploy')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM roles WHERE name='Super Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key)
    SELECT rid, key FROM permissions WHERE key IN ('deploy:read','deploy:write','deploy:trigger')
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO rid FROM roles WHERE name='DevOps Engineer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'deploy:read'),(rid,'deploy:write'),(rid,'deploy:trigger')
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO rid FROM roles WHERE name='SRE';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'deploy:read'),(rid,'deploy:trigger')
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO rid FROM roles WHERE name='Cloud Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'deploy:read'),(rid,'deploy:write'),(rid,'deploy:trigger')
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO rid FROM roles WHERE name='Developer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'deploy:read')
    ON CONFLICT DO NOTHING;
  END IF;

  SELECT id INTO rid FROM roles WHERE name='Viewer';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'deploy:read')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

-- ============================================================
-- Aplicações de deploy (o "alvo": onde e como deployar cada componente)
-- ============================================================
CREATE TABLE IF NOT EXISTS deploy_apps (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,                       -- rótulo amigável (ex: "Unity Manager · PROD")
  sistema       text        NOT NULL,                        -- casa com payload.sistema do SmartOne
  componente    text        NOT NULL,                        -- casa com payload.componente
  environment   text        NOT NULL DEFAULT 'production'
                            CHECK (environment IN ('production','staging','development','sandbox')),
  server_id     uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  working_dir   text        NOT NULL,                         -- diretório do compose/.sh no host
  -- Estratégia de aplicação da versão:
  --   compose_env   -> ajusta uma var (ex.: TAG=) no arquivo de env e sobe o compose
  --   compose_image -> reescreve a tag da imagem no docker-compose.yml e sobe
  --   script        -> executa um script de deploy do host passando a versão
  strategy      text        NOT NULL DEFAULT 'compose_env'
                            CHECK (strategy IN ('compose_env','compose_image','script')),
  -- Parâmetros da estratégia (ver DeployAppConfig no backend):
  --   compose_env:   { envFile, versionVar, composeFile, service, deployCommand? }
  --   compose_image: { composeFile, service, deployCommand? }
  --   script:        { scriptPath, argsTemplate }
  config        jsonb       NOT NULL DEFAULT '{}',
  image_repo    text,                                         -- repositório da imagem (compose_image / compose_env)
  enabled       boolean     NOT NULL DEFAULT true,
  created_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sistema, componente, environment)
);
CREATE INDEX IF NOT EXISTS deploy_apps_match_idx ON deploy_apps(sistema, componente);

-- ============================================================
-- Execuções (uma por GMUD executada/rollback, ou disparo manual)
-- ============================================================
CREATE TABLE IF NOT EXISTS deploy_executions (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid        REFERENCES deploy_apps(id) ON DELETE SET NULL,
  kind             text        NOT NULL DEFAULT 'deploy' CHECK (kind IN ('deploy','rollback')),
  source           text        NOT NULL DEFAULT 'smartone' CHECK (source IN ('smartone','manual')),
  -- Contexto vindo do SmartOne (snapshot, para auditoria mesmo se o app mudar)
  gmud_id          text,
  numero_protocolo text,
  sistema          text,
  componente       text,
  environment      text,
  version          text,
  previous_version text,
  callback_url     text,
  pipeline_id      text,                                     -- id que devolvemos ao SmartOne
  status           text        NOT NULL DEFAULT 'received'
                              CHECK (status IN ('received','running','success','error')),
  steps            jsonb       NOT NULL DEFAULT '[]',         -- [{name, ok, output}]
  log              text,                                      -- stdout/stderr acumulado
  error_text       text,
  callback_status  text,                                      -- resultado do POST ao SmartOne
  requested_by     uuid        REFERENCES users(id) ON DELETE SET NULL,  -- se disparo manual
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deploy_exec_app_idx    ON deploy_executions(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deploy_exec_status_idx ON deploy_executions(status);
CREATE INDEX IF NOT EXISTS deploy_exec_gmud_idx   ON deploy_executions(gmud_id);
CREATE INDEX IF NOT EXISTS deploy_exec_created_idx ON deploy_executions(created_at DESC);
