-- Ajustes de permissões: captura sem aprovação, Docker stop destrutivo,
-- e separar editar de apagar em Scripts.

-- 1) Captura NÃO tem mais aprovação — quem tem capture:request dispara e já
-- começa. A permissão capture:approve deixa de existir (o role_permissions cai
-- por CASCADE do FK, mas removemos explícito por garantia).
DELETE FROM role_permissions WHERE permission_key = 'capture:approve';
DELETE FROM permissions      WHERE key = 'capture:approve';

-- 2) Docker: 'stop' passou a ser destrutivo (derruba o serviço), junto do
-- remove — ambos agora exigem docker:destroy (só admin master). docker:control
-- fica só com start/restart. Atualiza as descrições no catálogo.
UPDATE permissions SET description = 'Iniciar/reiniciar containers (start/restart)'
  WHERE key = 'docker:control';
UPDATE permissions SET description = 'Parar e remover containers, imagens e volumes (destrutivo) — só admin master'
  WHERE key = 'docker:destroy';

-- 3) Scripts: apagar arquivo vira permissão SEPARADA de editar. scripts:write
-- edita/cria; scripts:delete apaga. Concedida só ao Super Admin (quem edita
-- sem essa permissão pode alterar o conteúdo, mas não apagar o arquivo).
INSERT INTO permissions(key, description, category) VALUES
  ('scripts:delete', 'Apagar arquivos de script (destrutivo)', 'scripts')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, 'scripts:delete' FROM roles r WHERE r.name = 'Super Admin'
ON CONFLICT DO NOTHING;
