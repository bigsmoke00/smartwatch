-- A constraint UNIQUE(name) original em pg_clusters (e em patroni_clusters)
-- não leva soft-delete em conta: depois de remover um cluster
-- (deleted_at preenchido), o nome continua "reservado" pra sempre e um novo
-- POST com o mesmo nome falha com
-- "duplicate key value violates unique constraint pg_clusters_name_key",
-- mesmo a listagem já não mostrando mais nenhum cluster com esse nome.
-- Troca por um índice único parcial, que só considera linhas ativas.
ALTER TABLE pg_clusters DROP CONSTRAINT IF EXISTS pg_clusters_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS pg_clusters_name_active_idx
  ON pg_clusters(name) WHERE deleted_at IS NULL;

-- Mesmo problema latente em patroni_clusters (já tem deleted_at, mas a
-- constraint de name ainda é incondicional) — corrige pra consistência.
ALTER TABLE patroni_clusters DROP CONSTRAINT IF EXISTS patroni_clusters_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS patroni_clusters_name_active_idx
  ON patroni_clusters(name) WHERE deleted_at IS NULL;
