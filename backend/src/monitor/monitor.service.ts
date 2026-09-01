import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { NotificationsService } from '../notifications/notifications.service';
import { probe, ProbeType } from './monitor.probers';
import { evaluateConditions, ConditionResult } from './monitor.conditions';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

interface MonitorEndpoint {
  id: string;
  name: string;
  groupName: string | null;
  type: ProbeType;
  target: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  dnsQueryType: string;
  intervalSeconds: number;
  timeoutMs: number;
  conditions: string[];
  followRedirects: boolean;
  insecureSkipVerify: boolean;
  failureThreshold: number;
  successThreshold: number;
  alertChannels: string[];
  enabled: boolean;
  lastCheckedAt: Date | null;
  lastStatus: 'pending' | 'up' | 'down';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

const SELECT_COLS = `
  id, name, group_name AS "groupName", type, target, method,
  request_headers AS "requestHeaders", request_body AS "requestBody",
  dns_query_type AS "dnsQueryType", interval_seconds AS "intervalSeconds",
  timeout_ms AS "timeoutMs", conditions, follow_redirects AS "followRedirects",
  insecure_skip_verify AS "insecureSkipVerify",
  failure_threshold AS "failureThreshold", success_threshold AS "successThreshold",
  alert_channels AS "alertChannels", enabled,
  last_checked_at AS "lastCheckedAt", last_status AS "lastStatus",
  consecutive_failures AS "consecutiveFailures",
  consecutive_successes AS "consecutiveSuccesses",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

@Injectable()
export class MonitorService {
  private readonly logger = new Logger('MonitorService');
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly notif: NotificationsService,
  ) {}

  // ============================================================ CRUD
  async summary() {
    const r = await this.pool.query(
      `SELECT ${SELECT_COLS},
        (SELECT count(*) FROM monitor_results m WHERE m.endpoint_id=e.id AND m.ts >= now()-interval '24 hours')::int AS "checks24h",
        (SELECT count(*) FILTER (WHERE m.success) FROM monitor_results m WHERE m.endpoint_id=e.id AND m.ts >= now()-interval '24 hours')::int AS "up24h",
        (SELECT round(avg(m.response_time_ms))::int FROM monitor_results m WHERE m.endpoint_id=e.id AND m.ts >= now()-interval '24 hours') AS "avgMs",
        (SELECT array_agg(x.success ORDER BY x.ts) FROM (
            SELECT success, ts FROM monitor_results m WHERE m.endpoint_id=e.id ORDER BY ts DESC LIMIT 30
        ) x) AS "recent"
       FROM monitor_endpoints e
       ORDER BY group_name NULLS FIRST, name`,
    );
    return r.rows;
  }

  async get(id: string): Promise<MonitorEndpoint> {
    const r = await this.pool.query(`SELECT ${SELECT_COLS} FROM monitor_endpoints e WHERE id=$1`, [id]);
    return r.rows[0];
  }

  async create(input: any, userId: string | null) {
    const r = await this.pool.query(
      `INSERT INTO monitor_endpoints
         (name, group_name, type, target, method, request_headers, request_body,
          dns_query_type, interval_seconds, timeout_ms, conditions, follow_redirects,
          insecure_skip_verify, failure_threshold, success_threshold, alert_channels, enabled, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16::uuid[],$17,$18)
       RETURNING id`,
      [
        input.name, input.group ?? input.groupName ?? null, normType(input.type), input.target,
        input.method ?? 'GET', JSON.stringify(input.requestHeaders ?? {}), input.requestBody ?? null,
        input.dnsQueryType ?? 'A', clampInt(input.intervalSeconds, 10, 86400, 60),
        clampInt(input.timeoutMs, 500, 120000, 10000), JSON.stringify(input.conditions ?? []),
        input.followRedirects !== false, !!input.insecureSkipVerify,
        clampInt(input.failureThreshold, 1, 100, 1), clampInt(input.successThreshold, 1, 100, 1),
        Array.isArray(input.alertChannels) ? input.alertChannels : [], input.enabled !== false, userId,
      ],
    );
    return this.get(r.rows[0].id);
  }

  async update(id: string, patch: any) {
    const cols: Record<string, string> = {
      name: 'name', group: 'group_name', groupName: 'group_name', target: 'target', method: 'method',
      requestBody: 'request_body', dnsQueryType: 'dns_query_type', intervalSeconds: 'interval_seconds',
      timeoutMs: 'timeout_ms', followRedirects: 'follow_redirects', insecureSkipVerify: 'insecure_skip_verify',
      failureThreshold: 'failure_threshold', successThreshold: 'success_threshold', enabled: 'enabled',
    };
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, col] of Object.entries(cols)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); params.push(patch[k]); }
    }
    if (patch.type !== undefined) { sets.push(`type=$${i++}`); params.push(normType(patch.type)); }
    if (patch.conditions !== undefined) { sets.push(`conditions=$${i++}::jsonb`); params.push(JSON.stringify(patch.conditions)); }
    if (patch.requestHeaders !== undefined) { sets.push(`request_headers=$${i++}::jsonb`); params.push(JSON.stringify(patch.requestHeaders)); }
    if (patch.alertChannels !== undefined) { sets.push(`alert_channels=$${i++}::uuid[]`); params.push(Array.isArray(patch.alertChannels) ? patch.alertChannels : []); }
    if (!sets.length) return this.get(id);
    sets.push(`updated_at=now()`);
    params.push(id);
    await this.pool.query(`UPDATE monitor_endpoints SET ${sets.join(', ')} WHERE id=$${i}`, params);
    return this.get(id);
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM monitor_results WHERE endpoint_id=$1`, [id]);
    await this.pool.query(`DELETE FROM monitor_endpoints WHERE id=$1`, [id]);
    return { ok: true };
  }

  async results(id: string, limit = 100) {
    const r = await this.pool.query(
      `SELECT ts, success, status_code AS "statusCode", response_time_ms AS "responseTimeMs",
              ip, condition_results AS "conditionResults", error
       FROM monitor_results WHERE endpoint_id=$1 ORDER BY ts DESC LIMIT $2`,
      [id, Math.min(1000, Math.max(1, limit))],
    );
    return r.rows;
  }

  /** Canais de notificação disponíveis (para o form de alertas do monitor). */
  async listChannels() {
    const r = await this.pool.query(
      `SELECT id, name, kind, enabled FROM notification_channels ORDER BY name ASC`,
    );
    return r.rows;
  }

  async events(id: string, limit = 50) {
    const r = await this.pool.query(
      `SELECT id, type, message, ts FROM monitor_events WHERE endpoint_id=$1 ORDER BY ts DESC LIMIT $2`,
      [id, Math.min(500, Math.max(1, limit))],
    );
    return r.rows;
  }

  /** Roda a checagem sob demanda (botão "testar agora"). */
  async runNow(id: string) {
    const ep = await this.get(id);
    if (!ep) return { ok: false, message: 'endpoint não encontrado' };
    return this.runCheck(ep);
  }

  /** Série temporal (bucketada) de latência e uptime para o gráfico. */
  async series(id: string, window: string) {
    const { interval, bucket } = windowSpec(window);
    const r = await this.pool.query(
      `SELECT time_bucket($2::interval, ts) AS bucket,
              round(avg(response_time_ms))::int AS "avgMs",
              count(*) FILTER (WHERE success)::int AS up,
              count(*)::int AS total
       FROM monitor_results
       WHERE endpoint_id=$1 AND ts >= now() - $3::interval
       GROUP BY bucket ORDER BY bucket`,
      [id, bucket, interval],
    );
    return r.rows;
  }

  /** Uptime + latência agregados numa janela (para badges e cards). */
  async badgeInfo(id: string, window: string) {
    const ep = await this.get(id);
    if (!ep) return null;
    const { interval } = windowSpec(window);
    const r = await this.pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE success)::int AS up,
              round(avg(response_time_ms))::int AS "avgMs"
       FROM monitor_results WHERE endpoint_id=$1 AND ts >= now() - $2::interval`,
      [id, interval],
    );
    const row = r.rows[0] ?? { total: 0, up: 0, avgMs: null };
    const uptime = row.total ? Math.round((row.up / row.total) * 100) : null;
    return { name: ep.name, status: ep.lastStatus as string, uptime, avgMs: row.avgMs as number | null };
  }

  // ============================================================ Scheduler
  @Cron('*/10 * * * * *') // a cada 10s: dispara quem já venceu o intervalo
  async tick() {
    let due: MonitorEndpoint[];
    try {
      const r = await this.pool.query(
        `SELECT ${SELECT_COLS} FROM monitor_endpoints e
         WHERE enabled = true
           AND (last_checked_at IS NULL
                OR last_checked_at <= now() - (interval_seconds || ' seconds')::interval)`,
      );
      due = r.rows;
    } catch (e) {
      this.logger.error(`tick: ${errMsg(e)}`);
      return;
    }
    for (const ep of due) {
      if (this.inFlight.has(ep.id)) continue;
      this.inFlight.add(ep.id);
      this.runCheck(ep)
        .catch((e) => this.logger.error(`check ${ep.name}: ${errMsg(e)}`))
        .finally(() => this.inFlight.delete(ep.id));
    }
  }

  private async runCheck(ep: MonitorEndpoint) {
    const outcome = await probe({
      type: ep.type,
      target: ep.target,
      method: ep.method,
      requestHeaders: ep.requestHeaders,
      requestBody: ep.requestBody,
      dnsQueryType: ep.dnsQueryType,
      timeoutMs: ep.timeoutMs,
      followRedirects: ep.followRedirects,
      insecureSkipVerify: ep.insecureSkipVerify,
    });
    const condResults: ConditionResult[] = evaluateConditions(ep.conditions, outcome.ctx);
    const conditionsOk = condResults.every((c) => c.ok);
    const success = outcome.networkOk && conditionsOk;
    const reason =
      outcome.error ??
      (conditionsOk ? undefined : `condições falharam: ${condResults.filter((c) => !c.ok).map((c) => c.condition).join('; ')}`);

    await this.pool.query(
      `INSERT INTO monitor_results
         (endpoint_id, success, status_code, response_time_ms, ip, condition_results, error)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [ep.id, success, outcome.statusCode ?? null, outcome.responseTimeMs ?? null,
       outcome.ip ?? null, JSON.stringify(condResults), success ? null : reason ?? null],
    );

    await this.applyState(ep, success, reason);
    return { success, responseTimeMs: outcome.responseTimeMs, statusCode: outcome.statusCode, conditions: condResults, error: reason };
  }

  private async applyState(ep: MonitorEndpoint, success: boolean, reason?: string) {
    const failures = success ? 0 : ep.consecutiveFailures + 1;
    const successes = success ? ep.consecutiveSuccesses + 1 : 0;
    let newStatus: 'pending' | 'up' | 'down' = ep.lastStatus;
    let transition: 'up' | 'down' | null = null;

    if (success && ep.lastStatus !== 'up' && successes >= ep.successThreshold) {
      newStatus = 'up';
      // 1ª subida (pending -> up) não gera alerta de "recuperou".
      transition = ep.lastStatus === 'pending' ? null : 'up';
    } else if (!success && ep.lastStatus !== 'down' && failures >= ep.failureThreshold) {
      newStatus = 'down';
      transition = 'down';
    }

    await this.pool.query(
      `UPDATE monitor_endpoints
       SET last_checked_at=now(), last_status=$2, consecutive_failures=$3,
           consecutive_successes=$4, updated_at=now()
       WHERE id=$1`,
      [ep.id, newStatus, failures, successes],
    );

    if (transition) await this.onTransition(ep, transition, reason);
  }

  private async onTransition(ep: MonitorEndpoint, type: 'up' | 'down', reason?: string) {
    const message =
      type === 'down'
        ? `${ep.name} está DOWN${reason ? ` — ${reason}` : ''}`
        : `${ep.name} se recuperou (UP)`;
    await this.pool.query(
      `INSERT INTO monitor_events(endpoint_id, type, message) VALUES ($1,$2,$3)`,
      [ep.id, type, message.slice(0, 2000)],
    );
    if (ep.alertChannels?.length) {
      await this.notif
        .sendToChannelIds(ep.alertChannels, {
          title: `[Monitor] ${ep.name}`,
          message,
          severity: type === 'down' ? 'critical' : 'info',
          meta: { endpointId: ep.id, type: ep.type, target: ep.target },
        })
        .catch((e) => this.logger.error(`notify ${ep.name}: ${errMsg(e)}`));
    }
  }

  // ============================================================ Import YAML (Gatus)
  async importYaml(text: string, userId: string | null) {
    let doc: any;
    try {
      doc = yaml.load(text);
    } catch (e) {
      return { imported: 0, skipped: 0, errors: [`YAML inválido: ${errMsg(e)}`] };
    }
    const list: any[] = Array.isArray(doc?.endpoints) ? doc.endpoints : Array.isArray(doc) ? doc : [];
    if (!list.length) return { imported: 0, skipped: 0, errors: ['nenhum endpoint encontrado (esperado `endpoints:`)'] };

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const raw of list) {
      try {
        const mapped = mapGatusEndpoint(raw);
        if (!mapped) { skipped++; continue; }
        await this.create(mapped, userId);
        imported++;
      } catch (e) {
        skipped++;
        errors.push(`${raw?.name ?? '?'}: ${errMsg(e)}`);
      }
    }
    return { imported, skipped, errors };
  }
}

