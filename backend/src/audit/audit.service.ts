import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

export interface AuditEvent {
  actorId?: string | null;
  actorEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, any> | null;
  result?: 'ok' | 'denied' | 'error';
}

@Injectable()
export class AuditService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(ev: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events(actor_id, actor_email, ip, user_agent,
                               action, target_type, target_id, metadata, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        ev.actorId ?? null,
        ev.actorEmail ?? null,
        ev.ip ?? null,
        ev.userAgent ?? null,
        ev.action,
        ev.targetType ?? null,
        ev.targetId ?? null,
        ev.metadata ? JSON.stringify(ev.metadata) : null,
        ev.result ?? 'ok',
      ],
    );
  }

  async list(filters: {
    actorId?: string;
    action?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  }) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (filters.actorId) {
      where.push(`actor_id = $${i++}`);
      params.push(filters.actorId);
    }
    if (filters.action) {
      where.push(`action ILIKE $${i++}`);
      params.push(`%${filters.action}%`);
    }
    if (filters.from) {
      where.push(`ts >= $${i++}`);
      params.push(filters.from);
    }
    if (filters.to) {
      where.push(`ts <= $${i++}`);
      params.push(filters.to);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(500, Math.max(1, filters.pageSize ?? 100));

    const sql = `
      SELECT id, ts, actor_id AS "actorId", actor_email AS "actorEmail",
             ip::text AS ip, user_agent AS "userAgent", action,
             target_type AS "targetType", target_id AS "targetId",
             metadata, result
      FROM audit_events ${w}
      ORDER BY ts DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
    const r = await this.pool.query(sql, params);
    return { hits: r.rows, page, pageSize };
  }
}
