import { Injectable, Logger } from '@nestjs/common';
import { request } from 'undici';

/**
 * Cliente de leitura para Patroni.
 *
 * Patroni expõe REST API em cada nó (default :8008) com endpoints como
 *   /          → status do nó (state, role, xlog, timeline...)
 *   /cluster   → visão completa do cluster
 *   /history   → histórico de switchovers
 *
 * Configure via env:
 *   PATRONI_NODES=http://pg1:8008,http://pg2:8008,http://pg3:8008
 *
 * Em produção use TLS + auth básica + restringir source IP.
 */
@Injectable()
export class PatroniService {
  private readonly logger = new Logger('PatroniService');
  private readonly nodes: string[] = (process.env.PATRONI_NODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  private readonly basicAuth = process.env.PATRONI_BASIC_AUTH || '';

  private headers() {
    const h: Record<string, string> = {};
    if (this.basicAuth) h['authorization'] = `Basic ${Buffer.from(this.basicAuth).toString('base64')}`;
    return h;
  }

  async clusterStatus() {
    if (!this.nodes.length) {
      return { ok: false, message: 'Patroni não configurado (PATRONI_NODES)' };
    }
    // Tenta cada nó até obter visão de cluster
    for (const node of this.nodes) {
      try {
        const res = await request(`${node}/cluster`, { headers: this.headers(), bodyTimeout: 5000 });
        if (res.statusCode < 400) {
          const body = (await res.body.json()) as any;
          return {
            ok: true,
            via: node,
            scope: body.scope || null,
            members: (body.members || []).map((m: any) => ({
              name: m.name,
              role: m.role,
              state: m.state,
              host: m.host,
              port: m.port,
              api_url: m.api_url,
              timeline: m.timeline,
              lag: m.lag,
              xlog_location: m.xlog_location,
              tags: m.tags,
            })),
          };
        }
      } catch (e: any) {
        this.logger.warn(`patroni ${node} failed: ${e.message}`);
      }
    }
    return { ok: false, message: 'Todos os nós Patroni inacessíveis' };
  }

  async nodeStatus(node: string) {
    const res = await request(node, { headers: this.headers(), bodyTimeout: 5000 });
    return res.body.json();
  }

  async history() {
    for (const node of this.nodes) {
      try {
        const res = await request(`${node}/history`, { headers: this.headers(), bodyTimeout: 5000 });
        if (res.statusCode < 400) return await res.body.json();
      } catch {
        /* try next */
      }
    }
    return [];
  }
}
