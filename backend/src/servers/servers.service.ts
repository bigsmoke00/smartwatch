import {
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PG_POOL } from '../db/db.module';

export interface ServerRow {
  id: string;
  name: string;
  description?: string | null;
  hostname?: string | null;
  ip?: string | null;
  cloud?: string | null;
  cloudRegion?: string | null;
  cloudAccount?: string | null;
  cloudInstanceId?: string | null;
  cloudAz?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  tags: string[];
  labels: Record<string, any>;
  retentionDays: number;
  /**
   * Override opcional do teto de linhas de log ARMAZENADAS/minuto (NULL =
   * usa o default global LOGWATCH_MAX_STORED_ROWS_PER_MINUTE). Pensado para
   * fontes de altíssimo volume, como o FreeSWITCH/Unity.
   */
  logRateLimitPerMinute?: number | null;
  lastSeenAt?: Date | null;
  createdAt: Date;
}

const COLS = `id, name, description, hostname, ip::text AS ip,
              cloud, cloud_region AS "cloudRegion", cloud_account AS "cloudAccount",
              cloud_instance_id AS "cloudInstanceId", cloud_az AS "cloudAz",
              os, arch, agent_version AS "agentVersion",
              tags, labels, retention_days AS "retentionDays",
              log_rate_limit_per_minute AS "logRateLimitPerMinute",
              last_seen_at AS "lastSeenAt", created_at AS "createdAt"`;

