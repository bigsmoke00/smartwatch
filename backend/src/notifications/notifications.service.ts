import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { request } from 'undici';
import { createHmac } from 'crypto';
import { PG_POOL } from '../db/db.module';
import { MailService } from '../mail/mail.service';

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (ch) => map[ch]);
}

export type ChannelKind =
  | 'slack'
  | 'discord'
  | 'webhook'
  | 'email'
  | 'pagerduty'
  | 'telegram';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  config: Record<string, any>;
  enabled: boolean;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('NotificationsService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly mail: MailService,
  ) {}

  async list() {
    const r = await this.pool.query(
      `SELECT id, name, kind, config, enabled, created_at AS "createdAt"
       FROM notification_channels ORDER BY created_at DESC`,
    );
    return r.rows.map((c) => ({
      ...c,
      config: redactSecrets(c.config, c.kind),
    }));
  }

  async create(c: {
    name: string;
    kind: ChannelKind;
    config: Record<string, any>;
  }) {
    const r = await this.pool.query(
      `INSERT INTO notification_channels(name, kind, config)
       VALUES ($1,$2,$3::jsonb) RETURNING id`,
      [c.name, c.kind, JSON.stringify(c.config)],
    );
    return { id: r.rows[0].id };
  }

  async update(id: string, patch: Partial<Channel>) {
    const r = await this.pool.query(
      `UPDATE notification_channels
         SET name = coalesce($2, name),
             config = coalesce($3, config),
             enabled = coalesce($4, enabled)
       WHERE id=$1 RETURNING id`,
      [id, patch.name ?? null, patch.config ? JSON.stringify(patch.config) : null, patch.enabled ?? null],
    );
    return r.rows[0];
  }

  async remove(id: string) {
    await this.pool.query(`DELETE FROM notification_channels WHERE id=$1`, [id]);
    return { ok: true };
  }

  async test(id: string) {
    const r = await this.pool.query(
      `SELECT id, name, kind, config, enabled FROM notification_channels WHERE id=$1`,
      [id],
    );
    if (!r.rowCount) return { ok: false, message: 'channel not found' };
    return this.send(r.rows[0], {
      title: 'LogWatch — teste de canal',
      message: 'Se você está vendo isso, o canal está funcionando.',
      severity: 'info',
    });
  }

  /** Envia para um conjunto de canais. */
  async sendToChannelIds(
    ids: string[],
    payload: { title: string; message: string; severity?: string; meta?: any },
  ) {
    if (!ids.length) return;
    const r = await this.pool.query(
      `SELECT id, name, kind, config, enabled FROM notification_channels WHERE id = ANY($1::uuid[]) AND enabled=true`,
      [ids],
    );
    await Promise.allSettled(r.rows.map((c) => this.send(c, payload)));
  }

  private async send(
    c: Channel,
    payload: { title: string; message: string; severity?: string; meta?: any },
  ) {
    try {
      switch (c.kind) {
        case 'slack':
          return await this.sendSlack(c.config.webhookUrl, payload);
        case 'discord':
          return await this.sendDiscord(c.config.webhookUrl, payload);
        case 'webhook':
          return await this.sendWebhook(c.config.url, c.config.hmacSecret, payload);
        case 'telegram':
          return await this.sendTelegram(c.config.botToken, c.config.chatId, payload);
        case 'pagerduty':
          return await this.sendPagerDuty(c.config.routingKey, payload);
        case 'email': {
          const to: string | undefined = c.config.to || c.config.email || c.config.address;
          if (!to) return { ok: false, message: 'canal de email sem destinatário (config.to)' };
          const sev = (payload.severity || 'info').toUpperCase();
          const html = `<h3>[${sev}] ${escapeHtml(payload.title)}</h3><p>${escapeHtml(payload.message)}</p>`;
          const ok = await this.mail.send(to, `[${sev}] ${payload.title}`, html);
          return { ok, message: ok ? undefined : 'falha no envio (ver logs do MailService)' };
        }
      }
    } catch (e: any) {
      this.logger.error(`channel ${c.name} failed: ${e.message}`);
      return { ok: false, message: e.message };
    }
  }

  private async sendSlack(url: string, p: any) {
    const color =
      p.severity === 'critical' ? '#ef4444' : p.severity === 'warning' ? '#f59e0b' : '#3b82f6';
    const body = JSON.stringify({
      attachments: [
        {
          color,
          title: `[${(p.severity || 'info').toUpperCase()}] ${p.title}`,
          text: p.message,
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    });
    await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { ok: true };
  }

  private async sendDiscord(url: string, p: any) {
    const body = JSON.stringify({
      content: `**[${(p.severity || 'info').toUpperCase()}] ${p.title}**\n${p.message}`,
    });
    await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { ok: true };
  }

  private async sendWebhook(url: string, hmacSecret: string | undefined, p: any) {
    const body = JSON.stringify({ ...p, source: 'logwatch', ts: Date.now() });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'LogWatch/1.0',
    };
    if (hmacSecret) {
      const sig = createHmac('sha256', hmacSecret).update(body).digest('hex');
      headers['x-logwatch-signature'] = `sha256=${sig}`;
    }
    await request(url, { method: 'POST', headers, body });
    return { ok: true };
  }

  private async sendTelegram(botToken: string, chatId: string, p: any) {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const text = `🔔 *[${(p.severity || 'info').toUpperCase()}] ${p.title}*\n${p.message}`;
    await request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    });
    return { ok: true };
  }

  private async sendPagerDuty(routingKey: string, p: any) {
    await request('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: 'trigger',
        payload: {
          summary: p.title,
          severity: p.severity ?? 'warning',
          source: 'logwatch',
          custom_details: { message: p.message, ...p.meta },
        },
      }),
    });
    return { ok: true };
  }
}

function redactSecrets(cfg: any, _kind: string) {
  if (!cfg) return cfg;
  const out: any = { ...cfg };
  for (const key of Object.keys(out)) {
    if (/(secret|token|key|url|webhook)/i.test(key) && typeof out[key] === 'string') {
      out[key] = out[key].slice(0, 8) + '…' + out[key].slice(-4);
    }
  }
  return out;
}
