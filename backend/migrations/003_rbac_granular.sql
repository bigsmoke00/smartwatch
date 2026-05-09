-- Migration 003: RBAC granular (roles + permissions + user_roles)
-- Mantém compat: a coluna `users.role` continua existindo como "papel padrão",
-- mas a autorização agora consulta `role_permissions` via `user_roles`.

-- ============================================================
-- Permissions (statelessas, identificadas por chave)
-- ============================================================
CREATE TABLE IF NOT EXISTS permissions (
  key             text        PRIMARY KEY,         -- ex: logs:read, servers:write, finops:admin
  description     text        NOT NULL,
  category        text        NOT NULL,            -- logs / infra / finops / cloud / admin / etc
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Roles (perfis de usuário)
-- ============================================================
CREATE TABLE IF NOT EXISTS roles (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        UNIQUE NOT NULL,
  description     text,
  is_system       boolean     NOT NULL DEFAULT false,  -- não pode ser deletado
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id         uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  text        NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         uuid        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX IF NOT EXISTS user_roles_user_idx ON user_roles(user_id);

-- ============================================================
-- Seeds: catálogo de permissões
-- ============================================================
INSERT INTO permissions(key, description, category) VALUES
  -- logs
  ('logs:read',          'Ler logs',                                 'logs'),
  ('logs:export',        'Exportar logs (CSV/JSON)',                 'logs'),
  ('logs:savedquery',    'Criar/gerenciar saved queries',            'logs'),
  -- metrics
  ('metrics:read',       'Ver métricas de host',                     'metrics'),
  -- servers/inventory
  ('servers:read',       'Ler inventário de servidores',             'infra'),
  ('servers:write',      'Criar/editar servidores',                  'infra'),
  ('servers:delete',     'Excluir servidores',                       'infra'),
  ('apikey:write',       'Gerar/revogar API keys de servidor',       'infra'),
  ('inventory:cloud_sync','Sincronizar inventário cloud (AWS/OCI)',  'infra'),
  -- containers
  ('containers:read',    'Ver containers',                           'infra'),
  ('docker:control',     'Controlar containers (start/stop/exec)',   'infra'),
  ('docker:deploy',      'Deploy de novos containers',               'infra'),
  -- automation / terraform
  ('automation:read',    'Ver automações Semaphore',                 'ops'),
  ('automation:run',     'Executar templates Semaphore',             'ops'),
  ('terraform:read',     'Ver workspaces Terraform',                 'ops'),
  ('terraform:plan',     'Disparar terraform plan',                  'ops'),
  ('terraform:apply',    'Aprovar/aplicar terraform',                'ops'),
  -- alerts / notifications
  ('alerts:read',        'Ver alertas e regras',                     'ops'),
  ('alerts:write',       'Criar/editar regras de alerta',            'ops'),
  ('notifications:write','Gerenciar canais de notificação',          'ops'),
  -- finops
  ('finops:read',        'Ver dashboard FinOps',                     'finops'),
  ('finops:budget_write','Gerenciar budgets',                        'finops'),
  ('finops:sync',        'Disparar sync de cloud cost',              'finops'),
  -- slo
  ('slo:read',           'Ver SLOs',                                 'ops'),
  ('slo:write',          'Criar/editar SLOs',                        'ops'),
  -- pipelines
  ('pipelines:read',     'Ver pipelines GitHub Actions',             'ops'),
  ('pipelines:write',    'Registrar repos GitHub',                   'ops'),
  -- cloud cred
  ('credrot:read',       'Ver rotações de credenciais',              'admin'),
  ('credrot:write',      'Configurar rotações',                      'admin'),
  -- audit / users / secrets / patroni
  ('audit:read',         'Ver audit log',                            'admin'),
  ('users:read',         'Ver usuários',                             'admin'),
  ('users:write',        'Gerenciar usuários',                       'admin'),
  ('roles:read',         'Ver perfis e permissões',                  'admin'),
  ('roles:write',        'Gerenciar perfis e permissões',            'admin'),
  ('secrets:read',       'Ver vault interno (somente nomes)',        'admin'),
  ('secrets:write',      'Definir/remover secrets do vault',         'admin'),
  ('patroni:read',       'Ver cluster Patroni',                      'admin')
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Seeds: perfis padrão
-- ============================================================
DO $$
DECLARE
  role_super_admin uuid;
  role_cloud_admin uuid;
  role_devops uuid;
  role_sre uuid;
  role_dev uuid;
  role_finops uuid;
  role_viewer uuid;
BEGIN
  -- Super Admin: tudo
  INSERT INTO roles(name, description, is_system) VALUES
    ('Super Admin', 'Acesso total à plataforma', true)
    ON CONFLICT (name) DO UPDATE SET description=EXCLUDED.description
    RETURNING id INTO role_super_admin;
  IF role_super_admin IS NULL THEN
    SELECT id INTO role_super_admin FROM roles WHERE name='Super Admin';
  END IF;
  INSERT INTO role_permissions(role_id, permission_key)
    SELECT role_super_admin, key FROM permissions
    ON CONFLICT DO NOTHING;

  -- Cloud Admin: tudo de cloud / infra / finops / cred
  INSERT INTO roles(name, description, is_system) VALUES
    ('Cloud Admin', 'Administra inventário cloud, FinOps e credenciais', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_cloud_admin;
  IF role_cloud_admin IS NULL THEN
    SELECT id INTO role_cloud_admin FROM roles WHERE name='Cloud Admin';
  END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_cloud_admin, 'logs:read'),
    (role_cloud_admin, 'metrics:read'),
    (role_cloud_admin, 'servers:read'),
    (role_cloud_admin, 'servers:write'),
    (role_cloud_admin, 'inventory:cloud_sync'),
    (role_cloud_admin, 'containers:read'),
    (role_cloud_admin, 'finops:read'),
    (role_cloud_admin, 'finops:budget_write'),
    (role_cloud_admin, 'finops:sync'),
    (role_cloud_admin, 'credrot:read'),
    (role_cloud_admin, 'credrot:write'),
    (role_cloud_admin, 'patroni:read'),
    (role_cloud_admin, 'audit:read')
    ON CONFLICT DO NOTHING;

  -- DevOps Engineer: infra, automação, terraform, pipelines
  INSERT INTO roles(name, description, is_system) VALUES
    ('DevOps Engineer', 'Operações: containers, terraform, pipelines, automação', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_devops;
  IF role_devops IS NULL THEN
    SELECT id INTO role_devops FROM roles WHERE name='DevOps Engineer';
  END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_devops, 'logs:read'), (role_devops, 'logs:export'),
    (role_devops, 'metrics:read'),
    (role_devops, 'servers:read'), (role_devops, 'servers:write'),
    (role_devops, 'apikey:write'),
    (role_devops, 'containers:read'),
    (role_devops, 'docker:control'), (role_devops, 'docker:deploy'),
    (role_devops, 'automation:read'), (role_devops, 'automation:run'),
    (role_devops, 'terraform:read'), (role_devops, 'terraform:plan'),
    (role_devops, 'pipelines:read'),
    (role_devops, 'alerts:read')
    ON CONFLICT DO NOTHING;

  -- SRE: foco em SLOs, alertas, métricas, logs
  INSERT INTO roles(name, description, is_system) VALUES
    ('SRE', 'Site Reliability Engineer: SLOs, alertas, observabilidade', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_sre;
  IF role_sre IS NULL THEN SELECT id INTO role_sre FROM roles WHERE name='SRE'; END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_sre, 'logs:read'), (role_sre, 'logs:export'), (role_sre, 'logs:savedquery'),
    (role_sre, 'metrics:read'),
    (role_sre, 'servers:read'),
    (role_sre, 'containers:read'),
    (role_sre, 'alerts:read'), (role_sre, 'alerts:write'),
    (role_sre, 'notifications:write'),
    (role_sre, 'slo:read'), (role_sre, 'slo:write'),
    (role_sre, 'pipelines:read'),
    (role_sre, 'patroni:read')
    ON CONFLICT DO NOTHING;

  -- Developer: read-only de logs/métricas + pipelines
  INSERT INTO roles(name, description, is_system) VALUES
    ('Developer', 'Acesso de leitura para troubleshooting', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_dev;
  IF role_dev IS NULL THEN SELECT id INTO role_dev FROM roles WHERE name='Developer'; END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_dev, 'logs:read'), (role_dev, 'logs:savedquery'),
    (role_dev, 'metrics:read'),
    (role_dev, 'servers:read'),
    (role_dev, 'containers:read'),
    (role_dev, 'pipelines:read'),
    (role_dev, 'alerts:read')
    ON CONFLICT DO NOTHING;

  -- FinOps Analyst: foco em custos
  INSERT INTO roles(name, description, is_system) VALUES
    ('FinOps Analyst', 'Análise de custos cloud', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_finops;
  IF role_finops IS NULL THEN SELECT id INTO role_finops FROM roles WHERE name='FinOps Analyst'; END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_finops, 'finops:read'), (role_finops, 'finops:budget_write'), (role_finops, 'finops:sync'),
    (role_finops, 'servers:read'),
    (role_finops, 'metrics:read')
    ON CONFLICT DO NOTHING;

  -- Viewer: leitura mínima
  INSERT INTO roles(name, description, is_system) VALUES
    ('Viewer', 'Leitura de painéis principais', true)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO role_viewer;
  IF role_viewer IS NULL THEN SELECT id INTO role_viewer FROM roles WHERE name='Viewer'; END IF;
  INSERT INTO role_permissions(role_id, permission_key) VALUES
    (role_viewer, 'logs:read'),
    (role_viewer, 'metrics:read'),
    (role_viewer, 'servers:read'),
    (role_viewer, 'containers:read')
    ON CONFLICT DO NOTHING;
END $$;

-- ============================================================
-- Compat: garante que admins existentes recebam Super Admin role
-- ============================================================
INSERT INTO user_roles(user_id, role_id)
SELECT u.id, r.id
FROM users u
CROSS JOIN roles r
WHERE u.role = 'admin' AND r.name = 'Super Admin'
ON CONFLICT DO NOTHING;

-- Operators legacy → DevOps Engineer
INSERT INTO user_roles(user_id, role_id)
SELECT u.id, r.id
FROM users u
CROSS JOIN roles r
WHERE u.role = 'operator' AND r.name = 'DevOps Engineer'
ON CONFLICT DO NOTHING;

-- Viewers legacy → Viewer
INSERT INTO user_roles(user_id, role_id)
SELECT u.id, r.id
FROM users u
CROSS JOIN roles r
WHERE u.role = 'viewer' AND r.name = 'Viewer'
ON CONFLICT DO NOTHING;
