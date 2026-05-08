import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface ContainerInfo {
  containerId: string;
  name: string;
  image?: string;
  state?: string;
  status?: string;
  health?: string;
  restartCount?: number;
  startedAt?: string;
  finishedAt?: string;
  ports?: any;
  labels?: any;
}

@Injectable()
export class ContainersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async upsertBatch(serverId: string, containers: ContainerInfo[]) {
    if (!containers.length) return { ok: true, count: 0 };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const c of containers) {
        await client.query(
          `INSERT INTO containers(server_id, container_id, name, image, state, status, health,
                                  restart_count, started_at, finished_at, ports, labels, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (server_id, container_id)
           DO UPDATE SET name=EXCLUDED.name, image=EXCLUDED.image,
             state=EXCLUDED.state, status=EXCLUDED.status, health=EXCLUDED.health,
             restart_count=EXCLUDED.restart_count, started_at=EXCLUDED.started_at,
             finished_at=EXCLUDED.finished_at, ports=EXCLUDED.ports, labels=EXCLUDED.labels,
             last_seen_at=now()`,
          [
            serverId,
            c.containerId,
            c.name,
            c.image ?? null,
            c.state ?? null,
            c.status ?? null,
            c.health ?? null,
            c.restartCount ?? null,
            c.startedAt ?? null,
            c.finishedAt ?? null,
            c.ports ? JSON.stringify(c.ports) : null,
            c.labels ? JSON.stringify(c.labels) : null,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    return { ok: true, count: containers.length };
  }

  async listByServer(serverId: string) {
    const r = await this.pool.query(
      `SELECT container_id AS "containerId", name, image, state, status, health,
              restart_count AS "restartCount", started_at AS "startedAt",
              finished_at AS "finishedAt", ports, labels,
              last_seen_at AS "lastSeenAt"
       FROM containers WHERE server_id=$1 ORDER BY name ASC`,
      [serverId],
    );
    return r.rows;
  }

  async fleetSummary() {
    const r = await this.pool.query(`
      SELECT s.id AS "serverId", s.name AS "serverName",
             count(*) FILTER (WHERE c.state='running') AS running,
             count(*) FILTER (WHERE c.state='exited') AS exited,
             count(*) AS total
      FROM containers c
      JOIN servers s ON s.id = c.server_id
      GROUP BY s.id, s.name
      ORDER BY s.name`);
    return r.rows.map((x) => ({
      serverId: x.serverId,
      serverName: x.serverName,
      running: Number(x.running),
      exited: Number(x.exited),
      total: Number(x.total),
    }));
  }
}
