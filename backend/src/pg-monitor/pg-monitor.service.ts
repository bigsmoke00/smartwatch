import {
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

  private async getClient(c: ClusterRow): Promise<MonitoredPgClient> {
    const raw = await this.secrets.get(c.vault_secret);
    const cred = JSON.parse(raw);   // { user, password, ssl? }
    return new MonitoredPgClient({
      hosts: c.hosts,
      database: c.database,
      user: cred.user, password: cred.password, ssl: cred.ssl ?? false,
    });
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

      // ---------- pg_stat_statements (top queries) — opcional ----------
      try {
        const top = await client.query<any>(`
          SELECT queryid::bigint, query, calls, total_exec_time, mean_exec_time, rows,
                 shared_blks_hit, shared_blks_read
          FROM pg_stat_statements
          ORDER BY total_exec_time DESC
          LIMIT 50
        `);
        const placeholders: string[] = [];
        const params: any[] = [];
        let i = 1;
        for (const t of top) {
          placeholders.push(`(now(),$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
          params.push(c.id, t.queryid, (t.query ?? '').slice(0, 8000),
            Number(t.calls), Number(t.total_exec_time), Number(t.mean_exec_time), Number(t.rows),
            Number(t.shared_blks_hit), Number(t.shared_blks_read));
        }
        if (placeholders.length) {
          await this.pool.query(
            `INSERT INTO pg_top_queries(ts, cluster_id, queryid, query_text, calls, total_exec_ms,
                                        mean_exec_ms, rows, shared_blks_hit, shared_blks_read)
             VALUES ${placeholders.join(',')}
             ON CONFLICT DO NOTHING`,
            params,
          );
        }
      } catch (e: any) {
        // pg_stat_statements pode não estar habilitado — registra no cache
        // pra UI mostrar aviso amigável em vez de quebrar.
        if (/pg_stat_statements|relation .* does not exist/i.test(e.message)) {
          await this.pool.query(
            `INSERT INTO pg_cluster_features(cluster_id, has_pg_stat_statements, detected_at, last_error)
             VALUES ($1, false, now(), $2)
             ON CONFLICT (cluster_id) DO UPDATE SET
               has_pg_stat_statements=false, detected_at=now(), last_error=EXCLUDED.last_error`,
            [c.id, e.message.slice(0, 500)],
          ).catch(() => {});
        }
      }

      // ---------- pg_stat_user_tables (saúde) ----------
      try {
        const tbl = await client.query<any>(`
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
          placeholders.push(`(now(),$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
          params.push(
            c.id, t.schemaname, t.relname, live, dead, pct,
            t.last_vacuum, t.last_autovacuum, t.last_analyze, t.last_autoanalyze, t.total_size,
          );
        }
        if (placeholders.length) {
          await this.pool.query(
            `INSERT INTO pg_table_health(ts, cluster_id, schema_name, relname, n_live_tup, n_dead_tup,
                                          dead_pct, last_vacuum, last_autovacuum, last_analyze,
                                          last_autoanalyze, total_size_bytes)
             VALUES ${placeholders.join(',')}`,
            params,
          );
        }
      } catch { /* ignore */ }

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
    const c = await this.cluster(clusterId);
    const client = await this.getClient(c);
    try {
      return client.query(`
        SELECT pid, datname, usename, state, wait_event, wait_event_type,
               client_addr::text AS client_addr, application_name,
               extract(epoch from now() - query_start)::int AS dur_sec,
               now() - query_start AS dur,
               left(query, 4000) AS query
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND query IS NOT NULL
        ORDER BY query_start ASC
      `);
    } finally { await client.end(); }
  }

  async lockChain(clusterId: string) {
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
  }

  async topQueries(clusterId: string, limit = 30) {
    const r = await this.pool.query(
      `SELECT queryid, query_text, max(total_exec_ms) AS total_ms,
              max(mean_exec_ms) AS mean_ms, max(calls) AS calls, max(rows) AS rows
       FROM pg_top_queries
       WHERE cluster_id=$1 AND ts >= now() - interval '1 hour'
       GROUP BY queryid, query_text
       ORDER BY total_ms DESC
       LIMIT $2`,
      [clusterId, limit],
    );
    return r.rows;
  }

  async tableHealth(clusterId: string) {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (schema_name, relname)
              schema_name, relname, n_live_tup, n_dead_tup, dead_pct,
              last_autovacuum, last_autoanalyze, total_size_bytes
       FROM pg_table_health
       WHERE cluster_id=$1 AND ts >= now() - interval '1 day'
       ORDER BY schema_name, relname, ts DESC`,
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
      return { ok: !!r[0]?.ok };
    } finally { await client.end(); }
  }

  async explain(clusterId: string, query: string, analyze = false) {
    const c = await this.cluster(clusterId);
    if (!/^\s*(SELECT|WITH)\b/i.test(query)) {
      throw new ForbiddenException('EXPLAIN só permitido em SELECT/WITH');
    }
    const client = await this.getClient(c);
    try {
      const sql = analyze
        ? `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
        : `EXPLAIN (FORMAT JSON) ${query}`;
      const r = await client.query<any>(sql);
      // pg retorna em coluna "QUERY PLAN"
      return r[0]?.['QUERY PLAN'] ?? r;
    } finally { await client.end(); }
  }

  async indexSuggestions(clusterId: string) {
    // Heurística: tabelas com seq_scan muito > idx_scan
    const c = await this.cluster(clusterId);
    const client = await this.getClient(c);
    try {
      return client.query(`
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
    } finally { await client.end(); }
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
