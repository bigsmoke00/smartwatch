-- Bug: excluir um usuário que tinha pedidos em db_query_requests ou
-- capture_sessions quebrava com 500 Internal Server Error.
--
-- Causa: as colunas requested_by dessas duas tabelas são NOT NULL mas a FK
-- estava com ON DELETE SET NULL — uma combinação contraditória. Ao apagar o
-- usuário, o Postgres tenta colocar NULL em requested_by pra manter a FK
-- consistente, mas a própria coluna proíbe NULL, e isso sobe como um erro de
-- not-null-violation não tratado (-> 500 genérico no DELETE /api/users/:id).
--
-- Fix: troca pra ON DELETE RESTRICT (mesmo efeito prático de "não permite
-- apagar", mas com um erro de FK violation padrão e previsível, em vez de um
-- erro de NOT NULL no meio de uma operação de SET NULL impossível). Faz
-- sentido de negócio também: db_query_requests/capture_sessions são
-- histórico de auditoria (quem pediu o quê) — não deveria sumir/virar NULL
-- só porque o usuário foi removido depois.

ALTER TABLE db_query_requests
  DROP CONSTRAINT IF EXISTS db_query_requests_requested_by_fkey;
ALTER TABLE db_query_requests
  ADD CONSTRAINT db_query_requests_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;

ALTER TABLE capture_sessions
  DROP CONSTRAINT IF EXISTS capture_sessions_requested_by_fkey;
ALTER TABLE capture_sessions
  ADD CONSTRAINT capture_sessions_requested_by_fkey
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT;
