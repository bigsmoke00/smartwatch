import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

export interface Node {
  id: string; kind: string; name: string;
  refType?: string; refId?: string;
  metadata: Record<string, any>; position?: { x: number; y: number } | null;
  status: 'healthy' | 'degraded' | 'down' | 'unknown';
  lastSeenAt?: Date | null;
}
export interface Edge {
  id: string; srcId: string; dstId: string;
  kind: string; protocol?: string; port?: number;
  metadata: Record<string, any>; source: 'agent_discovery' | 'manual';
}

@Injectable()
export class TopologyService {
  private readonly logger = new Logger('TopologyService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
  ) {}

  async graph(): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const nodes = await this.pool.query(`
      SELECT id, kind, name, ref_type AS "refType", ref_id AS "refId",
             metadata, position, status, last_seen_at AS "lastSeenAt"
      FROM topology_nodes`);
    const edges = await this.pool.query(`
      SELECT id, src_id AS "srcId", dst_id AS "dstId", kind, protocol, port,
             metadata, source FROM topology_edges`);
    return { nodes: nodes.rows, edges: edges.rows };
  }

  async upsertNode(input: Partial<Node>) {
    const r = await this.pool.query(
      `INSERT INTO topology_nodes(kind, name, ref_type, ref_id, metadata, position, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
       ON CONFLICT (kind, ref_type, ref_id)
       DO UPDATE SET name=EXCLUDED.name, metadata=EXCLUDED.metadata,
                     position=COALESCE(EXCLUDED.position, topology_nodes.position),
                     status=EXCLUDED.status, last_seen_at=now()
       RETURNING id`,
      [
        input.kind, input.name, input.refType ?? null, input.refId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.position ? JSON.stringify(input.position) : null,
        input.status ?? 'unknown',
      ],
    );
    return r.rows[0];
  }

  async setNodePosition(id: string, x: number, y: number) {
    await this.pool.query(
      `UPDATE topology_nodes SET position=$2::jsonb WHERE id=$1`,
      [id, JSON.stringify({ x, y })],
    );
    return { ok: true };
  }

  async deleteNode(id: string) {
    await this.pool.query(`DELETE FROM topology_nodes WHERE id=$1`, [id]);
    return { ok: true };
  }

  async upsertEdge(input: Partial<Edge> & { srcId: string; dstId: string }) {
    const r = await this.pool.query(
      `INSERT INTO topology_edges(src_id, dst_id, kind, protocol, port, metadata, source)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (src_id, dst_id, kind, port)
       DO UPDATE SET metadata=EXCLUDED.metadata, last_seen_at=now()
       RETURNING id`,
      [
        input.srcId, input.dstId, input.kind ?? 'connects_to',
        input.protocol ?? null, input.port ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.source ?? 'manual',
      ],
    );
    return r.rows[0];
  }

  async deleteEdge(id: string) {
    await this.pool.query(`DELETE FROM topology_edges WHERE id=$1`, [id]);
    return { ok: true };
  }

  // ========== Auto-discovery ==========
  /**
   * A cada 2 minutos:
   *  - cria/atualiza nó pra cada server
   *  - cria/atualiza nó pra cada container ativo
   *  - cria edge "hosts" entre server → container
   *  - cria nó pra cada cluster PostgreSQL configurado
   *  - tenta inferir conexões TCP via `ss`/netstat (best-effort no agent)
   */
  @Cron(CronExpression.EVERY_2_MINUTES)
  async discover() {
    try {
      // 1) Servers
      const servers = await this.pool.query(`SELECT id, name, last_seen_at FROM servers`);
      for (const s of servers.rows) {
        const fresh = s.last_seen_at && (Date.now() - new Date(s.last_seen_at).getTime() < 10 * 60_000);
        await this.upsertNode({
          kind: 'server', name: s.name,
          refType: 'servers', refId: s.id,
          status: fresh ? 'healthy' : 'down',
        });
      }

      // 2) Containers + edges hosts
      const cs = await this.pool.query(`
        SELECT c.server_id, c.container_id, c.name, c.image, c.state, c.last_seen_at,
               s.name AS server_name
        FROM containers c JOIN servers s ON s.id = c.server_id
      `);
      for (const c of cs.rows) {
        const fresh = c.last_seen_at && (Date.now() - new Date(c.last_seen_at).getTime() < 5 * 60_000);
        const cn = await this.upsertNode({
          kind: 'container',
          name: `${c.name} (${c.server_name})`,
          refType: 'containers', refId: `${c.server_id}:${c.container_id}`,
          status: fresh && c.state === 'running' ? 'healthy' : c.state === 'exited' ? 'degraded' : 'down',
          metadata: { image: c.image, state: c.state, serverId: c.server_id },
        });
        // edge server → container
        const sn = await this.pool.query(
          `SELECT id FROM topology_nodes WHERE kind='server' AND ref_id=$1`,
          [c.server_id],
        );
        if (sn.rowCount && cn?.id) {
          await this.upsertEdge({
            srcId: sn.rows[0].id, dstId: cn.id, kind: 'hosts',
            source: 'agent_discovery',
          });
        }
      }

      // 3) Postgres clusters
      const pg = await this.pool.query(`SELECT id, name FROM pg_clusters WHERE enabled=true`);
      for (const p of pg.rows) {
        await this.upsertNode({
          kind: 'database', name: p.name,
          refType: 'pg_clusters', refId: p.id,
          status: 'unknown',
        });
      }

      // 4) Conexões inferidas via agent (TCP outgoing) — best-effort
      // O agent faz `ss -tnp state established` num intervalo e expõe via op `host.connections`.
      // Aqui não chamamos por servidor pra não martelar — fica como TODO:
      //   for each server: invoke('host.connections') → cria edge container→external
    } catch (e: any) {
      this.logger.warn(`discover: ${e.message}`);
    }
  }
}
