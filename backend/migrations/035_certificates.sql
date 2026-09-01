-- Migration 035: Módulo de Certificados.
-- Aponta um servidor (via agent) + um diretório com certificados; o backend
-- varre (fs.listDir/readFile), parseia cada cert (X.509) e mostra numa tela
-- todos os certs e quando vencem. Idempotente.

-- ============================================================ Permissões
INSERT INTO permissions(key, description, category) VALUES
  ('cert:read',  'Ver inventário de certificados e vencimentos', 'cert'),
  ('cert:write', 'Cadastrar/editar alvos e disparar varredura',  'cert')
ON CONFLICT (key) DO NOTHING;

DO $$
DECLARE rid uuid;
BEGIN
  FOR rid IN SELECT id FROM roles WHERE name IN ('Super Admin','DevOps Engineer','SRE','Cloud Admin') LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES
      (rid,'cert:read'),(rid,'cert:write') ON CONFLICT DO NOTHING;
  END LOOP;
  FOR rid IN SELECT id FROM roles WHERE name IN ('Developer','Viewer') LOOP
    INSERT INTO role_permissions(role_id, permission_key) VALUES (rid,'cert:read')
    ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ============================================================ Alvos (servidor + diretório)
CREATE TABLE IF NOT EXISTS cert_targets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  server_id       uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  directory       text        NOT NULL,                 -- caminho no host (dentro do LOGWATCH_ALLOWED_PATHS do agent)
  recursive       boolean     NOT NULL DEFAULT true,     -- desce 1 nível (ex.: /etc/letsencrypt/live/*)
  enabled         boolean     NOT NULL DEFAULT true,
  last_scan_at    timestamptz,
  last_scan_error text,
  created_by      uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================ Certificados encontrados
CREATE TABLE IF NOT EXISTS cert_files (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id    uuid        NOT NULL REFERENCES cert_targets(id) ON DELETE CASCADE,
  path         text        NOT NULL,
  common_name  text,
  subject      text,
  issuer       text,
  san          text,
  not_before   timestamptz,
  not_after    timestamptz,
  fingerprint  text,
  error        text,                                     -- se não deu pra parsear (ex.: DER/binário, chave)
  scanned_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, path)
);
CREATE INDEX IF NOT EXISTS cert_files_expiry_idx ON cert_files(not_after);
CREATE INDEX IF NOT EXISTS cert_files_target_idx ON cert_files(target_id);
