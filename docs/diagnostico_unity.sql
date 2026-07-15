-- ============================================================
-- 1) A coluna call_uuid existe? (confirma se a migration 027 rodou de
--    verdade nesse banco — se der erro "column does not exist", é isso).
-- ============================================================
SELECT column_name FROM information_schema.columns
WHERE table_name = 'logs' AND column_name = 'call_uuid';

-- ============================================================
-- 2) Tem QUALQUER log ingerido pro servidor ocisp-sip-server1 nas
--    últimas 48h? (confirma se o agent está rodando/ingerindo NESSE
--    servidor específico — se vier 0, o problema é ingestão, não a
--    busca por UUID).
-- ============================================================
SELECT count(*) AS total_linhas,
       count(*) FILTER (WHERE call_uuid IS NOT NULL) AS com_call_uuid,
       min(ts) AS mais_antiga, max(ts) AS mais_recente
FROM logs l
JOIN servers s ON s.id = l.server_id
WHERE s.name = 'ocisp-sip-server1'
  AND l.ts >= now() - interval '48 hours';

-- ============================================================
-- 3) Se o resultado acima vier tudo zero, este aqui mostra TODOS os
--    servidores que estão realmente recebendo log agora (talvez o agent
--    tenha sido cadastrado com outro nome, ex.: ocisp-app-unity1).
-- ============================================================
SELECT s.name, count(*) AS linhas_48h, max(l.ts) AS ultima_linha
FROM logs l
JOIN servers s ON s.id = l.server_id
WHERE l.ts >= now() - interval '48 hours'
GROUP BY s.name
ORDER BY linhas_48h DESC;

-- ============================================================
-- 4) O UUID específico que você buscou — existe em algum lugar do banco,
--    em qualquer servidor, mesmo fora da janela de 48h? (confirma se
--    chegou a ser ingerido, só não pro servidor/janela certos).
-- ============================================================
SELECT s.name AS servidor, l.ts, l.call_uuid, left(l.message, 80) AS inicio_da_linha
FROM logs l
JOIN servers s ON s.id = l.server_id
WHERE l.message LIKE 'e64f3a29-2f7a-458a-ba8b-0c3ea02f9eed%'
   OR l.call_uuid = 'e64f3a29-2f7a-458a-ba8b-0c3ea02f9eed'
ORDER BY l.ts DESC
LIMIT 20;
