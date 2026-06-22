-- Move a configuracao do Patroni de env var (PATRONI_NODES/PATRONI_BASIC_AUTH,
-- um unico cluster fixo) para cadastro via UI, suportando multiplos clusters.

CREATE TABLE IF NOT EXISTS patroni_clusters (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        UNIQUE NOT NULL,
  description text,
  nodes       text[]      NOT NULL DEFAULT ARRAY[]::text[], -- ex: http://10.0.0.1:8008
  basic_auth  text,                                          -- "user:pass", opcional
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);

-- Seed automatico a partir do PATRONI_NODES legado, se existir e a tabela
-- estiver vazia, para nao perder o cluster ja configurado em produção.
-- (A migracao roda em SQL puro; o seed real a partir do env é feito pelo
-- BootstrapService no boot do backend, ver backend/src/bootstrap.service.ts.)
