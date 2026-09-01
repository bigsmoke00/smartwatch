import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { X509Certificate } from 'crypto';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';
import { NotificationsService } from '../notifications/notifications.service';

interface CertTarget {
  id: string;
  name: string;
  serverId: string;
  directory: string;
  recursive: boolean;
  enabled: boolean;
  alertDays: number;
  alertChannels: string[];
}

interface ParsedCert {
  commonName?: string;
  subject?: string;
  issuer?: string;
  san?: string;
  notBefore?: string;
  notAfter?: string;
  fingerprint?: string;
  error?: string;
}

const CERT_EXT = /\.(pem|crt|cer|cert)$/i;
const SKIP = /privkey|\.key$/i;

@Injectable()
export class CertService {
  private readonly logger = new Logger('CertService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
    private readonly notif: NotificationsService,
  ) {}

  /** Canais de notificação (para o form de alerta da tela de Certificados). */
  async listChannels() {
    const r = await this.pool.query(
      `SELECT id, name, kind, enabled FROM notification_channels ORDER BY name ASC`,
    );
    return r.rows;
  }

  // ============================================================ Alvos
  async listTargets() {
    const r = await this.pool.query(
      `SELECT t.id, t.name, t.server_id AS "serverId", s.name AS "serverName",
              t.directory, t.recursive, t.enabled,
              t.alert_days AS "alertDays", t.alert_channels AS "alertChannels",
              t.last_scan_at AS "lastScanAt", t.last_scan_error AS "lastScanError",
              (SELECT count(*)::int FROM cert_files f WHERE f.target_id=t.id) AS "certCount"
       FROM cert_targets t JOIN servers s ON s.id = t.server_id
       ORDER BY t.name`,
    );
    return r.rows;
  }

  async createTarget(input: any, userId: string | null) {
    const r = await this.pool.query(
      `INSERT INTO cert_targets(name, server_id, directory, recursive, enabled, alert_days, alert_channels, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::uuid[],$8) RETURNING id`,
      [
        input.name, input.serverId, input.directory, input.recursive !== false, input.enabled !== false,
        clampDays(input.alertDays), Array.isArray(input.alertChannels) ? input.alertChannels : [], userId,
      ],
    );
    const id = r.rows[0].id;
    this.scanTarget(id).catch((e) => this.logger.error(`scan inicial ${id}: ${errMsg(e)}`));
    return { id };
  }

