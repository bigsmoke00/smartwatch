import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface HostMetricSample {
  ts?: string;
  cpuPct?: number;
  memUsedBytes?: number;
  memTotalBytes?: number;
  swapUsedBytes?: number;
  load1?: number;
  load5?: number;
  load15?: number;
  disk?: { mount: string; used: number; total: number; usedPct: number }[];
  net?: { iface: string; rxBps: number; txBps: number }[];
  procsTotal?: number;
  procsRunning?: number;
  uptimeSec?: number;
}

@Injectable()
export class MetricsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async ingest(serverId: string, samples: HostMetricSample[]) {
    if (!samples.length) return { accepted: 0 };
    const values: any[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const s of samples) {
      placeholders.push(
        `($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`,
      );
      values.push(
        s.ts ?? new Date().toISOString(),
        serverId,
        s.cpuPct ?? null,
        s.memUsedBytes ?? null,
        s.memTotalBytes ?? null,
        s.swapUsedBytes ?? null,
        s.load1 ?? null,
        s.load5 ?? null,
        s.load15 ?? null,
        s.disk ? JSON.stringify(s.disk) : null,
        s.net ? JSON.stringify(s.net) : null,
        s.procsTotal ?? null,
        s.procsRunning ?? null,
        s.uptimeSec ?? null,
      );
    }
    await this.pool.query(
      `INSERT INTO host_metrics(ts, server_id, cpu_pct, mem_used_bytes, mem_total_bytes,
                                swap_used_bytes, load1, load5, load15, disk, net,
                                procs_total, procs_running, uptime_sec)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (ts, server_id) DO NOTHING`,
      values,
    );
    return { accepted: samples.length };
  }

  async series(
    serverId: string,
    fromMinutes = 60,
    bucket = '1 minute',
  ) {
    const r = await this.pool.query(
      `SELECT time_bucket($2::interval, ts) AS bucket,
              avg(cpu_pct)::float AS cpu,
              avg(mem_used_bytes::float / nullif(mem_total_bytes,0)) * 100 AS mem_pct,
              avg(load1)::float AS load1,
              max(uptime_sec) AS uptime
       FROM host_metrics
       WHERE server_id=$1 AND ts >= now() - ($3 || ' minutes')::interval
       GROUP BY 1 ORDER BY 1 ASC`,
      [serverId, bucket, fromMinutes],
    );
    return r.rows.map((x) => ({
      ts: new Date(x.bucket).toISOString(),
      cpu: x.cpu,
      memPct: x.mem_pct,
      load1: x.load1,
      uptime: x.uptime,
    }));
  }

  async last(serverId: string) {
    const r = await this.pool.query(
      `SELECT ts, cpu_pct AS cpu, mem_used_bytes AS "memUsed",
              mem_total_bytes AS "memTotal", load1, load5, load15,
              disk, net, procs_total AS "procsTotal", procs_running AS "procsRunning",
              uptime_sec AS "uptimeSec"
       FROM host_metrics WHERE server_id=$1 ORDER BY ts DESC LIMIT 1`,
      [serverId],
    );
    return r.rows[0] ?? null;
  }

  async fleetSummary() {
    // Última métrica de cada servidor
    const r = await this.pool.query(`
      SELECT DISTINCT ON (m.server_id)
        m.server_id AS "serverId",
        s.name AS "serverName",
        s.cloud, s.cloud_region AS "cloudRegion",
        s.last_seen_at AS "lastSeenAt",
        m.ts, m.cpu_pct AS "cpu",
        (m.mem_used_bytes::float / nullif(m.mem_total_bytes, 0)) * 100 AS "memPct",
        m.load1
      FROM host_metrics m
      JOIN servers s ON s.id = m.server_id
      ORDER BY m.server_id, m.ts DESC
    `);
    return r.rows;
  }
}
