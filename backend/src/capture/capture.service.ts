import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { promises as fsp } from 'fs';
import { join } from 'path';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

const CAPTURES_DIR = process.env.CAPTURES_DIR || join(process.cwd(), 'data', 'captures');

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
  file_path: string | null;
  file_size_bytes: number | null;
  packet_count: number | null;
  result_text: string | null;
  error_text: string | null;
  created_at: string;
}

/**
 * Captura de rede/SIP sob aprovação — reusa o motor pedido→aprovação do
 * Terminal Web, mas a "execução" é assíncrona: approve() dispara o agent e
 * retorna na hora (não trava a requisição HTTP por até 30min). O resultado
 * chega depois por dois caminhos:
 *  - kind='ping': pela resolução do próprio invoke() (rápido, síncrono pro agent).
 *  - kind='sip'|'tcpdump': pelo upload do .pcap (handleUpload), que é quem
 *    efetivamente marca a sessão como 'completed' — o invoke() aqui só serve
 *    de sinalização de erro/timeout caso o agent nunca chegue a fazer o upload.
 */
@Injectable()
export class CaptureService {
  private readonly logger = new Logger('CaptureService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly control: ControlGateway,
  ) {}

  private async ensureDir() {
    await fsp.mkdir(CAPTURES_DIR, { recursive: true });
  }

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
              ru.email AS requested_by_email, au.email AS approved_by_email
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
         (server_id, kind, iface, filter_expr, target_host, duration_seconds, max_packets, reason, status, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING id`,
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

  /** Aprova e dispara o agent — não espera o término (retorna logo). */
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
    this.control.invoke(s.server_id, 'capture.run', {
      sessionId: id, kind: s.kind, iface: s.iface, filterExpr: s.filter_expr ?? undefined,
      targetHost: s.target_host ?? undefined, durationSeconds: s.duration_seconds, maxPackets: s.max_packets,
    }, { timeoutMs })
      .then(async (result: any) => {
        if (s.kind === 'ping') {
          await this.pool.query(
            `UPDATE capture_sessions SET status=$2, result_text=$3, error_text=$4, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, result?.ok ? 'completed' : 'failed', result?.resultText ?? null, result?.error ?? null],
          );
          return;
        }
        // sip/tcpdump: o upload (handleUpload) já deve ter marcado 'completed'.
        // Se o agent respondeu erro (não chegou a subir o arquivo), registra a falha.
        if (!result?.ok) {
          await this.pool.query(
            `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, result?.error ?? 'falha desconhecida na captura'],
          );
        }
      })
      .catch(async (e: any) => {
        this.logger.warn(`capture.run falhou (session ${id.slice(0, 8)}): ${e.message}`);
        await this.pool.query(
          `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, e.message],
        );
      });

    return { ok: true, status: 'running' };
  }

  /** Chamado pelo CaptureController via endpoint autenticado por API key do agent. */
  async handleUpload(sessionId: string, serverId: string, opts: { fileBase64: string; packetCount?: number; fileSizeBytes?: number }) {
    const s = await this.getOrThrow(sessionId);
    if (s.server_id !== serverId) {
      throw new ForbiddenException('sessão não pertence a este servidor');
    }
    await this.ensureDir();
    const filePath = join(CAPTURES_DIR, `${sessionId}.pcap`);
    const buf = Buffer.from(opts.fileBase64, 'base64');
    await fsp.writeFile(filePath, buf);
    await this.pool.query(
      `UPDATE capture_sessions
         SET status='completed', file_path=$2, file_size_bytes=$3, packet_count=$4, finished_at=now()
       WHERE id=$1`,
      [sessionId, filePath, opts.fileSizeBytes ?? buf.length, opts.packetCount ?? null],
    );
    return { ok: true };
  }

  /** Retorna o path físico pro controller fazer o stream — quem chama já validou permissão/ownership. */
  async getDownloadPath(id: string, userId: string, canApproveAny: boolean): Promise<{ path: string; filename: string }> {
    const s = await this.getOrThrow(id);
    if (!canApproveAny && s.requested_by !== userId) {
      throw new ForbiddenException('você só pode baixar capturas que você mesmo solicitou');
    }
    if (s.status !== 'completed' || !s.file_path) {
      throw new BadRequestException('captura ainda não está concluída ou não gerou arquivo');
    }
    return { path: s.file_path, filename: `capture-${id.slice(0, 8)}.pcap` };
  }
}
