import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface LogDoc {
  ts: string;                     // ISO
  serverId: string;
  serverName: string;
  containerId?: string;
  containerName?: string;
  image?: string;
  stream?: 'stdout' | 'stderr';
  level?: string;
  message: string;
  meta?: Record<string, any>;
}

export interface LogQuery {
  serverId?: string;
  containerName?: string;
  level?: string[];
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

/** Resolve "now-15m", "now", ISO, ou epoch ms para timestamp do Postgres. */
function resolveTime(t?: string): string | null {
  if (!t) return null;
  const m = t.match(/^now(?:-(\d+)([smhdw]))?$/);
  if (m) {
    if (!m[1]) return 'now()';
    const units: Record<string, string> = {
      s: 'second',
      m: 'minute',
      h: 'hour',
      d: 'day',
      w: 'week',
    };
    return `now() - interval '${m[1]} ${units[m[2]]}'`;
  }
  return null; // sinal para usar parametrizado
}

@Injectable()
export class LogsRepository {
  private readonly logger = new Logger('LogsRepository');
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Insere um batch usando UNNEST (1 round-trip). */
  async insertBatch(docs: LogDoc[]): Promise<void> {
    if (!docs.length) return;
    const ts = docs.map((d) => d.ts);
    const ids: string[] = [];
    const sid = docs.map((d) => d.serverId);
    const sname = docs.map((d) => d.serverName);
    const cid = docs.map((d) => d.containerId ?? null);
    const cname = docs.map((d) => d.containerName ?? null);
    const image = docs.map((d) => d.image ?? null);
    const stream = docs.map((d) => d.stream ?? null);
    const level = docs.map((d) => d.level ?? 'unknown');
    const msg = docs.map((d) => d.message.slice(0, 64_000));
    const meta = docs.map((d) => (d.meta ? JSON.stringify(d.meta) : null));

    await this.pool.query(
      `INSERT INTO logs(ts, server_id, server_name, container_id, container_name,
                        image, stream, level, message, meta)
       SELECT *
       FROM UNNEST(
         $1::timestamptz[], $2::uuid[], $3::text[],
         $4::text[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::text[], $10::jsonb[]
       )`,
      [ts, sid, sname, cid, cname, image, stream, level, msg, meta],
    );
  }

  /** Query com filtros + FTS + paginação. */
  async query(filters: LogQuery) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    const fromExpr = resolveTime(filters.from);
    const toExpr = resolveTime(filters.to);
    if (filters.from) {
      if (fromExpr) where.push(`ts >= ${fromExpr}`);
      else {
        where.push(`ts >= $${i++}`);
        params.push(filters.from);
      }
    }
    if (filters.to) {
      if (toExpr) where.push(`ts <= ${toExpr}`);
      else {
        where.push(`ts <= $${i++}`);
        params.push(filters.to);
      }
    }
    if (filters.serverId) {
      where.push(`server_id = $${i++}`);
      params.push(filters.serverId);
    }
    if (filters.containerName) {
      where.push(`container_name = $${i++}`);
      params.push(filters.containerName);
    }
    if (filters.level && filters.level.length) {
      where.push(`level = ANY($${i++}::text[])`);
      params.push(filters.level);
    }
    if (filters.q && filters.q.trim()) {
      // Mistura FTS + trigram para fuzzy. Aceita aspas e operadores básicos.
      where.push(`(fts @@ websearch_to_tsquery('simple', $${i}) OR message ILIKE '%' || $${i} || '%')`);
      params.push(filters.q);
      i++;
    }

    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, filters.pageSize ?? 100));
    const offset = (page - 1) * pageSize;

    const sql = `
      SELECT id, ts, server_id AS "serverId", server_name AS "serverName",
             container_id AS "containerId", container_name AS "containerName",
             image, stream, level, message, meta
      FROM logs
      ${w}
      ORDER BY ts DESC
      LIMIT ${pageSize} OFFSET ${offset}`;

    const countSql = `SELECT count(*)::bigint AS total FROM logs ${w}`;

    const [rows, count] = await Promise.all([
      this.pool.query(sql, params),
      this.pool.query(countSql, params),
    ]);

    return {
      total: Number(count.rows[0].total),
      page,
      pageSize,
      hits: rows.rows,
    };
  }

  /** Histograma usando o continuous aggregate quando possível, senão raw. */
  async histogram(
    filters: LogQuery,
    intervalSql = '1 minute',
  ): Promise<{ ts: string; total: number; byLevel: Record<string, number> }[]> {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;

    const fromExpr = resolveTime(filters.from);
    const toExpr = resolveTime(filters.to);
    where.push(fromExpr ? `ts >= ${fromExpr}` : `ts >= $${i++}`);
    if (!fromExpr) params.push(filters.from ?? new Date(Date.now() - 3_600_000).toISOString());
    where.push(toExpr ? `ts <= ${toExpr}` : `ts <= $${i++}`);
    if (!toExpr) params.push(filters.to ?? new Date().toISOString());

    if (filters.serverId) {
      where.push(`server_id = $${i++}`);
      params.push(filters.serverId);
    }
    if (filters.q?.trim()) {
      where.push(`(fts @@ websearch_to_tsquery('simple', $${i}) OR message ILIKE '%' || $${i} || '%')`);
      params.push(filters.q);
      i++;
    }
    const w = 'WHERE ' + where.join(' AND ');

    const sql = `
      SELECT time_bucket('${intervalSql}', ts) AS bucket,
             level,
             count(*)::int AS n
      FROM logs ${w}
      GROUP BY 1, 2
      ORDER BY 1 ASC`;

    const r = await this.pool.query(sql, params);
    const map = new Map<string, { ts: string; total: number; byLevel: Record<string, number> }>();
    for (const row of r.rows) {
      const ts = new Date(row.bucket).toISOString();
      const cur = map.get(ts) ?? { ts, total: 0, byLevel: {} };
      cur.byLevel[row.level] = (cur.byLevel[row.level] ?? 0) + Number(row.n);
      cur.total += Number(row.n);
      map.set(ts, cur);
    }
    return Array.from(map.values());
  }

  /** Para alertas: conta hits no último N minutos com filtro. */
  async countWindow(
    filter: LogQuery,
    windowMinutes: number,
  ): Promise<number> {
    const params: any[] = [windowMinutes];
    let i = 2;
    const where: string[] = [`ts >= now() - ($1 || ' minutes')::interval`];
    if (filter.serverId) {
      where.push(`server_id = $${i++}`);
      params.push(filter.serverId);
    }
    if (filter.containerName) {
      where.push(`container_name = $${i++}`);
      params.push(filter.containerName);
    }
    if (filter.level && filter.level.length) {
      where.push(`level = ANY($${i++}::text[])`);
      params.push(filter.level);
    }
    if (filter.q?.trim()) {
      where.push(`(fts @@ websearch_to_tsquery('simple', $${i}) OR message ILIKE '%' || $${i} || '%')`);
      params.push(filter.q);
      i++;
    }
    const r = await this.pool.query(
      `SELECT count(*)::int AS n FROM logs WHERE ${where.join(' AND ')}`,
      params,
    );
    return r.rows[0].n;
  }
}
