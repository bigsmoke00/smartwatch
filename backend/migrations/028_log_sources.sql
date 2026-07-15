-- Registro leve de "fontes conhecidas" (containers/arquivos de host) por
-- servidor — resolve a lentidão do filtro "container específico"/"arquivo
-- específico" da tela de Logs.
--
-- Diagnóstico: distinctContainers()/distinctFiles() (logs.repository.ts)
-- faziam GROUP BY container_name direto na hypertable `logs`, com bound de
-- 7 dias (índice logs_server_ts_idx cobre o WHERE, mas o GROUP BY ainda
-- precisa varrer/agregar TODA linha da janela). Isso era tolerável até um
-- servidor de altíssimo volume (FreeSWITCH/Unity, até 500.000 linhas/min
-- configurável — ver servers.log_rate_limit_per_minute, migration 027) ser
-- cadastrado: 7 dias desse volume é uma quantidade monstruosa pra agregar
-- toda vez que alguém abre o filtro.
--
-- Solução: uma tabela pequena, NÃO hypertable, com 1 linha por
-- (server_id, source_name), upsertada a cada ingest (ver
-- LogsService.ingest()). distinctContainers()/distinctFiles() passam a ler
-- daqui — leitura por índice de PK, independe do volume/retenção de `logs`.
CREATE TABLE IF NOT EXISTS log_sources (
  server_id     uuid        NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  source_name   text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('container', 'host')),
  image         text,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, source_name)
);

-- Usado tanto pelas listagens (WHERE server_id + kind, ORDER BY last_seen_at)
-- quanto pela limpeza por retenção (ver LogsService.purgeExpiredLogs).
CREATE INDEX IF NOT EXISTS log_sources_server_kind_idx
  ON log_sources(server_id, kind, last_seen_at DESC);