@Injectable()
export class ServersService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async list(filter?: { cloud?: string; tag?: string; includeDeleted?: boolean }) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (!filter?.includeDeleted) where.push(`deleted_at IS NULL`);
    if (filter?.cloud) {
      where.push(`cloud = $${i++}`);
      params.push(filter.cloud);
    }
    if (filter?.tag) {
      where.push(`tags ? $${i++}`);
      params.push(filter.tag);
    }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await this.pool.query(
      `SELECT ${COLS} FROM servers ${w} ORDER BY created_at DESC`,
      params,
    );
    return r.rows;
  }

  async get(id: string) {
    const r = await this.pool.query(`SELECT ${COLS} FROM servers WHERE id=$1`, [
      id,
    ]);
    if (!r.rowCount) throw new NotFoundException();
    const k = await this.pool.query(
      `SELECT id, prefix, scopes, ip_allowlist::text[] AS "ipAllowlist",
              active, last_used_at AS "lastUsedAt", created_at AS "createdAt"
       FROM api_keys WHERE server_id=$1 ORDER BY created_at DESC`,
      [id],
    );
    return { ...r.rows[0], apiKeys: k.rows };
  }

  async create(input: Partial<ServerRow>) {
    const r = await this.pool.query(
      `INSERT INTO servers(name, description, hostname, cloud, cloud_region,
                           cloud_account, cloud_instance_id, cloud_az, tags, labels,
                           retention_days, log_rate_limit_per_minute)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        input.name,
        input.description ?? null,
        input.hostname ?? null,
        input.cloud ?? null,
        input.cloudRegion ?? null,
        input.cloudAccount ?? null,
        input.cloudInstanceId ?? null,
        input.cloudAz ?? null,
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.labels ?? {}),
        input.retentionDays ?? 4,
        input.logRateLimitPerMinute ?? null,
      ],
    );
    return this.get(r.rows[0].id);
  }

  async update(id: string, patch: Partial<ServerRow>) {
    const fields: string[] = [];
    const params: any[] = [id];
    let i = 2;
    const map: Record<string, string> = {
      name: 'name',
      description: 'description',
      hostname: 'hostname',
      cloud: 'cloud',
      cloudRegion: 'cloud_region',
      cloudAccount: 'cloud_account',
      cloudInstanceId: 'cloud_instance_id',
      cloudAz: 'cloud_az',
      retentionDays: 'retention_days',
      logRateLimitPerMinute: 'log_rate_limit_per_minute',
    };
    for (const [k, col] of Object.entries(map)) {
      if ((patch as any)[k] !== undefined) {
        fields.push(`${col} = $${i++}`);
        params.push((patch as any)[k]);
      }
    }
    if (patch.tags !== undefined) {
      fields.push(`tags = $${i++}`);
      params.push(JSON.stringify(patch.tags));
    }
    if (patch.labels !== undefined) {
      fields.push(`labels = $${i++}`);
      params.push(JSON.stringify(patch.labels));
    }
    if (!fields.length) return this.get(id);
    fields.push(`updated_at = now()`);
    await this.pool.query(
      `UPDATE servers SET ${fields.join(', ')} WHERE id=$1`,
      params,
    );
    return this.get(id);
  }

  /**
   * Remove servidor com cleanup completo. soft=true preserva histórico.
   *
   * logs/host_metrics NÃO são limpos por DELETE aqui: são hypertables com
   * compressão (logs comprime após 6h, host_metrics após 7d) e o TimescaleDB
   * recusa DML direto em chunks comprimidos quando a tabela tem PK/UNIQUE com
   * colunas fora do `segmentby` (logs PK é (ts,id), segmentby é server_id,level).
   * Descomprimir todos os chunks antes do delete funciona mas é lento demais
   * em produção (gera 504 de gateway). Como não há FK de logs/host_metrics
   * para servers, as linhas órfãs não quebram nada — elas são purgadas pelas
   * políticas de retenção (14 dias / 180 dias) no curso normal.
   */
  async remove(id: string, soft = false) {
    if (soft) {
      await this.pool.query(
        `UPDATE servers SET deleted_at=now() WHERE id=$1 AND deleted_at IS NULL`,
        [id],
      );
      return { ok: true, soft: true };
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM script_executions WHERE server_id=$1`, [id]);
      await client.query(`DELETE FROM runbook_executions WHERE server_id=$1`, [id]);
      await client.query(
        `DELETE FROM terminal_session_events
         WHERE session_id IN (SELECT id FROM terminal_sessions WHERE server_id=$1)`,
        [id],
      );
      await client.query(
        `DELETE FROM topology_nodes WHERE ref_type='servers' AND ref_id=$1`,
        [id],
      );
      await client.query(`DELETE FROM servers WHERE id=$1`, [id]);
      await client.query('COMMIT');
      return { ok: true, soft: false };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async restore(id: string) {
    await this.pool.query(`UPDATE servers SET deleted_at=NULL WHERE id=$1`, [id]);
    return { ok: true };
  }

  async createApiKey(serverId: string, opts?: { ipAllowlist?: string[]; scopes?: string[] }) {
    const exists = await this.pool.query(`SELECT 1 FROM servers WHERE id=$1`, [
      serverId,
    ]);
    if (!exists.rowCount) throw new NotFoundException('Server not found');

    const prefix = 'sk_' + randomBytes(4).toString('hex');
    const secret = randomBytes(24).toString('base64url');
    const secretHash = await bcrypt.hash(secret, 10);

    await this.pool.query(
      `INSERT INTO api_keys(server_id, prefix, secret_hash, scopes, ip_allowlist)
       VALUES ($1,$2,$3,$4::jsonb,$5::inet[])`,
      [
        serverId,
        prefix,
        secretHash,
        JSON.stringify(opts?.scopes ?? ['ingest', 'metrics']),
        opts?.ipAllowlist ?? [],
      ],
    );
    return { prefix, key: `${prefix}.${secret}` };
  }

  async revokeApiKey(serverId: string, keyId: string) {
    await this.pool.query(
      `UPDATE api_keys SET active=false WHERE id=$1 AND server_id=$2`,
      [keyId, serverId],
    );
    return { ok: true };
  }

  async validateApiKey(raw: string, ip?: string): Promise<ServerRow & { keyId: string; scopes: string[] }> {
    const parts = raw?.split('.');
    if (!parts || parts.length !== 2) throw new UnauthorizedException('Invalid API key');
    const [prefix, secret] = parts;

    const r = await this.pool.query(
      `SELECT k.id AS "keyId", k.secret_hash AS "secretHash", k.active,
              k.scopes, k.ip_allowlist::text[] AS "ipAllowlist", s.*
       FROM api_keys k
       JOIN servers s ON s.id = k.server_id
       WHERE k.prefix = $1`,
      [prefix],
    );
    if (!r.rowCount) throw new UnauthorizedException('Invalid API key');
    const row = r.rows[0];
    if (!row.active) throw new UnauthorizedException('Key revoked');

    const ok = await bcrypt.compare(secret, row.secretHash);
    if (!ok) throw new UnauthorizedException('Invalid API key');

    if (row.ipAllowlist?.length && ip && !row.ipAllowlist.includes(ip)) {
      throw new UnauthorizedException(`IP ${ip} not in allowlist`);
    }

    void this.pool.query(
      `UPDATE api_keys SET last_used_at=now() WHERE id=$1`,
      [row.keyId],
    );
    void this.pool.query(
      `UPDATE servers SET last_seen_at=now() WHERE id=$1`,
      [row.id],
    );

    return {
      keyId: row.keyId,
      scopes: row.scopes ?? [],
      id: row.id,
      name: row.name,
      description: row.description,
      hostname: row.hostname,
      ip: row.ip,
      cloud: row.cloud,
      cloudRegion: row.cloud_region,
      cloudAccount: row.cloud_account,
      cloudInstanceId: row.cloud_instance_id,
      cloudAz: row.cloud_az,
      os: row.os,
      arch: row.arch,
      agentVersion: row.agent_version,
      tags: row.tags,
      labels: row.labels,
      retentionDays: row.retention_days,
      logRateLimitPerMinute: row.log_rate_limit_per_minute,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  /** Heartbeat do agent (atualiza metadados de host descobertos pelo agent). */
  async heartbeat(serverId: string, info: {
    hostname?: string;
    os?: string;
    arch?: string;
    agentVersion?: string;
  }) {
    await this.pool.query(
      `UPDATE servers
         SET hostname = coalesce($2, hostname),
             os = coalesce($3, os),
             arch = coalesce($4, arch),
             agent_version = coalesce($5, agent_version),
             last_seen_at = now()
       WHERE id=$1`,
      [serverId, info.hostname, info.os, info.arch, info.agentVersion],
    );
  }
}
