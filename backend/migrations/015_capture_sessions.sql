-- Captura de rede/SIP sob aprovação (Zero Trust):
--
-- Pedido do usuário: poder analisar SIP (sngrep-like) em servidores
-- Freeswitch/OpenSIPS/RTG engine, tcpdump genérico, e diagnóstico básico
-- (ping/conectividade/qualidade de chamada) — sem precisar de acesso direto
-- ao servidor, e com opção de salvar a captura (.pcap) no computador.
--
-- Mesmo motor de pedido→aprovação do Terminal Web: o N1 pede, um aprovador
-- (capture:approve) aprova, o agent é quem efetivamente roda a captura (via
-- ControlGateway), e o resultado (.pcap ou texto de diagnóstico) fica
-- disponível pra download, tudo auditado.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  -- 'sip'     = captura com filtro SIP/RTP (porta 5060/5061 + faixa RTP) — pensado pra Freeswitch/OpenSIPS/RTG.
  -- 'tcpdump' = captura genérica, filtro BPF livre informado pelo solicitante.
  -- 'ping'    = diagnóstico básico (ping/mtr) — não gera arquivo, só texto, e não passa por aprovação de execução.
  kind            text        NOT NULL CHECK (kind IN ('sip','tcpdump','ping')),
  iface           text        NOT NULL DEFAULT 'any',
  -- Filtro BPF (tcpdump) — obrigatório pra 'tcpdump', default sip/rtp calculado no backend pra 'sip'.
  filter_expr     text,
  -- Alvo do diagnóstico 'ping' (host/IP).
  target_host     text,
  duration_seconds int        NOT NULL DEFAULT 60 CHECK (duration_seconds BETWEEN 5 AND 1800),
  max_packets     int         NOT NULL DEFAULT 200000,
  reason          text        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','running','completed','failed','expired')),
  requested_by    uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  approved_by     uuid        REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  -- Resultado: 'sip'/'tcpdump' preenchem file_*; 'ping' preenche result_text.
  file_path       text,
  file_size_bytes bigint,
  packet_count    int,
  result_text     text,
  error_text      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capture_sessions_server_idx ON capture_sessions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS capture_sessions_status_idx ON capture_sessions(status) WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS capture_sessions_requester_idx ON capture_sessions(requested_by, created_at DESC);

INSERT INTO permissions(key, description, category) VALUES
  ('capture:request', 'Solicitar captura de rede/SIP (sngrep/tcpdump) ou diagnóstico de rede', 'zero_trust'),
  ('capture:approve', 'Aprovar pedidos de captura de rede/SIP',                                 'zero_trust')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  FOREACH rid IN ARRAY (
    SELECT array_agg(id) FROM roles
    WHERE name IN ('Super Admin','Cloud Admin','DevOps Engineer','SRE')
  )
  LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'capture:request')
    ON CONFLICT DO NOTHING;
  END LOOP;

  FOREACH rid IN ARRAY (
    SELECT array_agg(id) FROM roles WHERE name IN ('Super Admin','Cloud Admin')
  )
  LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'capture:approve')
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
