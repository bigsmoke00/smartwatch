-- Migration 032: CD adaptativo — o SmartOne agora envia servidor, diretório e
-- mudanças de env no payload; o SmartWatch detecta sozinho compose vs script.
-- Guarda esse contexto nas execuções (o alvo não vem mais só do cadastro).
ALTER TABLE deploy_executions
  ADD COLUMN IF NOT EXISTS server_host   text,   -- hostname/IP que o SmartOne informou
  ADD COLUMN IF NOT EXISTS working_dir   text,   -- diretório do compose/.sh no host
  ADD COLUMN IF NOT EXISTS envs          jsonb,  -- [{key, value}] aplicadas
  ADD COLUMN IF NOT EXISTS detected_mode text;   -- 'compose' | 'script' (auto-detectado)
