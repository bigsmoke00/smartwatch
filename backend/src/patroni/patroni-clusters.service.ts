import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface PatroniClusterRow {
  id: string;
  name: string;
  description?: string | null;
  nodes: string[];
  basicAuth?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const COLS = `id, name, description, nodes, basic_auth AS "basicAuth",
              enabled, created_at AS "createdAt", updated_at AS "updatedAt"`;

@Injectable()
export class PatroniClustersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list() {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM patroni_clusters WHERE deleted_at IS NULL ORDER BY name`,
    );
    return r.rows;
  }

  async get(id: string) {
    const r = await this.pool.query(
      `SELECT ${COLS} FROM patroni_clusters WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  async create(input: { name: string; description?: string; nodes: string[]; basicAuth?: string }) {
    const r = await this.pool.query(
      `INSERT INTO patroni_clusters(name, description, nodes, basic_auth)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [input.name, input.description ?? null, input.nodes, input.basicAuth ?? null],
    );
    return this.get(r.rows[0].id);
  }

  async update(
    id: string,
    input: { name?: string; description?: string; nodes?: string[]; basicAuth?: string; enabled?: boolean },
  ) {
    await this.get(id);
    const set: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (input.name !== undefined) { set.push(`name=$${i++}`); params.push(input.name); }
    if (input.description !== undefined) { set.push(`description=$${i++}`); params.push(input.description); }
    if (input.nodes !== undefined) { set.push(`nodes=$${i++}`); params.push(input.nodes); }
    if (input.basicAuth !== undefined) { set.push(`basic_auth=$${i++}`); params.push(input.basicAuth); }
    if (input.enabled !== undefined) { set.push(`enabled=$${i++}`); params.push(input.enabled); }
    if (!set.length) return this.get(id);
    set.push(`updated_at=now()`);
    params.push(id);
    await this.pool.query(
      `UPDATE patroni_clusters SET ${set.join(', ')} WHERE id=$${i}`,
      params,
    );
    return this.get(id);
  }

  async remove(id: string) {
    await this.get(id);
    await this.pool.query(
      `UPDATE patroni_clusters SET deleted_at=now() WHERE id=$1`,
      [id],
    );
    return { ok: true };
  }
}
