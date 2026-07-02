import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface LogDoc {
  id?: string;                    // uuid — gerado em LogsService.ingest(), ANTES do insert
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
  repeatCount?: number;
}

export interface LogQuery {
  serverId?: string;
  containerName?: string;
  /**
   * Filtro por arquivo de /var/log (só faz sentido com source 'host' ou
   * 'all'). Vem do frontend SEM o prefixo 'host:' — aqui recolocamos o
   * prefixo antes de comparar, porque é assim que a coluna container_name
   * guarda esses valores (ver distinctFiles()).
   */
  fileName?: string;
  /**
   * 'host' = linhas de /var/log do agent (container_name = 'host:<arquivo>');
   * 'container' = linhas de containers docker; 'all'/undefined = sem filtro.
   * Filtrar isso aqui (antes do LIMIT) é o que faz o filtro de fonte
   * funcionar de fato — antes era aplicado só no client DEPOIS da página já
   * vir limitada a 500 linhas mais recentes, então se essas 500 linhas mais
   * recentes fossem todas de containers (caso comum com containers
   * barulhentos), o filtro "Host" voltava vazio mesmo tendo dados — parecia
   * que o filtro "não funcionava" quando saía do padrão Tudo.
   */
  source?: 'all' | 'host' | 'container';
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

  /**
   * Insere um batch usando UNNEST (1 round-trip).
   *
   * O `id` agora é gerado ANTES (em LogsService.ingest(), ver randomUUID())
   * e passado explicitamente aqui — antes dependíamos do DEFAULT
   * gen_random_uuid() da coluna, então o `id` só existia depois do INSERT, e
   * nunca chegava no payload emitido via WebSocket (emitBatch recebe os
   * MESMOS objetos `acceptedDocs` que viraram esse insert). Resultado: toda
   * linha vista via tail ao vivo tinha `id` undefined, e o frontend caía no
   * fallback de key `ts+message` — que colide pra linhas idênticas repetidas
   * (comum em stack traces nível "unknown"), fazendo o React reaproveitar o
   * mesmo nó de DOM pra linhas logicamente diferentes ("linha presa" enquanto
   * o resto da lista rola normalmente). Gerando o id antes, o mesmo valor
   * vai pro banco E pro WS — sempre único, sempre presente.
   */
  async insertBatch(docs: LogDoc[]): Promise<void> {
    if (!docs.length) return;
    const ts = docs.map((d) => d.ts);
    const ids = docs.map((d) => d.id ?? randomUUID());
    const sid = docs.map((d) => d.serverId);
    const sname = docs.map((d) => d.serverName);
    const cid = docs.map((d) => d.containerId ?? null);
    const cname = docs.map((d) => d.containerName ?? null);
    const image = docs.map((d) => d.image ?? null);
    const stream = docs.map((d) => d.stream ?? null);
    const level = docs.map((d) => d.level ?? 'unknown');
    const msg = docs.map((d) => d.message.slice(0, 8192));
    const meta = docs.map((d) => (d.meta ? JSON.stringify(d.meta) : null));
    const repeatCount = docs.map((d) => d.repeatCount ?? 1);

    await this.pool.query(
      `INSERT INTO logs(ts, id, server_id, server_name, container_id, container_name,
                        image, stream, level, message, meta, repeat_count)
       SELECT *
       FROM UNNEST(
         $1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[],
         $5::text[], $6::text[], $7::text[],
         $8::text[], $9::text[], $10::text[], $11::jsonb[], $12::integer[]
       )`,
      [ts, ids, sid, sname, cid, cname, image, stream, level, msg, meta, repeatCount],
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
    if (filters.fileName) {
      where.push(`container_name = $${i++}`);
      params.push(`host:${filters.fileName}`);
    }
    if (filters.source === 'host') {
      where.push(`container_name LIKE 'host:%'`);
    } else if (filters.source === 'container') {
      where.push(`container_name IS NOT NULL AND container_name NOT LIKE 'host:%'`);
    }
    if (filters.level && filters.level.length) {
      where.push(`level = ANY($${i++}::text[])`);
      params.push(filters.level);
    }
    if (filters.q && filters.q.trim()) {
      where.push(`message ILIKE '%' || $${i} || '%'`);
      params.push(filters.q);
      i++;
    }

    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, filters.page ?? 1);
    // Teto subiu de 500 pra 5000: o limite de 500 era aplicado ANTES do
    // filtro de fonte no client (ver comment em LogQuery.source), então uma
    // janela de tempo dominada por containers barulhentos podia devolver
    // zero linhas de host mesmo havendo dados — pedir mais linhas (agora já
    // filtradas corretamente por fonte aqui no banco) resolve isso de fato.
    const pageSize = Math.min(5000, Math.max(1, filters.pageSize ?? 100));
    const offset = (page - 1) * pageSize;

    const sql = `
      SELECT id, ts, server_id AS "serverId", server_name AS "serverName",
             container_id AS "containerId", container_name AS "containerName",
             image, stream, level, message, meta,
             repeat_count AS "repeatCount"
      FROM logs
      ${w}
      ORDER BY ts DESC
      LIMIT ${pageSize} OFFSET ${offset}`;

    const countSql = `
      SELECT count(*)::bigint AS total,
             coalesce(sum(repeat_count), 0)::bigint AS occurrences
      FROM logs ${w}`;

    const [rows, count] = await Promise.all([
      this.pool.query(sql, params),
      this.pool.query(countSql, params),
    ]);

    return {
      total: Number(count.rows[0].total),
      occurrences: Number(count.rows[0].occurrences),
      page,
      pageSize,
      hits: rows.rows,
    };
  }

