-- Migration 039: Ambientes (environments) + RBAC com escopo por ambiente.
--
-- Objetivo: permitir controle granular por ambiente (ex.: Prod e Lab).
-- Um usuário pode ser admin no Lab e apenas viewer no Prod (ou o contrário),
-- e um ambiente inteiro (Lab) fica isolado do Prod.
--
-- Modelo:
--   * environments             -> entidade de 1ª classe (slug/nome), CRUD.
--   * <recurso>.environment_id -> a qual ambiente o recurso pertence
--                                 (servers, monitor_endpoints, cert_targets).
--   * user_roles.environment_id -> concessao de papel POR ambiente.
--                                  NULL = concessao GLOBAL (vale em todos os
--                                  ambientes; usado pelo owner/super admin).
--
-- Compat: as linhas de user_roles ja existentes ficam com environment_id NULL
-- (global), entao os admins atuais continuam com acesso total — nada quebra.

-- ============================================================
-- Tabela de ambientes
-- ============================================================
CREATE TABLE IF NOT EXISTS environments (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text        UNIQUE NOT NULL,           -- ex: prod, lab (usado no header X-Environment)
  name          text        NOT NULL,                  -- rotulo exibido
  description   text,
  color         text        NOT NULL DEFAULT '#1497a8', -- cor do chip no seletor
  is_default    boolean     NOT NULL DEFAULT false,     -- ambiente padrao quando nenhum e selecionado
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Garante no maximo 1 default
CREATE UNIQUE INDEX IF NOT EXISTS environments_single_default
  ON environments((is_default)) WHERE is_default;

-- Seed: Prod (default) e Lab
INSERT INTO environments(slug, name, description, color, is_default) VALUES
  ('prod', 'Produção',      'Ambiente de produção',   '#ef5566', true),
  ('lab',  'Laboratório',   'Ambiente de laboratório/testes', '#4fc1d0', false)
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- environment_id nos recursos operacionais (backfill = ambiente default)
-- ============================================================
DO $$
DECLARE
  default_env uuid;
BEGIN
  SELECT id INTO default_env FROM environments WHERE is_default LIMIT 1;
  IF default_env IS NULL THEN
    SELECT id INTO default_env FROM environments ORDER BY created_at LIMIT 1;
  END IF;

  -- servers
  ALTER TABLE servers ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id);
  UPDATE servers SET environment_id = default_env WHERE environment_id IS NULL;

  -- monitor_endpoints
  ALTER TABLE monitor_endpoints ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id);
  UPDATE monitor_endpoints SET environment_id = default_env WHERE environment_id IS NULL;

  -- cert_targets
  ALTER TABLE cert_targets ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id);
  UPDATE cert_targets SET environment_id = default_env WHERE environment_id IS NULL;
END $$;

CREATE INDEX IF NOT EXISTS servers_env_idx           ON servers(environment_id);
CREATE INDEX IF NOT EXISTS monitor_endpoints_env_idx ON monitor_endpoints(environment_id);
CREATE INDEX IF NOT EXISTS cert_targets_env_idx      ON cert_targets(environment_id);

-- ============================================================
-- user_roles: concessao de papel por ambiente
-- ============================================================
ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS environment_id uuid REFERENCES environments(id) ON DELETE CASCADE;

-- A PK antiga (user_id, role_id) impede a mesma role em 2 ambientes.
-- Troca por indices unicos parciais:
--   * global  -> no maximo 1 (user_id, role_id) com environment_id NULL
--   * escopado -> no maximo 1 (user_id, role_id, environment_id) nao-nulo
ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_global_uk
  ON user_roles(user_id, role_id) WHERE environment_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_scoped_uk
  ON user_roles(user_id, role_id, environment_id) WHERE environment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_roles_env_idx ON user_roles(environment_id);

-- ============================================================
-- Permissoes de administracao de ambientes (globais)
-- ============================================================
INSERT INTO permissions(key, description, category) VALUES
  ('environments:read',  'Ver ambientes',                    'admin'),
  ('environments:write', 'Criar/editar/excluir ambientes',   'admin')
ON CONFLICT (key) DO NOTHING;

-- Concede as novas permissoes aos perfis de administracao ja existentes
-- (o seed original do Super Admin so rodou uma vez, entao precisa reconceder).
DO $$
DECLARE
  role_super_admin uuid;
  role_cloud_admin uuid;
BEGIN
  SELECT id INTO role_super_admin FROM roles WHERE name = 'Super Admin';
  SELECT id INTO role_cloud_admin FROM roles WHERE name = 'Cloud Admin';

  IF role_super_admin IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (role_super_admin, 'environments:read'),
      (role_super_admin, 'environments:write')
    ON CONFLICT DO NOTHING;
  END IF;

  IF role_cloud_admin IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (role_cloud_admin, 'environments:read')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
