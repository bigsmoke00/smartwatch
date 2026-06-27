-- Limpeza de permissões "mortas": chaves cadastradas em 003/004 pra módulos
-- (automation/Semaphore, terraform, SLO, pipelines/GitHub Actions, runbooks,
-- bastion SSH, topologia) que nunca ganharam controller/endpoint no backend.
-- Resultado prático: apareciam na tela "Perfis e permissões" como se
-- fizessem algo, mas nenhum guard (@RequirePermission) em nenhuma rota as
-- referencia — só confundiam quem estava montando um perfil.
--
-- ON DELETE CASCADE em role_permissions.permission_key (ver 003_rbac_granular.sql)
-- cuida de remover as atribuições dessas chaves nos perfis SYSTEM automaticamente.
--
-- Se algum desses módulos for implementado de fato no futuro, basta inserir
-- a permissão de novo numa nova migration, junto com o controller real.
DELETE FROM permissions WHERE key IN (
  'automation:read', 'automation:run',
  'terraform:read', 'terraform:plan', 'terraform:apply',
  'slo:read', 'slo:write',
  'pipelines:read', 'pipelines:write',
  'runbook:read', 'runbook:write', 'runbook:execute',
  'bastion:read',
  'topology:read', 'topology:write'
);
