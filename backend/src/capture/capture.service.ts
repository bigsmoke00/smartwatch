import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';
import { CaptureGateway } from './capture.gateway';

export interface CaptureSessionRow {
  id: string;
  server_id: string;
  kind: 'sip' | 'tcpdump' | 'ping';
  iface: string;
  filter_expr: string | null;
  target_host: string | null;
  duration_seconds: number;
  max_packets: number;
  reason: string;
  status: string;
  requested_by: string;
  approved_by: string | null;
  file_size_bytes: number | null;
  packet_count: number | null;
  result_text: string | null;
  error_text: string | null;
  created_at: string;
}

/**
 * Captura de rede/SIP sob aprovação — reusa o motor pedido→aprovação do
 * Terminal Web, mas é 100% em tempo real e NADA fica salvo em disco (nem no
 * agent, nem aqui): approve() dispara o agent via invokeStream() e cada
 * chunk do .pcap (vindo direto do stdout do tcpdump) é repassado na hora
 * pro CaptureGateway, que entrega pra quem estiver assistindo a sessão via
 * ws /ws/captures. O navegador é quem monta o arquivo final e oferece
 * "salvar". Se ninguém estiver olhando no momento, o conteúdo se perde —
 * essa é a troca deliberada por não persistir tráfego de chamadas na
 * plataforma.
 */
@Injectable()
export class CaptureService {
  private readonly logger = new Logger('CaptureService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly control: ControlGateway,
    private readonly gateway: CaptureGateway,
  ) {}

  async listServersBasic() {
    const r = await this.pool.query(`SELECT id, name FROM servers ORDER BY name`);
    return r.rows;
  }

  async listSessions(opts: { mine?: boolean; userId?: string; pending?: boolean }) {
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.mine && opts.userId) { params.push(opts.userId); conds.push(`c.requested_by = $${params.length}`); }
    if (opts.pending) conds.push(`c.status IN ('pending','running')`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await this.pool.query(
      `SELECT c.*, s.name AS server_name,
              COALESCE(ru.email, c.requested_by_email) AS requested_by_email, au.email AS approved_by_email
       FROM capture_sessions c
       JOIN servers s ON s.id = c.server_id
       LEFT JOIN users ru ON ru.id = c.requested_by
       LEFT JOIN users au ON au.id = c.approved_by
       ${where}
       ORDER BY c.created_at DESC
       LIMIT 200`,
      params,
    );
    return r.rows;
  }

  async requestCapture(opts: {
    serverId: string; kind: 'sip' | 'tcpdump' | 'ping'; iface?: string;
    filterExpr?: string; targetHost?: string; durationSeconds?: number; maxPackets?: number;
    reason: string; userId: string;
  }) {
    if (opts.kind === 'ping' && !opts.targetHost) {
      throw new BadRequestException('targetHost é obrigatório para diagnóstico ping');
    }
    if (opts.kind === 'tcpdump' && !opts.filterExpr) {
      throw new BadRequestException('filterExpr é obrigatório para captura tcpdump genérica (ex.: "host 1.2.3.4 and port 443")');
    }
    const r = await this.pool.query(
      `INSERT INTO capture_sessions
         (server_id, kind, iface, filter_expr, target_host, duration_seconds, max_packets, reason, status, requested_by, requested_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,(SELECT email FROM users WHERE id=$9)) RETURNING id`,
      [
        opts.serverId, opts.kind, opts.iface || 'any', opts.filterExpr ?? null, opts.targetHost ?? null,
        opts.durationSeconds ?? 60, opts.maxPackets ?? 200_000, opts.reason, opts.userId,
      ],
    );
    return { id: r.rows[0].id };
  }

  private async getOrThrow(id: string): Promise<CaptureSessionRow> {
    const r = await this.pool.query(`SELECT * FROM capture_sessions WHERE id=$1`, [id]);
    if (!r.rowCount) throw new NotFoundException('sessão de captura não encontrada');
    return r.rows[0];
  }

  async reject(id: string, approverId: string) {
    const s = await this.getOrThrow(id);
    if (s.status !== 'pending') throw new BadRequestException('sessão não está pendente');
    await this.pool.query(
      `UPDATE capture_sessions SET status='rejected', approved_by=$2, approved_at=now() WHERE id=$1`,
      [id, approverId],
    );
    return { ok: true };
  }

  /**
   * Aprova e dispara o agent — não espera o término (retorna logo). O
   * cliente que chamou approve() deve já estar conectado em /ws/captures
   * com esse sessionId pra não perder o início do stream.
   */
  async approve(id: string, approverId: string) {
    const s = await this.getOrThrow(id);
    if (s.status !== 'pending') throw new BadRequestException('sessão não está pendente');
    if (!this.control.isOnline(s.server_id)) {
      throw new ForbiddenException('agent deste servidor está offline');
    }

    await this.pool.query(
      `UPDATE capture_sessions SET status='running', approved_by=$2, approved_at=now(), started_at=now() WHERE id=$1`,
      [id, approverId],
    );

    const timeoutMs = (s.duration_seconds + 30) * 1000;
    const args = {
      sessionId: id, kind: s.kind, iface: s.iface, filterExpr: s.filter_expr ?? undefined,
      targetHost: s.target_host ?? undefined, durationSeconds: s.duration_seconds, maxPackets: s.max_packets,
    };

    if (s.kind === 'ping') {
      // Texto curto, sem stream — resolve direto na resposta do invoke().
      this.control.invoke(s.server_id, 'capture.run', args, { timeoutMs })
        .then(async (result: any) => {
          await this.pool.query(
            `UPDATE capture_sessions SET status=$2, result_text=$3, error_text=$4, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, result?.ok ? 'completed' : 'failed', result?.resultText ?? null, result?.error ?? null],
          );
          this.gateway.forwardDone(id, { ok: !!result?.ok, resultText: result?.resultText, error: result?.error });
        })
        .catch(async (e: any) => {
          this.logger.warn(`capture.run (ping) falhou (session ${id.slice(0, 8)}): ${e.message}`);
          await this.pool.query(
            `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, e.message],
          );
          this.gateway.forwardDone(id, { ok: false, error: e.message });
        });
      return { ok: true, status: 'running' };
    }

    // sip/tcpdump: streaming ao vivo, sem disco em nenhum dos dois lados.
    this.control.invokeStream(s.server_id, 'capture.run', args, (chunkB64: string) => {
      this.gateway.forwardChunk(id, chunkB64);
    }, timeoutMs)
      .then(async (result: any) => {
        const status = result?.ok ? 'completed' : 'failed';
        await this.pool.query(
          `UPDATE capture_sessions SET status=$2, packet_count=$3, file_size_bytes=$4, error_text=$5, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, status, result?.packetCount ?? null, result?.fileSizeBytes ?? null, result?.error ?? null],
        );
        this.gateway.forwardDone(id, {
          ok: !!result?.ok, packetCount: result?.packetCount, fileSizeBytes: result?.fileSizeBytes, error: result?.error,
        });
      })
      .catch(async (e: any) => {
        this.logger.warn(`capture.run falhou (session ${id.slice(0, 8)}): ${e.message}`);
        await this.pool.query(
          `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, e.message],
        );
        this.gateway.forwardDone(id, { ok: false, error: e.message });
      });

    return { ok: true, status: 'running' };
  }
}
