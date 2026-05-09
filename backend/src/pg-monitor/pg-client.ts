import { Logger } from '@nestjs/common';
import { Client } from 'pg';

/**
 * Cliente leve para um cluster monitorado.
 *
 * Resolve `hosts` (CSV "host:port,host2:port2" — útil para Patroni) tentando
 * cada um até conectar com sucesso. Connect timeout curto, query timeout
 * configurável.
 */
export class MonitoredPgClient {
  private readonly logger = new Logger('MonitoredPgClient');
  private client: Client | null = null;

  constructor(
    private readonly cfg: {
      hosts: string;          // "host:port,host2:port2"
      database: string;
      user: string;
      password: string;
      ssl?: boolean;
      statementTimeoutMs?: number;
    },
  ) {}

  async connect() {
    if (this.client) return this.client;
    const candidates = this.cfg.hosts.split(',').map((s) => s.trim()).filter(Boolean);
    let lastErr: any;
    for (const c of candidates) {
      const [host, portRaw] = c.split(':');
      const port = portRaw ? parseInt(portRaw, 10) : 5432;
      const client = new Client({
        host, port,
        user: this.cfg.user, password: this.cfg.password, database: this.cfg.database,
        ssl: this.cfg.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: 5000,
        statement_timeout: this.cfg.statementTimeoutMs ?? 8000,
      });
      try {
        await client.connect();
        this.client = client;
        return client;
      } catch (e) {
        lastErr = e;
        await client.end().catch(() => {});
      }
    }
    throw lastErr || new Error('no host reachable');
  }

  async end() {
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    const c = await this.connect();
    const r = await c.query(sql, params);
    return r.rows as T[];
  }
}
