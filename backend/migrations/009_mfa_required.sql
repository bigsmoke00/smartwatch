-- Permite que o admin marque usuários específicos como obrigados a usar 2FA.
-- Quando mfa_required=true e o usuário ainda não configurou o TOTP
-- (totp_secret IS NULL), o login funciona normalmente mas o backend retorna
-- mfaSetupRequired=true para o frontend forçar a configuração antes de
-- liberar o resto da plataforma.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT false;
