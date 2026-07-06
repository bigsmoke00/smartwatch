-- Eficiência de armazenamento de logs.
--
-- Diagnóstico do inchaço (140GB/14d/6 servidores): a retenção era feita por
-- DELETE per-server de hora em hora. No TimescaleDB, DELETE em chunk COMPRIMIDO
-- descomprime o chunk (infla 5-20x), deixa dead tuples, e sem VACUUM FULL
-- (desligado por padrão) o espaço não volta pro SO. A política nativa
-- (drop_chunks) estava em 400 dias — nunca disparava.
--
-- Correção: a retenção passa a usar drop_chunks (dropa o CHUNK INTEIRO = DROP
-- TABLE do arquivo: devolve disco na hora, sem descomprimir, sem dead tuple)
-- pra tudo além da MAIOR retenção configurada; o DELETE per-server (com
-- recompressão logo depois) fica só pro mínimo necessário quando há retenções
-- diferentes. Ver LogsService.purgeExpiredLogs (roda de hora em hora).

-- Retenção padrão de logs: 4 dias. Ajustável por servidor na tela de Servidores.
ALTER TABLE servers ALTER COLUMN retention_days SET DEFAULT 4;
-- Servidores que estavam num default anterior (não escolhido) vão pro novo padrão.
UPDATE servers SET retention_days = 4 WHERE retention_days IN (7, 14);

-- Garante que a política de compressão existe (comprime chunk > 6h). Se por
-- algum motivo o job não estava ativo, isto o (re)cria.
SELECT add_compression_policy('logs', interval '6 hours',
  schedule_interval => interval '1 hour', if_not_exists => true);
