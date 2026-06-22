-- Suporte a "defina sua própria senha" via link enviado por email
-- (token JWT de uso único, sem necessidade de tabela extra).
--
-- must_change_password=true marca usuários criados sem senha definida pelo
-- admin: o password_hash gravado é aleatório/inutilizável até o usuário usar
-- o link para definir a senha real.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
