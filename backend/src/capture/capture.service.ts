import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createWriteStream, promises as fsp } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';
import { CaptureGateway } from './capture.gateway';

// Onde os .pcap ficam persistidos (volume Docker). Retenção de 7 dias — ver
// purgeOldPcaps(). Cada captura vira <dir>/<sessionId>.pcap.
const CAPTURE_STORAGE_DIR = process.env.CAPTURE_STORAGE_DIR ?? '/data/captures';
const PCAP_RETENTION_DAYS = 7;

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
    const id = r.rows[0].id;
    // Captura SIP NÃO exige aprovação: já inicia, auto-aprovada pelo próprio
    // solicitante. tcpdump/ping continuam exigindo aprovação por serem mais
    // sensíveis (filtro BPF livre / alvo arbitrário). O front conecta no
    // /ws/captures logo após receber o id; o buffer de catch-up do gateway
    // cobre a corrida do WS vs. o agent já começar a mandar bytes.
    if (opts.kind === 'sip') {
      const s = await this.getOrThrow(id);
      if (!this.control.isOnline(s.server_id)) {
        throw new ForbiddenException('agent deste servidor está offline');
      }
      await this.startSession(s, opts.userId);
      return { id, autoStarted: true };
    }
    return { id, autoStarted: false };
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
    await this.startSession(s, approverId);
    return { ok: true, status: 'running' };
  }

  /**
   * Encerra manualmente uma captura em andamento (botão "parar" na UI): manda
   * o agent matar o tcpdump; o capture.run resolve sozinho quando o processo
   * fecha e o fluxo normal (invokeStream .then) grava status/forwardDone.
   */
  async stop(id: string) {
    const s = await this.getOrThrow(id);
    if (s.status !== 'running') throw new BadRequestException('captura não está em andamento');
    try {
      await this.control.invoke(s.server_id, 'capture.stop', { sessionId: id }, { timeoutMs: 10_000 });
    } catch {
      // Se o agent não respondeu, o corte por tempo ainda encerra sozinho.
    }
    return { ok: true };
  }

  /** Dispara a captura no agent (compartilhado por approve() e pelo auto-start do SIP). */
  private async startSession(s: CaptureSessionRow, approverId: string) {
    const id = s.id;
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

    // sip/tcpdump: streaming ao vivo pra quem assiste (gateway) E gravação
    // incremental em disco (persistência de 7 dias). Cada chunk é escrito
    // direto num WriteStream — sem acumular o .pcap inteiro em memória.
    const filePath = this.pcapPath(id);
    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    let wroteBytes = 0;
    // IMPORTANTE: abre o arquivo ANTES de disparar a captura (await). Se isso
    // fosse assíncrono/paralelo, os primeiros chunks — inclusive o CABEÇALHO
    // global do .pcap — chegavam antes do stream existir e se perdiam, salvando
    // um arquivo corrompido (ou nada, em captura curta → "pcap indisponível").
    try {
      await fsp.mkdir(CAPTURE_STORAGE_DIR, { recursive: true });
      fileStream = createWriteStream(filePath);
    } catch (e: any) {
      this.logger.warn(`não foi possível abrir arquivo de captura ${id.slice(0, 8)}: ${e?.message}`);
      fileStream = null;
    }

    this.control.invokeStream(s.server_id, 'capture.run', args, (chunkB64: string) => {
      this.gateway.forwardChunk(id, chunkB64);
      if (fileStream) {
        const buf = Buffer.from(chunkB64, 'base64');
        wroteBytes += buf.length;
        fileStream.write(buf);
      }
    }, timeoutMs)
      .then(async (result: any) => {
        const status = result?.ok ? 'completed' : 'failed';
        // Fecha o arquivo e decide se mantém: só persiste captura ok e não-vazia.
        const stored = await this.finalizePcap(fileStream, filePath, !!result?.ok && wroteBytes > 0);
        await this.pool.query(
          `UPDATE capture_sessions SET status=$2, packet_count=$3, file_size_bytes=$4, error_text=$5, pcap_stored=$6, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, status, result?.packetCount ?? null, result?.fileSizeBytes ?? wroteBytes ?? null, result?.error ?? null, stored],
        );
        this.gateway.forwardDone(id, {
          ok: !!result?.ok, packetCount: result?.packetCount, fileSizeBytes: result?.fileSizeBytes, error: result?.error,
        });
      })
      .catch(async (e: any) => {
        this.logger.warn(`capture.run falhou (session ${id.slice(0, 8)}): ${e.message}`);
        await this.finalizePcap(fileStream, filePath, false);
        await this.pool.query(
          `UPDATE capture_sessions SET status='failed', error_text=$2, pcap_stored=false, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, e.message],
        );
        this.gateway.forwardDone(id, { ok: false, error: e.message });
      });

    return { ok: true, status: 'running' };
  }

  private pcapPath(id: string): string {
    return join(CAPTURE_STORAGE_DIR, `${id}.pcap`);
  }

  /** Fecha o WriteStream e mantém o arquivo só se `keep`; senão apaga. Retorna se ficou salvo. */
  private async finalizePcap(
    stream: ReturnType<typeof createWriteStream> | null,
    filePath: string,
    keep: boolean,
  ): Promise<boolean> {
    if (stream) await new Promise<void>((res) => stream.end(() => res()));
    if (keep) return true;
    try { await fsp.unlink(filePath); } catch { /* não existia */ }
    return false;
  }

  /** Caminho + nome + tamanho do .pcap persistido de uma sessão, se ainda existir. */
  async pcapFile(id: string): Promise<{ path: string; filename: string; size: number } | null> {
    const r = await this.pool.query(`SELECT pcap_stored FROM capture_sessions WHERE id=$1`, [id]);
    if (!r.rowCount || !r.rows[0].pcap_stored) return null;
    const path = this.pcapPath(id);
    try {
      const st = await fsp.stat(path);
      if (!st.isFile() || st.size === 0) return null;
      return { path, filename: `capture-${id.slice(0, 8)}.pcap`, size: st.size };
    } catch {
      return null;
    }
  }

  /**
   * Retenção: apaga .pcap com mais de 7 dias (roda de hora em hora). Limpa o
   * arquivo em disco e zera pcap_stored — a sessão continua no histórico, só
   * sem o arquivo pra baixar.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeOldPcaps() {
    const r = await this.pool.query(
      `SELECT id FROM capture_sessions
       WHERE pcap_stored = true AND finished_at < now() - ($1 || ' days')::interval`,
      [PCAP_RETENTION_DAYS],
    );
    for (const row of r.rows) {
      try { await fsp.unlink(this.pcapPath(row.id)); } catch { /* já sumiu */ }
      await this.pool.query(`UPDATE capture_sessions SET pcap_stored=false WHERE id=$1`, [row.id]);
    }
    if (r.rowCount) this.logger.log(`Retenção de capturas: ${r.rowCount} .pcap com >${PCAP_RETENTION_DAYS}d removidos`);
    return { removed: r.rowCount };
  }
}
