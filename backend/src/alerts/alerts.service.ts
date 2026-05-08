import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { LogsRepository } from '../logs/logs.repository';
import { NotificationsService } from '../notifications/notifications.service';

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  filter: {
    q?: string;
    level?: string[];
    serverId?: string;
    containerName?: string;
  };
  windowMinutes: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  channels: string[];
  cooldownMinutes: number;
  lastFiredAt?: Date | null;
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger('AlertsService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logs: LogsRepository,
    private readonly notif: NotificationsService,
  ) {}

  async list(): Promise<AlertRule[]> {
    const r = await this.pool.query(
      `SELECT id, name, description, enabled, filter,
              window_minutes AS "windowMinutes", threshold, severity,
              channels::text[], cooldown_minutes AS "cooldownMinutes",
              last_fired_at AS "lastFiredAt"
       FROM alert_rules ORDER BY created_at DESC`,
    );
    return r.rows;
  }

  async create(rule: Partial<AlertRule>) {
    const r = await this.pool.query(
      `INSERT INTO alert_rules(name, description, enabled, filter, window_minutes,
                               threshold, severity, channels, cooldown_minutes)
       VALUES ($1,$2, coalesce($3,true), $4::jsonb, $5, $6, $7, $8::uuid[], $9)
       RETURNING id`,
      [
        rule.name,
        rule.description ?? null,
        rule.enabled ?? true,
        JSON.stringify(rule.filter ?? {}),
        rule.windowMinutes ?? 5,
        rule.threshold ?? 10,
        rule.severity ?? 'warning',
        rule.channels ?? [],
        rule.cooldownMinutes ?? 15,
      ],
    );
    return r.rows[0];
  }

  async update(id: string, rule: Partial<AlertRule>) {
    await this.pool.query(
      `UPDATE alert_rules SET
         name = coalesce($2, name),
         description = coalesce($3, description),
         enabled = coalesce($4, enabled),
         filter = coalesce($5::jsonb, filter),
         window_minutes = coalesce($6, window_minutes),
         threshold = coalesce($7, threshold),
         severity = coalesce($8, severity),
         channels = coalesce($9::uuid[], channels),
         cooldown_minutes = coalesce($10, cooldown_minutes),
         updated_at = now()
       WHERE id=$1`,
      [
        id,
        rule.name ?? null,
        rule.description ?? null,
        rule.enabled ?? null,
        rule.filter ? JSON.stringify(rule.filter) : null,
        rule.windowMinutes ?? null,
        rule.threshold ?? null,
        rule.severity ?? null,
        rule.channels ?? null,
        rule.cooldownMinutes ?? null,
      ],
    );
    return { ok: true };
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM alert_rules WHERE id=$1`, [id]);
    return { ok: true };
  }

  async events(ruleId?: string) {
    const sql = ruleId
      ? `SELECT * FROM alert_events WHERE rule_id=$1 ORDER BY ts DESC LIMIT 200`
      : `SELECT * FROM alert_events ORDER BY ts DESC LIMIT 200`;
    const r = await this.pool.query(sql, ruleId ? [ruleId] : []);
    return r.rows;
  }

  /** Avalia todas as regras a cada minuto. */
  @Cron(CronExpression.EVERY_MINUTE)
  async evaluate() {
    let rules: AlertRule[];
    try {
      rules = await this.list();
    } catch (e: any) {
      this.logger.error(`failed to list rules: ${e.message}`);
      return;
    }
    for (const rule of rules) {
      if (!rule.enabled) continue;
      try {
        const count = await this.logs.countWindow(
          rule.filter,
          rule.windowMinutes,
        );
        if (count < rule.threshold) continue;

        const cooldownPassed =
          !rule.lastFiredAt ||
          Date.now() - new Date(rule.lastFiredAt).getTime() >
            rule.cooldownMinutes * 60_000;
        if (!cooldownPassed) continue;

        await this.fire(rule, count);
      } catch (e: any) {
        this.logger.error(`rule ${rule.name} failed: ${e.message}`);
      }
    }
  }

  private async fire(rule: AlertRule, count: number) {
    const message = `Regra "${rule.name}" disparou: ${count} eventos em ${rule.windowMinutes}min (threshold ${rule.threshold}).`;

    await this.pool.query(
      `INSERT INTO alert_events(rule_id, rule_name, severity, message, count_observed, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        rule.id,
        rule.name,
        rule.severity,
        message,
        count,
        JSON.stringify({ filter: rule.filter, windowMinutes: rule.windowMinutes }),
      ],
    );

    await this.pool.query(
      `UPDATE alert_rules SET last_fired_at=now() WHERE id=$1`,
      [rule.id],
    );

    if (rule.channels?.length) {
      await this.notif.sendToChannelIds(rule.channels, {
        title: rule.name,
        message,
        severity: rule.severity,
        meta: { filter: rule.filter, count, windowMinutes: rule.windowMinutes },
      });
    }
  }
}
