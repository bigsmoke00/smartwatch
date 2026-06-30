-- Remoção DESTRUTIVA no Docker manager (apagar container, imagem ou volume)
-- passa a exigir uma permissão própria, separada de docker:control/deploy:
-- só o admin master (Super Admin) deve poder destruir esses recursos.
--
-- Antes:
--   removeContainer -> docker:control  (qualquer um que dava start/stop apagava)
--   removeImage     -> docker:deploy   (qualquer um que dava deploy apagava)
--   removeVolume    -> docker:deploy   (idem — risco de perda de dados)
--
-- Agora os três controllers exigem docker:destroy. Aqui criamos a chave e a
-- concedemos APENAS ao Super Admin — nenhuma role operacional (DevOps, SRE,
-- Cloud Admin, etc.) recebe, de propósito. Quem não tem a permissão nem vê o
-- ícone de remover (o frontend esconde via /me/permissions).

INSERT INTO permissions(key, description, category) VALUES
  ('docker:destroy', 'Remover containers, imagens e volumes (destrutivo) — só admin master', 'infra')
ON CONFLICT (key) DO NOTHING;

-- Super Admin sempre tem tudo — concede a chave nova explicitamente (o
-- INSERT...SELECT de "tudo" do 003 só roda na criação do perfil; permissões
-- criadas depois precisam ser concedidas aqui, igual a migration 018 fez).
INSERT INTO role_permissions(role_id, permission_key)
SELECT r.id, 'docker:destroy' FROM roles r WHERE r.name = 'Super Admin'
ON CONFLICT DO NOTHING;
