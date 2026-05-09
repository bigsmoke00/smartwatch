import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { LogsRepository } from '../logs/logs.repository';

export interface Slo {
  id: string;
  name: string;
  description?: string;
  sliType: 'availability' | 'latency' | 'custom';
  filter: any;
  target: number;
  windowDays: number;
  enabled: boolean;
}

@Injectable()
export class SloService {
  private readonly logger = new Logger('SloService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logs: LogsRepository,
  ) {}

  async list(): Promise<Slo[]> {
    const r = await this.pool.query(
      `SELECT id, name, description, sli_type AS "sliType", filter, target,
              window_days AS "windowDays", enabled
       FROM slos ORDER BY name`,
    );
    return r.rows;
  }

  async create(s: Partial<Slo>) {
    const r = await this.pool.query(
      `INSERT INTO slos(name, description, sli_type, filter, target, window_days)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`,
      [
        s.name,
        s.description ?? null,
        s.sliType,
        JSON.stringify(s.filter ?? {}),
        s.target,
        s.windowDays ?? 28,
      ],
    );
    return r.rows[0];
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM slos WHERE id=$1`, [id]);
    return { ok: true };
  }

  /** Última snapshot + série temporal do SLO. */
  async detail(id: string) {
    const slo = (await this.pool.query(
      `SELECT * FROM slos WHERE id=$1`,
      [id],
    )).rows[0];
    if (!slo) return null;

    const snaps = await this.pool.query(
      `SELECT ts, sli_value AS sli, budget_remaining AS "budgetRemaining",
              good_events AS "goodEvents", total_events AS "totalEvents"
       FROM slo_snapshots WHERE slo_id=$1
         AND ts >= now() - ($2 || ' days')::interval
       ORDER BY ts ASC`,
      [id, slo.window_days],
    );
    return { slo, series: snaps.rows };
  }

  // ---------- Cálculo (job a cada 5 min) ----------
  @Cron(CronExpression.EVERY_5_MINUTES)
  async computeAll() {
    const slos = await this.list();
    for (const s of slos) {
      if (!s.enabled) continue;
      try { await this.computeOne(s); }
      catch (e: any) { this.logger.error(`compute ${s.name}: ${e.message}`); }
    }
  }

  private async computeOne(slo: Slo) {
    const windowMin = slo.windowDays * 24 * 60;
    if (slo.sliType === 'availability') {
      // good = total - errors no filtro
      const total = await this.logs.countWindow(slo.filter ?? {}, windowMin);
      // errors: mesma query mas levels error/fatal
      const filterErr = {
        ...(slo.filter ?? {}),
        level: ['error', 'fatal'],
      };
      const errors = await this.logs.countWindow(filterErr, windowMin);
      const good = Math.max(0, total - errors);
      const sli = total > 0 ? (good / total) * 100 : 100;
      const errorBudget = 100 - slo.target;     // ex: target 99.9 → 0.1% de budget
      const consumed = errorBudget > 0
        ? ((100 - sli) / errorBudget) * 100
        : 0;
      const remaining = Math.max(0, 100 - consumed);

      await this.pool.query(
        `INSERT INTO slo_snapshots(slo_id, good_events, total_events, sli_value, budget_remaining)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (ts, slo_id) DO NOTHING`,
        [slo.id, good, total, sli.toFixed(4), remaining.toFixed(4)],
      );
    } else if (slo.sliType === 'latency') {
      // SLI latency precisaria de uma métrica derivada de logs ou tracing.
      // Implementação simplificada: assume que `meta.duration_ms` está nos logs.
      // Para um sistema real, adicione índice em meta->>'duration_ms'.
      this.logger.debug(`SLI latency para ${slo.name} requer pipeline customizado`);
    }
  }
}
