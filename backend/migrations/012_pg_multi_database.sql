-- Clusters PG hoje são configurados com UMA única "database" (ex.: o user
-- cadastra user=postgres, password=..., database=postgres) e toda a coleta
-- (pg_stat_statements, pg_stat_user_tables) rodava só contra esse banco.
-- Na prática o servidor tem várias databases, e a "postgres" (banco de
-- manutenção padrão) costuma não ter tabelas de usuário nenhuma — é por
-- isso que "Saúde"/"Sugestões de índice" apareciam vazios mesmo com tráfego
-- real acontecendo em outro banco do mesmo servidor.
--
-- Esta migration adiciona a coluna `datname` em pg_top_queries e
-- pg_table_health pra cada linha coletada carregar de qual database ela
-- veio, permitindo que o poller percorra TODAS as databases do servidor
-- (não só a configurada no cluster) sem colisão de PK entre bancos
-- diferentes que tenham queryid/schema/tabela coincidentes.

ALTER TABLE pg_top_queries ADD COLUMN IF NOT EXISTS datname text;
ALTER TABLE pg_table_health ADD COLUMN IF NOT EXISTS datname text;

-- Backfill: linhas coletadas antes desta migration não têm datname (era
-- sempre a única database configurada no cluster). Sem isso, ADD PRIMARY
-- KEY falha com "column datname ... contains null values" porque colunas
-- de PK são implicitamente NOT NULL.
UPDATE pg_top_queries t SET datname = c.database
  FROM pg_clusters c WHERE c.id = t.cluster_id AND t.datname IS NULL;
UPDATE pg_table_health t SET datname = c.database
  FROM pg_clusters c WHERE c.id = t.cluster_id AND t.datname IS NULL;
-- Fallback final pra linhas cujo cluster_id já não existe mais (cluster
-- deletado de verdade, sem soft-delete, em algum momento do passado).
UPDATE pg_top_queries SET datname = 'unknown' WHERE datname IS NULL;
UPDATE pg_table_health SET datname = 'unknown' WHERE datname IS NULL;

-- Troca a PK pra incluir datname (evita colisão entre bancos diferentes
-- com o mesmo queryid ou schema.tabela no mesmo instante de coleta).
ALTER TABLE pg_top_queries DROP CONSTRAINT IF EXISTS pg_top_queries_pkey;
ALTER TABLE pg_top_queries ADD PRIMARY KEY (ts, cluster_id, datname, queryid);

ALTER TABLE pg_table_health DROP CONSTRAINT IF EXISTS pg_table_health_pkey;
ALTER TABLE pg_table_health ADD PRIMARY KEY (ts, cluster_id, datname, schema_name, relname);
