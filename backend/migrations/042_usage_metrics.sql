-- Migration 042: métricas de uso da plataforma (esforço por usuário e por módulo).
--
-- usage_daily guarda, por dia + usuário + módulo (tela), os MINUTOS ATIVOS e as
-- VISUALIZAÇÕES de página. "Ativo" = aba visível e interação (mouse/teclado) nos
-- últimos 5 min; o frontend manda 1 batimento por minuto nessas condições.
-- As AÇÕES (escritas) e os LOGINS vêm do audit_events, que já existe.
CREATE TABLE IF NOT EXISTS usage_daily (
  day            date        NOT NULL,
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module         text        NOT NULL,
  active_minutes int         NOT NULL DEFAULT 0,
  page_views     int         NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, user_id, module)
);
CREATE INDEX IF NOT EXISTS usage_daily_user_idx ON usage_daily(user_id, day DESC);

INSERT INTO permissions(key, description, category) VALUES
  ('usage:read', 'Ver métricas de uso da plataforma (geral e por usuário)', 'admin')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  SELECT id INTO rid FROM roles WHERE name = 'Super Admin';
  IF rid IS NOT NULL THEN
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid, 'usage:read') ON CONFLICT DO NOTHING;
  END IF;
END $$;