  /**
   * Containers distintos já vistos nos logs de um servidor — usado pelo
   * filtro "container específico" da tela de Logs. Olhamos a tabela `logs`
   * em vez do docker.sock em tempo real porque assim aparecem containers
   * que já pararam/foram removidos mas ainda têm log armazenado, e porque
   * não depende do agent estar respondendo nesse momento. Exclui as linhas
   * "host:..." (são arquivos de /var/log do host, não containers).
   */
  async distinctContainers(serverId: string): Promise<{ containerName: string; image: string | null }[]> {
    // Bound temporal (7 dias) é o que deixa isto RÁPIDO: sem ele o GROUP BY
    // varria a hypertable inteira (retenção até 14d) e a listagem demorava.
    // Com o corte por ts o TimescaleDB exclui os chunks antigos e só agrega os
    // recentes — cobre praticamente todo container ativo. Quem não loga há
    // mais de 7 dias sai do atalho (ainda dá pra usar o filtro de texto livre).
    const r = await this.pool.query(
      `SELECT container_name AS "containerName", max(image) AS image
       FROM logs
       WHERE server_id = $1
         AND ts >= now() - interval '7 days'
         AND container_name IS NOT NULL
         AND container_name NOT LIKE 'host:%'
       GROUP BY container_name
       ORDER BY container_name ASC
       LIMIT 500`,
      [serverId],
    );
    return r.rows;
  }

  /**
   * Arquivos de /var/log distintos já vistos nos logs "host" de um servidor
   * — usado pelo filtro "arquivo" da tela de Logs (analogamente a
   * distinctContainers, mas pro lado host: ao contrário do filtro de
   * container, aqui pegamos só as linhas QUE COMEÇAM com 'host:' e
   * devolvemos o nome já sem esse prefixo, que é só uma convenção do agent
   * pra diferenciar host de container nessa mesma coluna).
   */
  async distinctFiles(serverId: string): Promise<{ fileName: string }[]> {
    const r = await this.pool.query(
      `SELECT substring(container_name from 6) AS "fileName"
       FROM logs
       WHERE server_id = $1
         AND ts >= now() - interval '7 days'
         AND container_name LIKE 'host:%'
       GROUP BY container_name
       ORDER BY substring(container_name from 6) ASC
       LIMIT 500`,
      [serverId],
    );
    return r.rows;
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
      where.push(`message ILIKE '%' || $${i} || '%'`);
      params.push(filters.q);
      i++;
    }
    const w = 'WHERE ' + where.join(' AND ');

    const sql = `
      SELECT time_bucket('${intervalSql}', ts) AS bucket,
             level,
             sum(repeat_count)::bigint AS n
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
      where.push(`message ILIKE '%' || $${i} || '%'`);
      params.push(filter.q);
      i++;
    }
    const r = await this.pool.query(
      `SELECT coalesce(sum(repeat_count), 0)::bigint AS n
       FROM logs WHERE ${where.join(' AND ')}`,
      params,
    );
    return r.rows[0].n;
  }
}
