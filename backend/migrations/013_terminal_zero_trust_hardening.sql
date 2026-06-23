-- Endurece o Terminal Web (Zero Trust):
--
-- 1) Hoje toda sessão host roda como o usuário do SO do próprio AGENT
--    (normalmente root), e "Modo readonly"/"sudo" são só checkboxes do
--    CLIENTE — o backend confia neles na hora de conectar o WS, então
--    qualquer um podia abrir DevTools e marcar sudo=true. Corrigido no
--    código (TerminalGateway agora resolve tudo a partir da sessão já
--    aprovada no banco, nunca do payload do cliente), mas precisamos de
--    onde guardar QUAL usuário do SO cada pessoa deve usar.
--
-- 2) `user_server_logins` é o mapeamento "usuário da plataforma → usuário
--    do SO" pedido: o admin cadastra, por usuário, qual login ele tem em
--    cada servidor (ou um mapeamento default pra todos os servidores,
--    com server_id NULL). Sem mapeamento cadastrado, o sistema cai no
--    fallback de hoje (a parte antes do @ no email).
--
-- 3) `terminal_sessions` ganha colunas pra persistir, no momento do
--    PEDIDO de acesso (não na hora de abrir o terminal), qual alvo,
--    modo e usuário do SO serão usados — assim o aprovador sabe o que
--    está aprovando, e o gateway nunca mais lê essas decisões do cliente.
--
-- 4) `terminal_session_commands` guarda cada comando executado de forma
--    legível (capturado via HISTFILE no agent), separado do dump bruto
--    de I/O em terminal_session_events — isso é o que alimenta o
--    "arquivo de fácil visualização" pedido.

CREATE TABLE IF NOT EXISTS user_server_logins (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL = mapeamento default do usuário, aplicado a qualquer servidor que
  -- não tenha uma entrada mais específica (server_id preenchido).
  server_id       uuid        REFERENCES servers(id) ON DELETE CASCADE,
  os_username     text        NOT NULL,
  allow_sudo      boolean     NOT NULL DEFAULT false,
  -- Permite desabilitar terminal:request por servidor mesmo com mapeamento
  -- existente, mantendo readonly como única opção pra esse usuário/servidor.
  allow_readwrite boolean     NOT NULL DEFAULT true,
  created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, server_id)
);
CREATE INDEX IF NOT EXISTS user_server_logins_user_idx ON user_server_logins(user_id);

ALTER TABLE terminal_sessions
  ADD COLUMN IF NOT EXISTS target               text NOT NULL DEFAULT 'host' CHECK (target IN ('host','container')),
  ADD COLUMN IF NOT EXISTS container_id          text,
  ADD COLUMN IF NOT EXISTS mode                  text NOT NULL DEFAULT 'readwrite' CHECK (mode IN ('readonly','readwrite')),
  ADD COLUMN IF NOT EXISTS sudo_requested        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sudo_granted          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS target_user           text,
  ADD COLUMN IF NOT EXISTS idle_timeout_minutes  int NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS last_activity_at      timestamptz,
  ADD COLUMN IF NOT EXISTS transcript            text,
  ADD COLUMN IF NOT EXISTS closed_reason         text;

-- Sessões antigas (pré-migration) não tinham target_user resolvido; usa o
-- fallback de sempre (prefixo do email) só pra essas linhas históricas, não
-- afeta o fluxo novo (que sempre resolve no request()).
UPDATE terminal_sessions s SET target_user = split_part(u.email, '@', 1)
  FROM users u WHERE u.id = s.requested_by AND s.target_user IS NULL;

CREATE TABLE IF NOT EXISTS terminal_session_commands (
  ts              timestamptz NOT NULL DEFAULT clock_timestamp(),
  session_id      uuid        NOT NULL,
  command         text        NOT NULL,
  PRIMARY KEY (ts, session_id)
);
SELECT create_hypertable('terminal_session_commands','ts',
  chunk_time_interval => interval '7 days',
  if_not_exists => true);
CREATE INDEX IF NOT EXISTS term_commands_session_idx ON terminal_session_commands(session_id, ts);
SELECT add_retention_policy('terminal_session_commands', interval '180 days', if_not_exists => true);

INSERT INTO permissions(key, description, category) VALUES
  ('terminal:manage_logins', 'Configurar usuário do SO por pessoa/servidor', 'zero_trust')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM roles WHERE name='Super Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'terminal:manage_logins')
    ON CONFLICT DO NOTHING;
  END IF;
  SELECT id INTO rid FROM roles WHERE name='Cloud Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'terminal:manage_logins')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
