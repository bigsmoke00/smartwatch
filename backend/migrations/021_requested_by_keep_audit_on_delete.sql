-- Pedido do usuário: poder excluir um usuário mesmo que ele tenha
-- pedido alguma captura/query no passado, MAS sem perder o rastro de quem
-- pediu (auditoria continua existindo).
--
-- A migration 020 tinha corrigido o bug do 500 trocando pra ON DELETE
-- RESTRICT (bloqueia a exclusão). Isso resolveu o crash, mas o usuário não
-- quer mais bloquear — quer excluir e manter o histórico. Solução:
--
-- 1) Guarda uma "foto" do e-mail de quem pediu (requested_by_email) no
--    momento da criação do pedido/sessão — assim o histórico continua
--    legível mesmo depois que o usuário (e o e-mail dele) deixar de existir.
-- 2) requested_by volta a ser opcional (nullable) e a FK volta a ser
--    ON DELETE SET NULL (agora sem contradição, já que a coluna aceita
--    NULL) — excluir o usuário não falha mais, só desvincula o id.

ALTER TABLE db_query_requests ADD COLUMN IF NOT EXISTS requested_by_email text;
UPDATE db_query_requests q
   SET requested_by_email = u.email
  FROM users u
 WHERE u.id = q.requested_by AND q.requested_by_email IS NULL;

ALTER TABLE db_query_requests ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE db_query_requests DROP CONSTRAINT IF EXISTS db_query_requests_requested_by_fkey;
ALTER TABLE db_query_requests
  ADD CONSTRAINT db_query_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE capture_sessions ADD COLUMN IF NOT EXISTS requested_by_email text;
UPDATE capture_sessions c
   SET requested_by_email = u.email
  FROM users u
 WHERE u.id = c.requested_by AND c.requested_by_email IS NULL;

ALTER TABLE capture_sessions ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE capture_sessions DROP CONSTRAINT IF EXISTS capture_sessions_requested_by_fkey;
ALTER TABLE capture_sessions
  ADD CONSTRAINT capture_sessions_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;

-- terminal_sessions (pedidos de acesso a terminal, Zero Trust) tinha
-- ON DELETE CASCADE em requested_by — ou seja, excluir o usuário apagava a
-- sessão inteira (gravação de I/O, comandos executados, tudo). Mesmo
-- problema de fundo: perde auditoria ao excluir o usuário. Mesma solução:
-- guarda o e-mail e desvincula em vez de apagar.
ALTER TABLE terminal_sessions ADD COLUMN IF NOT EXISTS requested_by_email text;
UPDATE terminal_sessions s
   SET requested_by_email = u.email
  FROM users u
 WHERE u.id = s.requested_by AND s.requested_by_email IS NULL;

ALTER TABLE terminal_sessions ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE terminal_sessions DROP CONSTRAINT IF EXISTS terminal_sessions_requested_by_fkey;
ALTER TABLE terminal_sessions
  ADD CONSTRAINT terminal_sessions_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL;