// ============================================================ helpers
function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function windowSpec(window: string): { interval: string; bucket: string } {
  switch (String(window || '24h')) {
    case '1h': return { interval: '1 hour', bucket: '1 minute' };
    case '7d': return { interval: '7 days', bucket: '1 hour' };
    case '30d': return { interval: '30 days', bucket: '6 hours' };
    case '24h':
    default: return { interval: '24 hours', bucket: '10 minutes' };
  }
}

function normType(t: unknown): ProbeType {
  const s = String(t ?? 'http').toLowerCase();
  return (['http', 'tcp', 'udp', 'icmp', 'dns', 'tls'] as string[]).includes(s) ? (s as ProbeType) : 'http';
}

function parseDurationSeconds(s: unknown, def: number): number {
  if (typeof s === 'number') return s;
  const str = String(s ?? '').trim();
  const m = /^(\d+)(ms|s|m|h)?$/.exec(str);
  if (!m) return def;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'ms': return Math.max(1, Math.round(n / 1000));
    case 'm': return n * 60;
    case 'h': return n * 3600;
    default: return n; // s
  }
}

/** Converte um endpoint do formato Gatus para o nosso input de create(). */
function mapGatusEndpoint(g: any): any | null {
  if (!g || (!g.url && !g.name)) return null;
  const url: string = String(g.url ?? '').trim();
  const lower = url.toLowerCase();
  let type: ProbeType = 'http';
  let target = url;

  if (lower.startsWith('tcp://')) { type = 'tcp'; target = url.slice(6); }
  else if (lower.startsWith('udp://')) { type = 'udp'; target = url.slice(6); }
  else if (lower.startsWith('icmp://')) { type = 'icmp'; target = url.slice(7); }
  else if (lower.startsWith('tls://')) { type = 'tls'; target = url.slice(6); }
  else if (lower.startsWith('starttls://')) { type = 'tls'; target = url.slice(11); } // simplificado
  else if (g.dns || lower.startsWith('dns://')) {
    type = 'dns';
    target = g.dns?.['query-name'] ?? g.dns?.queryName ?? url.replace(/^dns:\/\//, '');
  }

  const client = g.client ?? {};
  const intervalSeconds = parseDurationSeconds(g.interval, 60);
  const timeoutMs = parseDurationSeconds(client.timeout, 10) * 1000;

  return {
    name: String(g.name ?? target),
    group: g.group ?? null,
    type,
    target,
    method: g.method ?? 'GET',
    requestHeaders: g.headers ?? {},
    requestBody: g.body ?? g.graphql ?? null,
    dnsQueryType: g.dns?.['query-type'] ?? g.dns?.queryType ?? 'A',
    intervalSeconds,
    timeoutMs,
    conditions: Array.isArray(g.conditions) ? g.conditions.map((c: unknown) => String(c)) : [],
    insecureSkipVerify: !!client.insecure,
    followRedirects: client['ignore-redirect'] ? false : true,
    // alertas do Gatus não mapeiam para nossos canais — usuário atribui na UI.
    alertChannels: [],
    enabled: true,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
