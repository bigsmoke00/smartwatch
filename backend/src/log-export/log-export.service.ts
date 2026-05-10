import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { gzipSync } from 'zlib';
import { Response } from 'express';
import * as archiver from 'archiver';
import { PG_POOL } from '../db/db.module';
import { LogsRepository, LogQuery } from '../logs/logs.repository';
import { ControlGateway } from '../docker-manager/control.gateway';
import { SecretsService } from '../secrets/secrets.service';

export type ExportFormat = 'log' | 'csv' | 'json' | 'gz';

@Injectable()
export class LogExportService {
  private readonly logger = new Logger('LogExportService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logs: LogsRepository,
    private readonly ctrl: ControlGateway,
    private readonly secrets: SecretsService,
  ) {}

  /** Stream de logs num formato pra resposta HTTP. */
  async streamExport(res: Response, filter: LogQuery, format: ExportFormat) {
    // Limita pra 50k linhas por export (paginar internamente se quiser mais)
    const r = await this.logs.query({ ...filter, pageSize: 50_000, page: 1 });
    const hits = r.hits ?? [];

    const fileBase = `logs-${Date.now()}`;
    let body: Buffer;
    let mime = 'text/plain';
    let filename = `${fileBase}.log`;

    if (format === 'csv') {
      const safe = (s: any) => '"' + String(s ?? '').replace(/"/g, '""').replace(/\n/g, ' ') + '"';
      const header = 'ts,server,container,level,message\n';
      const lines = hits.map((h: any) => [h.ts, h.serverName, h.containerName, h.level, h.message].map(safe).join(','));
      body = Buffer.from(header + lines.join('\n'), 'utf-8');
      mime = 'text/csv';
      filename = `${fileBase}.csv`;
    } else if (format === 'json') {
      body = Buffer.from(JSON.stringify(hits, null, 2), 'utf-8');
      mime = 'application/json';
      filename = `${fileBase}.json`;
    } else if (format === 'gz') {
      const txt = hits.map((h: any) => `${h.ts} [${h.level ?? '?'}] ${h.serverName ?? ''}${h.containerName ? ' ['+h.containerName+']' : ''}: ${h.message}`).join('\n');
      body = gzipSync(Buffer.from(txt, 'utf-8'));
      mime = 'application/gzip';
      filename = `${fileBase}.log.gz`;
    } else {
      body = Buffer.from(
        hits.map((h: any) =>
          `${h.ts} [${h.level ?? '?'}] ${h.serverName ?? ''}${h.containerName ? ' [' + h.containerName + ']' : ''}: ${h.message}`,
        ).join('\n'),
        'utf-8',
      );
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
    return { bytes: body.length };
  }

  /** Bundle ZIP: 1 arquivo por container ativo do servidor (período opcional). */
  async streamBundle(res: Response, serverId: string, from?: string, to?: string) {
    const archive = archiver('zip', { zlib: { level: 9 } });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="logs-${serverId.slice(0, 8)}-${Date.now()}.zip"`);
    archive.pipe(res);

    // Lista containers conhecidos
    const cs = await this.pool.query(
      `SELECT DISTINCT container_name FROM logs WHERE server_id=$1 AND container_name IS NOT NULL`,
      [serverId],
    );

    // arquivo "all.log" com tudo
    {
      const r = await this.logs.query({ serverId, from, to, pageSize: 50_000 });
      const txt = (r.hits ?? []).map((h: any) =>
        `${h.ts} [${h.level ?? '?'}] [${h.containerName ?? '-'}] ${h.message}`,
      ).join('\n');
      archive.append(txt, { name: 'all.log' });
    }

    for (const row of cs.rows) {
      const cname: string = row.container_name;
      const r = await this.logs.query({ serverId, containerName: cname, from, to, pageSize: 50_000 });
      const txt = (r.hits ?? []).map((h: any) =>
        `${h.ts} [${h.level ?? '?'}] ${h.message}`,
      ).join('\n');
      archive.append(txt, { name: `containers/${cname}.log` });
    }

    // host journalctl (best-effort)
    try {
      const j = await this.ctrl.invoke<any>(serverId, 'host.journalctl', { since: from, until: to });
      if (j?.content) archive.append(j.content, { name: `host/${j.kind}.log` });
    } catch (e) {
      archive.append(`(falha ao coletar journalctl: ${(e as Error).message})`, { name: 'host/ERROR.txt' });
    }

    await archive.finalize();
  }

  // -------- Schedules --------
  async listSchedules() {
    const r = await this.pool.query(
      `SELECT id, name, filter, format, schedule_cron AS "scheduleCron", destination,
              enabled, last_run_at AS "lastRunAt", last_status AS "lastStatus",
              created_at AS "createdAt"
       FROM log_export_schedules ORDER BY created_at DESC`,
    );
    return r.rows;
  }

  async createSchedule(input: {
    name: string; filter: any; format: ExportFormat; scheduleCron: string;
    destination: any; createdBy: string;
  }) {
    const r = await this.pool.query(
      `INSERT INTO log_export_schedules(name, filter, format, schedule_cron, destination, created_by)
       VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6) RETURNING id`,
      [input.name, JSON.stringify(input.filter), input.format, input.scheduleCron, JSON.stringify(input.destination), input.createdBy],
    );
    return r.rows[0];
  }

  async deleteSchedule(id: string) {
    await this.pool.query(`DELETE FROM log_export_schedules WHERE id=$1`, [id]);
    return { ok: true };
  }

  /** A cada minuto, escaneia schedules vencidos. Usamos CRON simples. */
  @Cron(CronExpression.EVERY_MINUTE)
  async scanSchedules() {
    // Implementação simplificada: corre cada schedule conforme `schedule_cron`.
    // Para precisão de cron real, recomenda-se cron-parser ou node-cron por schedule.
    const r = await this.pool.query(
      `SELECT * FROM log_export_schedules WHERE enabled=true`,
    );
    for (const s of r.rows) {
      try {
        if (!shouldRun(s)) continue;
        await this.runSchedule(s);
      } catch (e: any) {
        this.logger.error(`schedule ${s.id}: ${e.message}`);
      }
    }
  }

  private async runSchedule(s: any) {
    const t0 = Date.now();
    try {
      const r = await this.logs.query({ ...(s.filter ?? {}), pageSize: 50_000 });
      const txt = (r.hits ?? []).map((h: any) =>
        `${h.ts} [${h.level ?? '?'}] ${h.serverName ?? ''}${h.containerName ? ' [' + h.containerName + ']' : ''}: ${h.message}`,
      ).join('\n');

      let body: Buffer;
      let mime = 'text/plain';
      let ext = 'log';
      if (s.format === 'gz') { body = gzipSync(Buffer.from(txt)); mime = 'application/gzip'; ext = 'log.gz'; }
      else if (s.format === 'csv') {
        const safe = (v: any) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const csv = 'ts,server,container,level,message\n' +
          (r.hits ?? []).map((h: any) => [h.ts, h.serverName, h.containerName, h.level, h.message].map(safe).join(',')).join('\n');
        body = Buffer.from(csv); mime = 'text/csv'; ext = 'csv';
      } else if (s.format === 'json') {
        body = Buffer.from(JSON.stringify(r.hits ?? [], null, 2)); mime = 'application/json'; ext = 'json';
      } else {
        body = Buffer.from(txt);
      }

      const filename = `logwatch-${s.name.replace(/\W+/g, '_')}-${Date.now()}.${ext}`;
      const dest = s.destination ?? {};
      let destStr = '';

      if (dest.type === 'email') {
        await this.sendEmail({ to: dest.email, subject: filename, body, mime, filename });
        destStr = `email:${dest.email}`;
      } else if (dest.type === 's3') {
        await this.uploadS3({ bucket: dest.bucket, key: `${dest.keyPrefix ?? ''}${filename}`, body, mime });
        destStr = `s3://${dest.bucket}/${dest.keyPrefix ?? ''}${filename}`;
      } else {
        // local: salva em /tmp para inspeção (fallback dev)
        destStr = `local:/tmp/${filename}`;
        await import('node:fs/promises').then((fs) => fs.writeFile(`/tmp/${filename}`, body));
      }

      await this.pool.query(
        `UPDATE log_export_schedules SET last_run_at=now(), last_status='ok' WHERE id=$1`,
        [s.id],
      );
      await this.pool.query(
        `INSERT INTO log_export_runs(schedule_id, status, bytes, destination)
         VALUES ($1,'ok',$2,$3)`,
        [s.id, body.length, destStr],
      );
      this.logger.log(`schedule ${s.name} OK → ${destStr} (${body.length} bytes, ${Date.now() - t0}ms)`);
    } catch (e: any) {
      await this.pool.query(
        `UPDATE log_export_schedules SET last_run_at=now(), last_status='error' WHERE id=$1`,
        [s.id],
      );
      await this.pool.query(
        `INSERT INTO log_export_runs(schedule_id, status, error) VALUES ($1,'error',$2)`,
        [s.id, e.message],
      );
      this.logger.error(`schedule ${s.name}: ${e.message}`);
    }
  }

  /** Envia email via nodemailer. SMTP_* via env. */
  private async sendEmail(opts: { to: string; subject: string; body: Buffer; mime: string; filename: string }) {
    const nodemailer: any = await import('nodemailer').catch(() => null);
    if (!nodemailer) throw new Error('nodemailer não instalado');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'mailhog',
      port: parseInt(process.env.SMTP_PORT ?? '1025', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER, pass: process.env.SMTP_PASS,
      } : undefined,
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM ?? 'logwatch@local',
      to: opts.to,
      subject: opts.subject,
      text: 'Logs anexados.',
      attachments: [{ filename: opts.filename, content: opts.body, contentType: opts.mime }],
    });
  }

  /** Upload S3 (credenciais do vault: secret 'aws_logexport' = {accessKeyId, secretAccessKey, region?}). */
  private async uploadS3(opts: { bucket: string; key: string; body: Buffer; mime: string }) {
    const s3mod: any = await import('@aws-sdk/client-s3').catch(() => null);
    if (!s3mod) throw new Error('@aws-sdk/client-s3 não instalado');
    const credRaw = await this.secrets.get('aws_logexport').catch(() => null);
    if (!credRaw) throw new Error('secret aws_logexport não encontrado no vault');
    const cred = JSON.parse(credRaw);
    const client = new s3mod.S3Client({
      region: cred.region ?? 'us-east-1',
      credentials: { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey },
    });
    await client.send(new s3mod.PutObjectCommand({
      Bucket: opts.bucket, Key: opts.key, Body: opts.body, ContentType: opts.mime,
    }));
  }
}

/**
 * Avalia se um schedule deve disparar AGORA, usando cron-parser real.
 * Lógica: pega o último run (ou created_at se nunca rodou) e calcula o
 * próximo `next()` a partir dessa âncora; dispara se `next() <= now`.
 */
function shouldRun(s: any): boolean {
  try {
    // dynamic require pra não quebrar testes/import circular
    const cronParser = require('cron-parser');
    const anchor = s.last_run_at ? new Date(s.last_run_at) : new Date(s.created_at);
    const it = cronParser.parseExpression(s.schedule_cron, {
      currentDate: anchor,
      tz: process.env.TZ || 'UTC',
    });
    const next = it.next().toDate();
    return next.getTime() <= Date.now();
  } catch {
    // Cron malformado: roda 1x por dia como fallback seguro
    if (!s.last_run_at) return true;
    return Date.now() - new Date(s.last_run_at).getTime() > 24 * 60 * 60_000;
  }
}
