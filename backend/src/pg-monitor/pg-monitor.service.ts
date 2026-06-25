import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { SecretsService } from '../secrets/secrets.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MonitoredPgClient } from './pg-client';

interface ClusterRow {
  id: string; name: string; vault_secret: string;
  hosts: string; database: string; enabled: boolean; poll_seconds: number;
}

@Injectable()
export class PgMonitorService {
  private readonly logger = new Logger('PgMonitorService');
  // delta de TPS / bgwriter precisa do snapshot anterior
  private prevTx = new Map<string, { commits: number; rollbacks: number; ts: number }>();
  // cache curto compartilhado entre usuários (ver withSharedCache abaixo)
  private sharedCache = new Map<string, { ts: number; value?: any; inflight?: Promise<any> }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly secrets: SecretsService,
    private readonly notif: NotificationsService,
  ) {}

  // ---------- Validação + feature detection ----------
  /**
   * Valida credenciais e detecta features. Cacheia resultado em pg_cluster_features.
   * Chamado: (1) ao criar cluster, (2) sob demanda via UI, (3) quando coleta falha.
   */
  async validateAndDetect(opts: { hosts: string; database: string; user: string; password: string; ssl?: boolean })
  : Promise<{
    ok: boolean; pgVersion?: string; isInRecovery?: boolean;
    hasPgStatStatements?: boolean; hasPgBuffercache?: boolean; hasPgRepack?: boolean;
    error?: string;
  }> {
    const c = new (await import('./pg-client')).MonitoredPgClient({
      hosts: opts.hosts, database: opts.database,
      user: opts.user, password: opts.password, ssl: opts.ssl,
      statementTimeoutMs: 5000,
    });
    try {
      const v = await c.query<any>(`SHOW server_version`);
      const r = await c.query<any>(`SELECT pg_is_in_recovery()::bool AS rec`);
      const ext = await c.query<any>(`
        SELECT extname FROM pg_extension WHERE extname IN ('pg_stat_statements','pg_buffercache','pg_repack')
      `);
      const exts = new Set(ext.map((e) => e.extname));
      return {
        ok: true,
        pgVersion: v[0]?.server_version,
        isInRecovery: r[0]?.rec,
        hasPgStatStatements: exts.has('pg_stat_statements'),
        hasPgBuffercache: exts.has('pg_buffercache'),
        hasPgRepack: exts.has('pg_repack'),
      };
    } catch (e: any) {
      return { ok: false, error: e.message };
    } finally {
      await c.end();
    }
  }

  /** Salva detecção em cache pra UI consultar. */
  private async saveFeatures(clusterId: string, det: any) {
    await this.pool.query(
      `INSERT INTO pg_cluster_features
        (cluster_id, has_pg_stat_statements, has_pg_buffercache, has_pg_repack,
         pg_version, is_in_recovery, detected_at, last_error)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
       ON CONFLICT (cluster_id) DO UPDATE SET
         has_pg_stat_statements=EXCLUDED.has_pg_stat_statements,
         has_pg_buffercache=EXCLUDED.has_pg_buffercache,
         has_pg_repack=EXCLUDED.has_pg_repack,
         pg_version=EXCLUDED.pg_version,
         is_in_recovery=EXCLUDED.is_in_recovery,
         detected_at=now(), last_error=EXCLUDED.last_error`,
      [clusterId, !!det.hasPgStatStatements, !!det.hasPgBuffercache, !!det.hasPgRepack,
       det.pgVersion ?? null, det.isInRecovery ?? null, det.error ?? null],
    );
  }

  async getFeatures(clusterId: string) {
    const r = await this.pool.query(
      `SELECT has_pg_stat_statements AS "hasPgStatStatements",
              has_pg_buffercache AS "hasPgBuffercache",
              has_pg_repack AS "hasPgRepack",
              pg_version AS "pgVersion",
              is_in_recovery AS "isInRecovery",
              detected_at AS "detectedAt",
              last_error AS "lastError"
       FROM pg_cluster_features WHERE cluster_id=$1`,
      [clusterId],
    );
    return r.rows[0] ?? null;
  }

  // ---------- CRUD de clusters ----------
  // Nunca expõe vault_secret pra fora — é um detalhe interno de implementação.
  private toPublic(row: any) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      hosts: row.hosts,
      database: row.database,
      enabled: row.enabled,
      pollSeconds: row.poll_seconds,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async listClusters() {
    const r = await this.pool.query(
      `SELECT id, name, description, hosts, database, enabled,
              poll_seconds AS "pollSeconds", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM pg_clusters WHERE deleted_at IS NULL ORDER BY name`,
    );
    return r.rows;
  }

  /**
   * Recebe credenciais diretas (user/password/ssl) — quem chama nunca precisa
   * saber ou criar um "vault secret" antecipadamente. O segredo é gerado e
   * guardado encriptado aqui dentro, de forma transparente.
   */
  async createCluster(c: {
    name: string; description?: string; hosts: string; database?: string;
    pollSeconds?: number; user: string; password: string; ssl?: boolean;
  }) {
    const vaultSecret = `pg_${randomUUID()}`;
    await this.secrets.set(
      vaultSecret,
      JSON.stringify({ user: c.user, password: c.password, ssl: !!c.ssl }),
      `Credenciais do cluster PG "${c.name}"`,
    );
    const r = await this.pool.query(
      `INSERT INTO pg_clusters(name, description, vault_secret, hosts, database, poll_seconds)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [c.name, c.description ?? null, vaultSecret, c.hosts, c.database ?? 'postgres', c.pollSeconds ?? 10],
    );
    const id = r.rows[0].id;
    // Detecta features em background (não bloqueia criação se cluster offline)
    this.detectByClusterId(id).catch(() => {});
    return this.getClusterPublic(id);
  }

  /**
   * Atualiza campos do cluster e, opcionalmente, as credenciais. Se vier
   * qualquer um de user/password/ssl, mescla com o que já está salvo no
   * vault (não precisa reenviar todos os três pra trocar só a senha, por
   * exemplo) e regrava o mesmo segredo nomeado.
   */
  async updateCluster(id: string, input: {
    name?: string; description?: string; hosts?: string; database?: string;
    pollSeconds?: number; enabled?: boolean;
    user?: string; password?: string; ssl?: boolean;
  }) {
    const cl = await this.cluster(id);

    if (input.user !== undefined || input.password !== undefined || input.ssl !== undefined) {
      let existing: any = {};
      try {
        existing = JSON.parse(await this.secrets.get(cl.vault_secret));
      } catch { /* segredo perdido/inexistente — recria do zero com o que veio */ }
      const merged = {
        user: input.user ?? existing.user,
        password: input.password ?? existing.password,
        ssl: input.ssl ?? existing.ssl ?? false,
      };
      await this.secrets.set(
        cl.vault_secret,
        JSON.stringify(merged),
        `Credenciais do cluster PG "${input.name ?? cl.name}"`,
      );
    }

    const set: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (input.name !== undefined) { set.push(`name=$${i++}`); params.push(input.name); }
    if (input.description !== undefined) { set.push(`description=$${i++}`); params.push(input.description); }
    if (input.hosts !== undefined) { set.push(`hosts=$${i++}`); params.push(input.hosts); }
    if (input.database !== undefined) { set.push(`database=$${i++}`); params.push(input.database); }
    if (input.pollSeconds !== undefined) { set.push(`poll_seconds=$${i++}`); params.push(input.pollSeconds); }
    if (input.enabled !== undefined) { set.push(`enabled=$${i++}`); params.push(input.enabled); }
    if (set.length) {
      set.push(`updated_at=now()`);
      params.push(id);
      await this.pool.query(`UPDATE pg_clusters SET ${set.join(', ')} WHERE id=$${i}`, params);
    }
    // Credenciais ou conexão podem ter mudado — redetecta em background.
    this.detectByClusterId(id).catch(() => {});
    return this.getClusterPublic(id);
  }

  async getClusterPublic(id: string) {
    const cl = await this.cluster(id);
    return this.toPublic(cl);
  }

  /** Carrega cred do vault e roda detecção pra um cluster existente. */
  async detectByClusterId(clusterId: string) {
    const cl = await this.cluster(clusterId);
    try {
      const raw = await this.secrets.get(cl.vault_secret);
      const cred = JSON.parse(raw);
      const det = await this.validateAndDetect({
        hosts: cl.hosts, database: cl.database,
        user: cred.user, password: cred.password, ssl: cred.ssl,
      });
      await this.saveFeatures(clusterId, det);
      return det;
    } catch (e: any) {
      await this.saveFeatures(clusterId, { error: e.message });
      throw e;
    }
  }

  /** Soft delete (mesmo padrão do Patroni) — preserva histórico em pg_metrics/etc. */
  async deleteCluster(id: string) {
    const cl = await this.cluster(id);
    await this.pool.query(`UPDATE pg_clusters SET deleted_at=now() WHERE id=$1`, [id]);
    await this.secrets.remove(cl.vault_secret).catch(() => {});
    return { ok: true };
  }

  // ---------- Cron: polling ----------
  /** Roda a cada 10s; cluster define seu próprio intervalo via poll_seconds. */
  @Cron('*/10 * * * * *')
  async pollAll() {
    const clusters = await this.pool.query<ClusterRow>(
      `SELECT id, name, vault_secret, hosts, database, enabled, poll_seconds
       FROM pg_clusters WHERE enabled=true AND deleted_at IS NULL`,
    );
    for (const c of clusters.rows) {
      // cada cluster pode ter poll_seconds próprio, mas como o cron base é 10s,
      // aqui só pulamos quando o último ts é mais novo que poll_seconds atrás
      try {
        const last = await this.pool.query(
          `SELECT ts FROM pg_metrics WHERE cluster_id=$1 ORDER BY ts DESC LIMIT 1`,
          [c.id],
        );
        const lastMs = last.rows[0]?.ts ? new Date(last.rows[0].ts).getTime() : 0;
        if (Date.now() - lastMs < (c.poll_seconds * 1000) - 500) continue;
        await this.pollCluster(c);
      } catch (e: any) {
        this.logger.error(`pollCluster ${c.name}: ${e.message}`);
      }
    }
  }

  /**
   * Compartilha UMA leitura por chave entre todos os usuários que pedirem
   * dentro da janela de `ttlMs`. Antes, cada aba aberta (de cada usuário)
   * abria sua própria conexão direto no cluster monitorado a cada poll do
   * frontend (5s em "Queries ativas"/"Locks") — com N usuários, N conexões
   * reais por ciclo. Agora a primeira requisição da janela busca os dados
   * de verdade; as outras (de qualquer usuário, dentro do TTL) recebem o
   * mesmo resultado, ou esperam a mesma busca já em andamento — sem abrir
   * conexão extra nenhuma. Erros nunca ficam em cache (a próxima chamada
   * tenta de novo).
   */
  private async withSharedCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.sharedCache.get(key);
    if (entry) {
      if (entry.inflight) return entry.inflight;
      if (now - entry.ts < ttlMs) return entry.value;
    }
    const inflight = fn();
    this.sharedCache.set(key, { ts: now, inflight });
    try {
      const value = await inflight;
      this.sharedCache.set(key, { ts: Date.now(), value });
      return value;
    } catch (e) {
      this.sharedCache.delete(key);
      throw e;
    }
  }

  /**
   * `dbOverride` permite abrir a conexão numa database diferente da
   * configurada no cluster — necessário pra coletar/explicar queries de
   * outras databases do mesmo servidor (ver listServerDatabases()).
   */
  private async getClient(c: ClusterRow, dbOverride?: string): Promise<MonitoredPgClient> {
    const raw = await this.secrets.get(c.vault_secret);
    const cred = JSON.parse(raw);   // { user, password, ssl? }
    // .trim() defensivo: dbOverride normalmente vem de input de usuário (ex.:
    // tela de Acesso a banco) e um espaço sobrando vira um nome de database
    // literal inválido — o erro do Postgres ecoa a string exata, então um
    // espaço a mais é fácil de não notar ("database "foo " does not exist").
    const dbTrimmed = dbOverride?.trim();
    return new MonitoredPgClient({
      hosts: c.hosts,
      database: dbTrimmed || c.database,
      user: cred.user, password: cred.password, ssl: cred.ssl ?? false,
    });
  }

  /**
   * Lista todas as databases "reais" do servidor (exclui templates e bancos
   * que não aceitam conexão), pra coletar dados de todas elas — não só da
   * que foi configurada no cluster. O cluster normalmente é cadastrado com
   * user=postgres/database=postgres (banco de manutenção), que raramente
   * tem tabelas de usuário — por isso "Saúde"/"Sugestões de índice"
   * apareciam vazios mesmo com tráfego real em outro banco do servidor.
   */
  private async listServerDatabases(client: MonitoredPgClient): Promise<string[]> {
    const rows = await client.query<any>(`
      SELECT datname FROM pg_database
      WHERE datistemplate = false AND datallowconn = true
      ORDER BY datname
    `);
    return rows.map((r) => r.datname as string);
  }

  private async pollCluster(c: ClusterRow) {
    const client = await this.getClient(c);
    try {
      // ---------- pg_stat_database (delta TPS + cache hit) ----------
      const stat = await client.query<any>(`
        SELECT
          sum(numbackends)::int AS backends,
          sum(xact_commit)::bigint AS commits,
          sum(xact_rollback)::bigint AS rollbacks,
          sum(blks_hit)::bigint AS hit,
          sum(blks_read)::bigint AS read,
          coalesce(pg_database_size(current_database()), 0)::bigint AS db_size
        FROM pg_stat_database
        WHERE datname = current_database()
      `);
      const s = stat[0] || {};

      const conns = await client.query<any>(`
        SELECT
          count(*) FILTER (WHERE true)::int AS total,
          count(*) FILTER (WHERE state='active')::int AS active,
          count(*) FILTER (WHERE state='idle')::int AS idle,
          count(*) FILTER (WHERE state='idle in transaction')::int AS idle_xact
        FROM pg_stat_activity
      `);
      const max = await client.query<any>(`SHOW max_connections`);
      const maxConns = parseInt(max[0]?.max_connections ?? '100', 10);

      const bgw = await client.query<any>(`SELECT * FROM pg_stat_bgwriter`).catch(() => [{}]);
      const bg = bgw[0] || {};

      // replica lag (se estamos no primário)
      let lag = 0;
      try {
        const lagR = await client.query<any>(`
          SELECT coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0) AS lag
          FROM pg_stat_replication
        `);
        lag = Number(lagR[0]?.lag ?? 0);
      } catch { /* standby — sem replication info */ }

      const prev = this.prevTx.get(c.id);
      const nowMs = Date.now();
      const tps = prev
        ? ((Number(s.commits) + Number(s.rollbacks)) - (prev.commits + prev.rollbacks)) / Math.max(1, (nowMs - prev.ts) / 1000)
        : 0;
      this.prevTx.set(c.id, { commits: Number(s.commits ?? 0), rollbacks: Number(s.rollbacks ?? 0), ts: nowMs });

      const cacheHit = (Number(s.hit) + Number(s.read)) > 0
        ? (Number(s.hit) / (Number(s.hit) + Number(s.read))) * 100
        : 100;

      await this.pool.query(
        `INSERT INTO pg_metrics(ts, cluster_id, conn_total, conn_active, conn_idle, conn_idle_xact,
                                max_connections, tps, cache_hit_pct, db_size_bytes,
                                bgwriter_checkpoints_timed, bgwriter_checkpoints_req,
                                bgwriter_buffers_clean, replica_lag_bytes)
         VALUES (now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          c.id,
          conns[0].total, conns[0].active, conns[0].idle, conns[0].idle_xact,
          maxConns, tps, cacheHit, s.db_size,
          bg.checkpoints_timed ?? 0, bg.checkpoints_req ?? 0, bg.buffers_clean ?? 0,
          lag,
        ],
      );

      // ---------- top queries + saúde de tabelas, em TODAS as databases ----------
      // O cluster é cadastrado com uma única database (ex.: user=postgres,
      // database=postgres — o banco de manutenção padrão), mas o servidor
      // normalmente tem várias databases reais. Antes a coleta só rodava
      // contra a database configurada, então "Saúde"/"Sugestões de índice"
      // ficavam vazios sempre que essa database não fosse onde o tráfego de
      // verdade acontece. Agora listamos todas as databases do servidor e
      // coletamos de cada uma, tagueando as linhas com `datname`.
      let databases: string[];
      try {
        databases = await this.listServerDatabases(client);
      } catch (e: any) {
        this.logger.error(`listServerDatabases ${c.name}: ${e.message}`);
        databases = [c.database];
      }

      // pg_stat_statements precisa de CREATE EXTENSION em cada database
      // separadamente — é normal a extensão existir só na database principal
      // e não nas outras (ex.: "template1" ou bancos administrativos). Por
      // isso só marcamos o cluster como "sem pg_stat_statements" se TODAS as
      // databases falharem; uma falha isolada numa database sem a extensão
      // não pode apagar a detecção correta vinda de outra que tem.
      let statStatementsOkAnywhere = false;
      let lastStatStatementsErr: string | null = null;

      for (const datname of databases) {
        const dbClient = datname === c.database ? client : await this.getClient(c, datname);
        try {
          // ---------- pg_stat_statements (top queries) — opcional ----------
          try {
            // pg_stat_statements é por instância (cobre todos os bancos do
            // servidor), não por conexão. Filtramos por dbid = banco atual
            // pra só guardar queries que realmente pertencem a esse banco
            // — senão o EXPLAIN depois falha com "relation ... does not
            // exist" porque a tabela referida não existe nesse banco.
            const top = await dbClient.query<any>(`
              SELECT queryid::bigint, query, calls, total_exec_time, mean_exec_time, rows,
                     shared_blks_hit, shared_blks_read
              FROM pg_stat_statements
              WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
              ORDER BY total_exec_time DESC
              LIMIT 50
            `);
            const placeholders: string[] = [];
            const params: any[] = [];
            let i = 1;
            for (const t of top) {
              placeholders.push(`(now(),$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
              params.push(c.id, datname, t.queryid, (t.query ?? '').slice(0, 8000),
                Number(t.calls), Number(t.total_exec_time), Number(t.mean_exec_time), Number(t.rows),
                Number(t.shared_blks_hit), Number(t.shared_blks_read));
            }
            if (placeholders.length) {
              await this.pool.query(
                `INSERT INTO pg_top_queries(ts, cluster_id, datname, queryid, query_text, calls,
                                            total_exec_ms, mean_exec_ms, rows, shared_blks_hit, shared_blks_read)
                 VALUES ${placeholders.join(',')}
                 ON CONFLICT DO NOTHING`,
                params,
              );
            }
            statStatementsOkAnywhere = true;
          } catch (e: any) {
            // Não escreve em pg_cluster_features aqui — uma falha isolada
            // numa database sem a extensão não pode sobrescrever a detecção
            // correta vinda de outra database do mesmo cluster. Decisão
            // final é tomada depois do loop, considerando todas as bases.
            lastStatStatementsErr = e.message;
          }

          // ---------- pg_stat_user_tables (saúde) ----------
          try {
            const tbl = await dbClient.query<any>(`
              SELECT schemaname, relname, n_live_tup, n_dead_tup,
                     last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
                     pg_total_relation_size(relid) AS total_size
              FROM pg_stat_user_tables
            `);
            const placeholders: string[] = [];
            const params: any[] = [];
            let i = 1;
            for (const t of tbl) {
              const dead = Number(t.n_dead_tup ?? 0);
              const live = Number(t.n_live_tup ?? 0);
              const pct = live + dead > 0 ? (dead / (live + dead)) * 100 : 0;
              placeholders.push(`(now(),$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
              params.push(
                c.id, datname, t.schemaname, t.relname, live, dead, pct,
                t.last_vacuum, t.last_autovacuum, t.last_analyze, t.last_autoanalyze, t.total_size,
              );
            }
            if (placeholders.length) {
              await this.pool.query(
                `INSERT INTO pg_table_health(ts, cluster_id, datname, schema_name, relname, n_live_tup,
                                              n_dead_tup, dead_pct, last_vacuum, last_autovacuum,
                                              last_analyze, last_autoanalyze, total_size_bytes)
                 VALUES ${placeholders.join(',')}`,
                params,
              );
            }
          } catch (e: any) {
            // Antes ficava em silêncio total — se isso falhasse na coleta, a
            // aba "Saúde" ficava pra sempre vazia sem nenhum jeito de saber
            // o motivo. Loga pra aparecer no log do backend.
            this.logger.error(`tableHealth collect ${c.name}/${datname}: ${e.message}`);
          }
        } catch (e: any) {
          this.logger.error(`coleta multi-db ${c.name}/${datname}: ${e.message}`);
        } finally {
          if (dbClient !== client) await dbClient.end();
        }
      }

      // Só registra "sem pg_stat_statements" se NENHUMA database do
      // cluster conseguiu ler a view — assim uma extensão ausente numa
      // database isolada não derruba a detecção correta vinda das outras.
      if (statStatementsOkAnywhere) {
        await this.pool.query(
          `INSERT INTO pg_cluster_features(cluster_id, has_pg_stat_statements, detected_at, last_error)
           VALUES ($1, true, now(), NULL)
           ON CONFLICT (cluster_id) DO UPDATE SET
             has_pg_stat_statements=true, detected_at=now(), last_error=NULL`,
          [c.id],
        ).catch(() => {});
      } else if (lastStatStatementsErr && /pg_stat_statements|relation .* does not exist/i.test(lastStatStatementsErr)) {
        await this.pool.query(
          `INSERT INTO pg_cluster_features(cluster_id, has_pg_stat_statements, detected_at, last_error)
           VALUES ($1, false, now(), $2)
           ON CONFLICT (cluster_id) DO UPDATE SET
             has_pg_stat_statements=false, detected_at=now(), last_error=EXCLUDED.last_error`,
          [c.id, lastStatStatementsErr.slice(0, 500)],
        ).catch(() => {});
      }

      // ---------- Avalia alertas ----------
      await this.evaluateAlerts(c, {
        cacheHit, conn: conns[0].total, maxConns, lag,
        client,
      });
    } finally {
      await client.end();
    }
  }

  private async evaluateAlerts(
    c: ClusterRow,
    s: { cacheHit: number; conn: number; maxConns: number; lag: number; client: MonitoredPgClient },
  ) {
    const fired: string[] = [];

    // 1) Conexões > 80% do max
    if (s.conn > s.maxConns * 0.8) {
      fired.push(`Conexões ${s.conn}/${s.maxConns} (>80%)`);
    }

    // 2) Cache hit < 95%
    if (s.cacheHit < 95) {
      fired.push(`Cache hit baixo: ${s.cacheHit.toFixed(1)}%`);
    }

    // 3) Replica lag > 100MB
    if (s.lag > 100 * 1024 * 1024) {
      fired.push(`Replica lag ${(s.lag / 1024 / 1024).toFixed(1)} MB`);
    }

    // 4) Query rodando há mais de 2 min
    try {
      const slow = await s.client.query<any>(`
        SELECT pid, state, now() - query_start AS dur, left(query, 200) AS query
        FROM pg_stat_activity
        WHERE state='active' AND now() - query_start > interval '2 minutes'
      `);
      if (slow.length > 0) {
        fired.push(`${slow.length} query(s) rodando há mais de 2 minutos`);
      }
    } catch { /* ignore */ }

    // 5) Lock chain detectado
    try {
      const locks = await s.client.query<any>(`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE pg_blocking_pids(pid) <> '{}'::int[]
      `);
      if ((locks[0]?.n ?? 0) > 0) fired.push(`Lock chain detectado (${locks[0].n} sessões bloqueadas)`);
    } catch { /* ignore */ }

    // 6) Tabela com bloat alto
    try {
      const bloat = await s.client.query<any>(`
        SELECT count(*)::int AS n FROM pg_stat_user_tables
        WHERE n_dead_tup > 10000 AND n_live_tup > 0
          AND (n_dead_tup::float / (n_live_tup + n_dead_tup)) > 0.20
      `);
      if ((bloat[0]?.n ?? 0) > 0) fired.push(`${bloat[0].n} tabela(s) com bloat > 20%`);
    } catch { /* ignore */ }

    if (!fired.length) return;
    // Notifica todos os canais (via tag específica seria ideal — para MVP, todos)
    const channels = await this.pool.query(`SELECT id FROM notification_channels WHERE enabled=true LIMIT 5`);
    if (channels.rowCount) {
      await this.notif.sendToChannelIds(
        channels.rows.map((x) => x.id),
        {
          title: `[PG ${c.name}] alertas detectados`,
          message: fired.join('\n'),
          severity: 'warning',
          meta: { cluster: c.name },
        },
      );
    }
  }

  // ---------- Queries pra UI ----------
  async dashboard(clusterId: string, minutes = 60) {
    const series = await this.pool.query(
      `SELECT ts, conn_total AS conn, tps, cache_hit_pct AS cache, db_size_bytes AS size,
              replica_lag_bytes AS lag
       FROM pg_metrics WHERE cluster_id=$1 AND ts >= now() - ($2 || ' minutes')::interval
       ORDER BY ts ASC`,
      [clusterId, minutes],
    );
    const last = await this.pool.query(
      `SELECT * FROM pg_metrics WHERE cluster_id=$1 ORDER BY ts DESC LIMIT 1`,
      [clusterId],
    );
    return { series: series.rows, last: last.rows[0] ?? null };
  }

  async activeQueries(clusterId: string) {
    return this.withSharedCache(`active:${clusterId}`, 4000, async () => {
      const c = await this.cluster(clusterId);
      const client = await this.getClient(c);
      try {
        return client.query(`
          SELECT pid, datname, usename, state, wait_event, wait_event_type,
                 client_addr::text AS client_addr, application_name,
                 -- "duração": tempo desde que a query/estado atual começou
                 extract(epoch from now() - query_start)::int AS dur_sec,
                 now() - query_start AS dur,
                 -- "conectado há": idade da conexão em si (backend_start),
                 -- diferente de dur_sec — uma sessão idle pode ter sido
                 -- aberta há horas e ter rodado a última query há segundos,
                 -- ou (como num connection storm) ter sido aberta agora mesmo.
                 extract(epoch from now() - backend_start)::int AS conn_age_sec,
                 left(query, 4000) AS query
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND query IS NOT NULL
          ORDER BY query_start ASC
        `);
      } finally { await client.end(); }
    });
  }

  async lockChain(clusterId: string) {
    return this.withSharedCache(`locks:${clusterId}`, 4000, async () => {
      const c = await this.cluster(clusterId);
      const client = await this.getClient(c);
      try {
        return client.query(`
          SELECT pid, usename, datname, state,
                 pg_blocking_pids(pid) AS blocking,
                 left(query, 200) AS query,
                 extract(epoch from now() - query_start)::int AS dur_sec
          FROM pg_stat_activity
          WHERE pg_blocking_pids(pid) <> '{}'::int[]
             OR pid IN (SELECT unnest(pg_blocking_pids(p2.pid)) FROM pg_stat_activity p2)
        `);
      } finally { await client.end(); }
    });
  }

  async topQueries(clusterId: string, limit = 30) {
    // Agrupa por datname também — o mesmo queryid pode existir em mais de
    // uma database do servidor (textos parecidos, planos diferentes), e o
    // EXPLAIN precisa saber em qual database rodar.
    const r = await this.pool.query(
      `SELECT queryid, datname, query_text, max(total_exec_ms) AS total_ms,
              max(mean_exec_ms) AS mean_ms, max(calls) AS calls, max(rows) AS rows
       FROM pg_top_queries
       WHERE cluster_id=$1 AND ts >= now() - interval '1 hour'
       GROUP BY queryid, datname, query_text
       ORDER BY total_ms DESC
       LIMIT $2`,
      [clusterId, limit],
    );
    return r.rows;
  }

  async tableHealth(clusterId: string) {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (datname, schema_name, relname)
              datname, schema_name, relname, n_live_tup, n_dead_tup, dead_pct,
              last_autovacuum, last_autoanalyze, total_size_bytes
       FROM pg_table_health
       WHERE cluster_id=$1 AND ts >= now() - interval '1 day'
       ORDER BY datname, schema_name, relname, ts DESC`,
      [clusterId],
    );
    return r.rows;
  }

  // ---------- Ações ----------
  async terminate(clusterId: string, pid: number) {
    const c = await this.cluster(clusterId);
    const client = await this.getClient(c);
    try {
      const r = await client.query<any>(`SELECT pg_terminate_backend($1) AS ok`, [pid]);
      // invalida o cache compartilhado pra esse cluster — sem isso, o reload
      // que a tela faz na sequência podia devolver a lista de antes do kill
      // (ainda dentro da janela do cache) e parecer que não funcionou.
      this.sharedCache.delete(`active:${clusterId}`);
      this.sharedCache.delete(`locks:${clusterId}`);
      return { ok: !!r[0]?.ok };
    } finally { await client.end(); }
  }

  async explain(clusterId: string, query: string, analyze = false, params?: any[], database?: string) {
    const c = await this.cluster(clusterId);
    if (!/^\s*(SELECT|WITH)\b/i.test(query)) {
      throw new ForbiddenException('EXPLAIN só permitido em SELECT/WITH');
    }
    // O texto vindo de "top queries" é normalizado pelo pg_stat_statements:
    // valores literais (números, strings, etc.) são substituídos por
    // marcadores de posição $1, $2, ... Para conseguir gerar o plano mesmo
    // assim, deixamos o cliente informar os valores reais — e usamos o
    // próprio protocolo de bind do Postgres pra "preencher" esses $N, em vez
    // de fazer substituição de texto (evita problemas de escaping/injection).
    const placeholderNums = Array.from(query.matchAll(/\$(\d+)/g)).map((m) => parseInt(m[1], 10));
    const maxParam = placeholderNums.length ? Math.max(...placeholderNums) : 0;
    if (maxParam > 0 && (!params || params.length < maxParam)) {
      throw new BadRequestException(
        `Esta query foi normalizada pelo pg_stat_statements: os valores literais foram substituídos por ${maxParam} parâmetro(s) (${Array.from(new Set(placeholderNums)).sort((a, b) => a - b).map((n) => `$${n}`).join(', ')}). Informe os valores reais para gerar o EXPLAIN.`,
      );
    }
    // A query de "top queries" agora pode vir de qualquer database do
    // servidor (não só a configurada no cluster) — conecta na database
    // certa quando informada, senão cai no comportamento antigo.
    const client = await this.getClient(c, database);
    try {
      const sql = analyze
        ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
        : `EXPLAIN (FORMAT JSON) ${query}`;
      // Sem placeholders: chamamos via queryRaw(), que nunca passa um array
      // de params pro driver (nem vazio). Passar `[]` explicitamente força o
      // protocolo "extended query" (Parse/Bind) e qualquer "$1" literal no
      // SQL (ex. dentro de uma string ou subquery) seria interpretado como
      // parâmetro a bindar, quebrando com "there is no parameter $1" mesmo
      // sem placeholders reais. Com placeholders reais, usamos query() com
      // os valores informados — aí o bind é exatamente o que queremos.
      const r = maxParam > 0
        ? await client.query<any>(sql, params!.slice(0, maxParam))
        : await client.queryRaw<any>(sql);
      // pg retorna em coluna "QUERY PLAN"
      return r[0]?.['QUERY PLAN'] ?? r;
    } finally { await client.end(); }
  }

  async indexSuggestions(clusterId: string) {
    // Heurística: tabelas com seq_scan muito > idx_scan. Percorre TODAS as
    // databases do servidor (não só a configurada no cluster) — mesmo
    // motivo do pollCluster: a database configurada (geralmente "postgres")
    // raramente tem tabelas de usuário de verdade. Cacheado por 10s e
    // compartilhado entre usuários, já que agora abre 1 conexão por
    // database em vez de só 1 conexão total.
    return this.withSharedCache(`hints:${clusterId}`, 10000, async () => {
      const c = await this.cluster(clusterId);
      const main = await this.getClient(c);
      let databases: string[];
      try {
        databases = await this.listServerDatabases(main);
      } catch {
        databases = [c.database];
      } finally {
        await main.end();
      }

      const out: any[] = [];
      for (const datname of databases) {
        const client = await this.getClient(c, datname);
        try {
          const rows = await client.query<any>(`
            SELECT schemaname AS schema, relname AS table,
                   seq_scan, idx_scan, n_live_tup,
                   'seq_scan/idx_scan ratio: ' ||
                     round(seq_scan::numeric / nullif(idx_scan,0), 2) AS hint
            FROM pg_stat_user_tables
            WHERE seq_scan > 1000 AND (idx_scan IS NULL OR seq_scan > 10 * coalesce(idx_scan,0))
              AND n_live_tup > 1000
            ORDER BY seq_scan DESC
            LIMIT 30
          `);
          for (const r of rows) out.push({ datname, ...r });
        } catch (e: any) {
          this.logger.error(`indexSuggestions ${c.name}/${datname}: ${e.message}`);
        } finally {
          await client.end();
        }
      }
      out.sort((a, b) => Number(b.seq_scan ?? 0) - Number(a.seq_scan ?? 0));
      return out.slice(0, 30);
    });
  }

  /**
   * Wrapper público de cluster()+getClient() pra módulos fora do pg-monitor
   * (ex.: db-access) reusarem a mesma resolução de credenciais/vault sem
   * duplicar a lógica. Quem chama é responsável por client.end().
   */
  async getAdhocClient(clusterId: string, database?: string): Promise<{ cluster: ClusterRow; client: MonitoredPgClient }> {
    const cluster = await this.cluster(clusterId);
    const client = await this.getClient(cluster, database);
    return { cluster, client };
  }

  async listClustersBasic(): Promise<Array<{ id: string; name: string; database: string }>> {
    const r = await this.pool.query<any>(
      `SELECT id, name, database FROM pg_clusters WHERE deleted_at IS NULL ORDER BY name`,
    );
    return r.rows;
  }

  private async cluster(id: string): Promise<ClusterRow> {
    const r = await this.pool.query<ClusterRow>(
      `SELECT * FROM pg_clusters WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException('cluster not found');
    return r.rows[0];
  }
}
