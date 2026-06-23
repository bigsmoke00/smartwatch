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

-- Troca a PK pra incluir datname (evita colisão entre bancos diferentes
-- com o mesmo queryid ou schema.tabela no mesmo instante de coleta).
ALTER TABLE pg_top_queries DROP CONSTRAINT IF EXISTS pg_top_queries_pkey;
ALTER TABLE pg_top_queries ADD PRIMARY KEY (ts, cluster_id, datname, queryid);

ALTER TABLE pg_table_health DROP CONSTRAINT IF EXISTS pg_table_health_pkey;
ALTER TABLE pg_table_health ADD PRIMARY KEY (ts, cluster_id, datname, schema_name, relname);
