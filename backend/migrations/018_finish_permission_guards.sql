-- Fecha lacunas encontradas numa auditoria de RBAC: vários endpoints
-- (FinOps, Patroni, servidores, alertas, notificações, secrets, rotação de
-- credenciais, audit log, saved queries) tinham permissão granular cadastrada
-- na tela "Perfis e permissões" mas o controller real não checava nada (ou
-- só checava o campo de role legado 'admin'/'operator', ignorando perfis
-- customizados). Os controllers foram corrigidos pra usar @RequirePermission
-- de verdade — esta migration só cobre duas chaves que faltavam existir:
--
--   patroni:write       — criar/editar/remover cluster Patroni (só existia
--                          patroni:read; escrita ficava sem permissão própria)
--   notifications:read  — ver canais de notificação cadastrados sem poder
--                          gerenciá-los (só existia notifications:write)

INSERT INTO permissions(key, description, category) VALUES
  ('patroni:write',      'Criar/editar/remover cluster Patroni',     'admin'),
  ('notifications:read', 'Ver canais de notificação',                'ops')
ON CONFLICT (key) DO NOTHING;

-- Super Admin sempre tem tudo — concede as duas chaves novas explicitamente
-- (o INSERT...SELECT de 003 que dava "tudo" automaticamente só roda uma vez,
-- na criação do perfil; permissões criadas depois precisam ser concedidas
-- aqui também).
INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, p.key
FROM roles r, (VALUES ('patroni:write'), ('notifications:read')) AS p(key)
WHERE r.name = 'Super Admin'
ON CONFLICT DO NOTHING;

-- Cloud Admin já tinha patroni:read — ganha também a escrita (é quem
-- administra a infra de banco/cluster).
INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, 'patroni:write' FROM roles r WHERE r.name = 'Cloud Admin'
ON CONFLICT DO NOTHING;

-- SRE já gerenciava notificações (notifications:write) e lia Patroni — ganha
-- patroni:write também (faz parte do trabalho de SRE reagir a incidentes de
-- banco) e notifications:read fica implícito por já ter write.
INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, 'patroni:write' FROM roles r WHERE r.name = 'SRE'
ON CONFLICT DO NOTHING;

-- DevOps Engineer ganha notifications:read (visibilidade dos canais
-- configurados, sem poder alterá-los) — hoje não tinha nem leitura.
INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, 'notifications:read' FROM roles r WHERE r.name = 'DevOps Engineer'
ON CONFLICT DO NOTHING;