  async updateTarget(id: string, patch: any) {
    const map: Record<string, string> = {
      name: 'name', serverId: 'server_id', directory: 'directory', recursive: 'recursive', enabled: 'enabled',
    };
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); params.push(patch[k]); }
    }
    if (patch.alertDays !== undefined) { sets.push(`alert_days=$${i++}`); params.push(clampDays(patch.alertDays)); }
    if (patch.alertChannels !== undefined) { sets.push(`alert_channels=$${i++}::uuid[]`); params.push(Array.isArray(patch.alertChannels) ? patch.alertChannels : []); }
    if (!sets.length) return { ok: true };
    sets.push('updated_at=now()');
    params.push(id);
    await this.pool.query(`UPDATE cert_targets SET ${sets.join(', ')} WHERE id=$${i}`, params);
    return { ok: true };
  }

  async removeTarget(id: string) {
    await this.pool.query(`DELETE FROM cert_targets WHERE id=$1`, [id]);
    return { ok: true };
  }

  /** Todos os certificados encontrados, ordenados pelo vencimento mais próximo. */
  async listCerts() {
    const r = await this.pool.query(
      `SELECT f.id, f.target_id AS "targetId", t.name AS "targetName",
              t.server_id AS "serverId", s.name AS "serverName",
              f.path, f.common_name AS "commonName", f.subject, f.issuer, f.san,
              f.not_before AS "notBefore", f.not_after AS "notAfter",
              f.fingerprint, f.error, f.scanned_at AS "scannedAt"
       FROM cert_files f
       JOIN cert_targets t ON t.id = f.target_id
       JOIN servers s ON s.id = t.server_id
       ORDER BY f.not_after ASC NULLS LAST`,
    );
    return r.rows;
  }

  // ============================================================ Varredura
  async rescan(id: string) {
    const ok = await this.scanTarget(id);
    return { ok };
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async rescanAll() {
    let rows: { id: string }[];
    try {
      const r = await this.pool.query(`SELECT id FROM cert_targets WHERE enabled=true`);
      rows = r.rows;
    } catch (e) {
      this.logger.error(`rescanAll list: ${errMsg(e)}`);
      return;
    }
    for (const t of rows) {
      await this.scanTarget(t.id).catch((e) => this.logger.error(`rescan ${t.id}: ${errMsg(e)}`));
    }
  }

  private async getTarget(id: string): Promise<CertTarget> {
    const r = await this.pool.query(
      `SELECT id, name, server_id AS "serverId", directory, recursive, enabled,
              alert_days AS "alertDays", alert_channels AS "alertChannels"
       FROM cert_targets WHERE id=$1`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException('alvo não encontrado');
    return r.rows[0];
  }

  private async scanTarget(id: string): Promise<boolean> {
    const t = await this.getTarget(id);
    const seen = new Set<string>();
    let error: string | null = null;
    try {
      const roots = [t.directory];
      if (t.recursive) {
        const top = await this.ctrl.invoke<any>(t.serverId, 'fs.listDir', { path: t.directory });
        for (const it of top?.items ?? []) if (it.type === 'dir') roots.push(it.path);
      }
      for (const dir of roots) {
        const ls = await this.ctrl.invoke<any>(t.serverId, 'fs.listDir', { path: dir }).catch(() => null);
        if (!ls) continue;
        for (const it of ls.items ?? []) {
          if (it.type !== 'file' || !CERT_EXT.test(it.name) || SKIP.test(it.name)) continue;
          let parsed: ParsedCert;
          try {
            const rf = await this.ctrl.invoke<any>(t.serverId, 'fs.readFile', { path: it.path }, { timeoutMs: 15000 });
            parsed = rf?.content ? parseCert(String(rf.content)) : { error: 'sem conteúdo' };
          } catch (e) {
            parsed = { error: errMsg(e) };
          }
          seen.add(it.path);
          await this.upsertCert(t.id, it.path, parsed);
        }
      }
      // remove os que sumiram do disco
      if (seen.size) {
        await this.pool.query(
          `DELETE FROM cert_files WHERE target_id=$1 AND NOT (path = ANY($2::text[]))`,
          [t.id, Array.from(seen)],
        );
      } else {
        await this.pool.query(`DELETE FROM cert_files WHERE target_id=$1`, [t.id]);
      }
    } catch (e) {
      error = errMsg(e);
    }
    await this.pool.query(
      `UPDATE cert_targets SET last_scan_at=now(), last_scan_error=$2, updated_at=now() WHERE id=$1`,
      [t.id, error],
    );
    await this.evaluateAlerts(t).catch((e) => this.logger.error(`alerta ${t.name}: ${errMsg(e)}`));
    return !error;
  }

  /**
   * Dispara alerta nos canais do alvo para certificados vencendo (<= alertDays)
   * ou já expirados. Dedup por not_after: só alerta 1x por valor de validade
   * (quando o cert é renovado, volta a alertar na próxima aproximação).
   */
  private async evaluateAlerts(t: CertTarget) {
    if (!t.alertChannels?.length || !t.alertDays) return;
    const r = await this.pool.query(
      `SELECT id, common_name AS "commonName", path, not_after AS "notAfter",
              (not_after < now()) AS expired
       FROM cert_files
       WHERE target_id=$1 AND not_after IS NOT NULL
         AND not_after <= now() + ($2 || ' days')::interval
         AND (alerted_not_after IS NULL OR alerted_not_after <> not_after)
       ORDER BY not_after ASC`,
      [t.id, t.alertDays],
    );
    if (!r.rowCount) return;

    const anyExpired = r.rows.some((x: any) => x.expired);
    const lines = r.rows.map((x: any) => {
      const days = Math.floor((new Date(x.notAfter).getTime() - Date.now()) / 86_400_000);
      const label = x.commonName || x.path.split('/').pop();
      return x.expired ? `${label} — EXPIRADO` : `${label} — vence em ${days}d`;
    });
    const message =
      `${r.rowCount} certificado(s) em "${t.name}" vencendo (≤ ${t.alertDays} dias):\n` +
      lines.slice(0, 30).join('\n');

    await this.notif.sendToChannelIds(t.alertChannels, {
      title: `[Certificados] ${t.name}`,
      message,
      severity: anyExpired ? 'critical' : 'warning',
      meta: { targetId: t.id, count: r.rowCount },
    });

    await this.pool.query(
      `UPDATE cert_files SET alerted_not_after = not_after WHERE id = ANY($1::uuid[])`,
      [r.rows.map((x: any) => x.id)],
    );
  }

  private async upsertCert(targetId: string, path: string, c: ParsedCert) {
    await this.pool.query(
      `INSERT INTO cert_files(target_id, path, common_name, subject, issuer, san, not_before, not_after, fingerprint, error, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
       ON CONFLICT (target_id, path) DO UPDATE SET
         common_name=$3, subject=$4, issuer=$5, san=$6, not_before=$7, not_after=$8,
         fingerprint=$9, error=$10, scanned_at=now()`,
      [
        targetId, path, c.commonName ?? null, c.subject ?? null, c.issuer ?? null, c.san ?? null,
        c.notBefore ?? null, c.notAfter ?? null, c.fingerprint ?? null, c.error ?? null,
      ],
    );
  }
}

// ============================================================ helpers
function parseCert(content: string): ParsedCert {
  const m = content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/);
  if (!m) return { error: 'sem bloco PEM de certificado (talvez DER/binário ou uma chave)' };
  try {
    const x = new X509Certificate(m[0]);
    const notBefore = new Date(x.validFrom);
    const notAfter = new Date(x.validTo);
    return {
      commonName: cn(x.subject),
      subject: x.subject?.replace(/\n/g, ', '),
      issuer: cn(x.issuer) || x.issuer?.replace(/\n/g, ', '),
      san: x.subjectAltName ?? undefined,
      notBefore: isNaN(notBefore.getTime()) ? undefined : notBefore.toISOString(),
      notAfter: isNaN(notAfter.getTime()) ? undefined : notAfter.toISOString(),
      fingerprint: x.fingerprint256,
    };
  } catch (e) {
    return { error: `falha ao parsear X.509: ${errMsg(e)}` };
  }
}

function clampDays(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, Math.trunc(n)));
}

function cn(dn: string | undefined): string | undefined {
  const m = dn?.match(/CN=([^\n,]+)/);
  return m ? m[1].trim() : undefined;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
