import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { SecretsService } from '../secrets/secrets.service';
import { AwsCostExplorerClient } from './aws-cost.client';
import { OciUsageClient } from './oci-usage.client';

export interface CostRow {
  ts: string;            // ISO date (start of day)
  cloud: 'aws' | 'oci' | 'gcp' | 'azure';
  account: string;
  service: string;
  region?: string;
  cost: number;
  currency?: string;
  usageQty?: number;
  usageUnit?: string;
  tags?: Record<string, any>;
}

@Injectable()
export class FinopsService {
  private readonly logger = new Logger('FinopsService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly secrets: SecretsService,
    private readonly aws: AwsCostExplorerClient,
    private readonly oci: OciUsageClient,
  ) {}

  // ---------------------------------------------------------------- Ingestão
  async insertCostRows(rows: CostRow[]) {
    if (!rows.length) return { ok: true, count: 0 };
    const params: any[] = [];
    const placeholders: string[] = [];
    let i = 1;
    for (const r of rows) {
      placeholders.push(
        `($${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`,
      );
      params.push(
        r.ts, r.cloud, r.account, r.service, r.region ?? null,
        r.currency ?? 'USD', r.cost, r.usageQty ?? null, r.usageUnit ?? null,
        r.tags ? JSON.stringify(r.tags) : null,
      );
    }
    await this.pool.query(
      `INSERT INTO finops_costs(ts, cloud, account, service, region, currency,
                                cost, usage_qty, usage_unit, tags)
       VALUES ${placeholders.join(',')}
       ON CONFLICT (ts, cloud, account, service, region) DO UPDATE
         SET cost = EXCLUDED.cost,
             usage_qty = EXCLUDED.usage_qty,
             tags = EXCLUDED.tags`,
      params,
    );
    return { ok: true, count: rows.length };
  }

  // ---------------------------------------------------------------- Sync (executado por cron)
  /** Roda diariamente às 02:00 UTC. */
  @Cron('0 2 * * *')
  async dailySync() {
    this.logger.log('Starting daily FinOps sync');
    await Promise.allSettled([this.syncAws(), this.syncOci()]);
  }

  async syncAws(daysBack = 7) {
    try {
      const accessKeyId = await this.secrets.get('aws_access_key_id').catch(() => null);
      const secretAccessKey = await this.secrets.get('aws_secret_access_key').catch(() => null);
      if (!accessKeyId || !secretAccessKey) {
        this.logger.warn('AWS credentials not in vault — skip syncAws');
        return { ok: false, message: 'AWS credentials missing in vault' };
      }
      const rows = await this.aws.fetchDailyCosts({
        accessKeyId,
        secretAccessKey,
        daysBack,
      });
      const count = await this.insertCostRows(rows).then((r) => r.count);
      return { ok: true, count };
    } catch (e: any) {
      this.logger.error(`syncAws: ${e.message}`);
      return { ok: false, message: e.message };
    }
  }

  async syncOci(daysBack = 7) {
    try {
      const tenancy = await this.secrets.get('oci_tenancy').catch(() => null);
      if (!tenancy) {
        this.logger.warn('OCI credentials not in vault — skip syncOci');
        return { ok: false, message: 'OCI credentials missing in vault' };
      }
      const rows = await this.oci.fetchUsage({ tenancy, daysBack });
      const count = await this.insertCostRows(rows).then((r) => r.count);
      return { ok: true, count };
    } catch (e: any) {
      this.logger.error(`syncOci: ${e.message}`);
      return { ok: false, message: e.message };
    }
  }

  // ---------------------------------------------------------------- Queries
  async summary(filter: { cloud?: string; account?: string; days?: number }) {
    const days = filter.days ?? 30;
    const where: string[] = [`bucket >= now() - ($1 || ' days')::interval`];
    const params: any[] = [days];
    let i = 2;
    if (filter.cloud) { where.push(`cloud = $${i++}`); params.push(filter.cloud); }
    if (filter.account) { where.push(`account = $${i++}`); params.push(filter.account); }
    const w = 'WHERE ' + where.join(' AND ');

    const total = await this.pool.query(
      `SELECT coalesce(sum(cost),0)::float AS total, currency
       FROM finops_daily ${w}
       GROUP BY currency`,
      params,
    );

    const byService = await this.pool.query(
      `SELECT service, sum(cost)::float AS cost
       FROM finops_daily ${w}
       GROUP BY service ORDER BY cost DESC LIMIT 15`,
      params,
    );

    const byAccount = await this.pool.query(
      `SELECT cloud, account, sum(cost)::float AS cost
       FROM finops_daily ${w}
       GROUP BY cloud, account ORDER BY cost DESC`,
      params,
    );

    const series = await this.pool.query(
      `SELECT bucket AS ts, sum(cost)::float AS cost
       FROM finops_daily ${w}
       GROUP BY bucket ORDER BY bucket ASC`,
      params,
    );

    return {
      totals: total.rows,
      byService: byService.rows,
      byAccount: byAccount.rows,
      series: series.rows.map((r) => ({
        ts: new Date(r.ts).toISOString().slice(0, 10),
        cost: r.cost,
      })),
    };
  }

  // ---------------------------------------------------------------- Budgets
  async listBudgets() {
    const r = await this.pool.query(
      `SELECT id, cloud, account, service, monthly_limit AS "monthlyLimit",
              currency, alert_at_pct AS "alertAtPct", created_at AS "createdAt"
       FROM finops_budgets ORDER BY created_at DESC`,
    );
    return r.rows;
  }

  async createBudget(b: {
    cloud: string;
    account: string;
    service?: string;
    monthlyLimit: number;
    currency?: string;
    alertAtPct?: number;
  }) {
    const r = await this.pool.query(
      `INSERT INTO finops_budgets(cloud, account, service, monthly_limit, currency, alert_at_pct)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.cloud, b.account, b.service ?? null, b.monthlyLimit, b.currency ?? 'USD', b.alertAtPct ?? 80],
    );
    return r.rows[0];
  }

  async deleteBudget(id: string) {
    await this.pool.query(`DELETE FROM finops_budgets WHERE id=$1`, [id]);
    return { ok: true };
  }

  /** Calcula percentual usado neste mês para cada budget. */
  async budgetStatus() {
    const r = await this.pool.query(`
      SELECT b.id, b.cloud, b.account, b.service, b.monthly_limit AS "monthlyLimit",
             b.currency, b.alert_at_pct AS "alertAtPct",
             coalesce(c.spent, 0)::float AS spent
      FROM finops_budgets b
      LEFT JOIN (
        SELECT cloud, account, service,
               sum(cost)::float AS spent
        FROM finops_daily
        WHERE bucket >= date_trunc('month', now())
        GROUP BY cloud, account, service
      ) c ON c.cloud = b.cloud AND c.account = b.account
        AND (c.service = b.service OR (c.service IS NOT NULL AND b.service IS NULL))
    `);
    return r.rows.map((x) => ({
      ...x,
      spent: Number(x.spent ?? 0),
      pct: x.monthlyLimit ? (Number(x.spent) / Number(x.monthlyLimit)) * 100 : 0,
    }));
  }
}
