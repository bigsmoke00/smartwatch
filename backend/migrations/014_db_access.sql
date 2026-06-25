-- Acesso a banco para análise (N1) + escalonamento de UPDATE (N2/N3):
--
-- Contexto (pedido do usuário): a plataforma remove acesso direto a
-- servidores via zero trust. Hoje, pra investigar bugs, o N1 precisa rodar
-- alguns SELECTs de análise nos bancos monitorados (M4 — pg_clusters) e,
-- ocasionalmente, um UPDATE corretivo é necessário. Em vez de dar acesso
-- direto ao banco pro N1, este módulo:
--
-- 1) Libera SELECT/WITH ad-hoc direto (permissão db:query) — mesma validação
--    de "só leitura" já usada em pg-monitor.explain() — sem aprovação, já
--    que é só leitura e sujeito a timeout/limite de linhas.
--
-- 2) Pra UPDATE/INSERT/DELETE/etc., reusa o MESMO motor de pedido→aprovação
--    já usado no Terminal Web (zero-trust): o N1 registra o SQL que precisa
--    rodar (junto do SELECT que mostrou o problema, como contexto) com um
--    motivo; um aprovador (db:write_approve) vê o pedido e, se aprovar, é
--    ELE QUEM EXECUTA (db:write_execute) — dentro de uma sessão controlada e
--    com o resultado/erro gravado pra auditoria. Nunca o solicitante executa
--    a escrita diretamente.

CREATE TABLE IF NOT EXISTS db_query_requests (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id      uuid        NOT NULL REFERENCES pg_clusters(id) ON DELETE CASCADE,
  database        text,
  -- 'read'  = SELECT/WITH ad-hoc, executado direto pelo solicitante (sem
  --           aprovação) — registrado aqui só pra auditoria/histórico.
  -- 'write' = INSERT/UPDATE/DELETE/etc. — precisa de aprovação; quem aprova
  --           é quem executa, nunca o solicitante.
  kind            text        NOT NULL DEFAULT 'write' CHECK (kind IN ('read','write')),
  sql_text        text        NOT NULL,
  reason          text        NOT NULL,
  -- SELECT de referência que motivou o pedido de escrita (contexto pro
  -- aprovador entender o problema antes de autorizar o UPDATE).
  context_query   text,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','executed','failed')),
  requested_by    uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  executed_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  executed_at     timestamptz,
  row_count       int,
  result_sample   jsonb,
  error_text      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS db_query_requests_cluster_idx ON db_query_requests(cluster_id, created_at DESC);
CREATE INDEX IF NOT EXISTS db_query_requests_status_idx ON db_query_requests(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS db_query_requests_requester_idx ON db_query_requests(requested_by, created_at DESC);

INSERT INTO permissions(key, description, category) VALUES
  ('db:query',         'Rodar SELECT/WITH ad-hoc (leitura) em bancos monitorados',                    'db_access'),
  ('db:write_request', 'Pedir execução de UPDATE/INSERT/DELETE em banco monitorado (escalonamento)',  'db_access'),
  ('db:write_approve', 'Aprovar ou rejeitar pedidos de escrita em banco',                              'db_access'),
  ('db:write_execute', 'Executar (após aprovar) um pedido de escrita em banco',                        'db_access')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  -- N1: leitura + pedido de escalonamento
  FOREACH rid IN ARRAY (
    SELECT array_agg(id) FROM roles
    WHERE name IN ('Super Admin','Cloud Admin','DevOps Engineer','SRE','Developer')
  )
  LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'db:query')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'db:write_request')
    ON CONFLICT DO NOTHING;
  END LOOP;

  -- N2/N3: aprovam e executam a escrita
  FOREACH rid IN ARRAY (
    SELECT array_agg(id) FROM roles WHERE name IN ('Super Admin','Cloud Admin')
  )
  LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'db:write_approve')
    ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'db:write_execute')
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
