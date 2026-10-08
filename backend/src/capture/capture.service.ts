import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
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
export class CaptureService implements OnApplicationBootstrap {
  private readonly logger = new Logger('CaptureService');
  /**
   * Sessões com captura realmente em andamento NESTE processo. O estado da captura
   * (promise do agent, arquivo aberto) vive só em memória: se o backend reinicia,
   * uma sessão 'running' do banco que não está aqui é órfã e nunca vai terminar.
   */
  private readonly live = new Set<string>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly control: ControlGateway,
    private readonly gateway: CaptureGateway,
  ) {}

  /** No boot, nada está em andamento: tudo que ficou running/pending é órfão. */
  async onApplicationBootstrap() {
    try {
      const r = await this.pool.query(
        `UPDATE capture_sessions
            SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'expired' END,
                error_text = CASE WHEN status = 'running'
                  THEN 'captura interrompida: o SmartGard reiniciou durante a captura'
                  ELSE 'não iniciou (pedido antigo sem captura em andamento)' END,
                finished_at = coalesce(finished_at, now())
          WHERE status IN ('running','pending','approved')`,
      );
      if (r.rowCount) this.logger.warn(`${r.rowCount} sessão(ões) de captura órfã(s) encerrada(s) no boot`);
    } catch (e: any) {
      this.logger.error(`limpeza de capturas órfãs falhou: ${e?.message}`);
    }
  }

  /**
   * Vigia: encerra sessões que passaram do prazo sem resposta do agent (duração + 3 min)
   * e pedidos que nunca iniciaram. Não toca nas que estão vivas e dentro do prazo.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async reapStale() {
    try {
      const r = await this.pool.query(
        `SELECT id FROM capture_sessions
          WHERE status = 'running'
            AND coalesce(started_at, created_at) + (duration_seconds + 180) * interval '1 second' < now()`,
      );
      for (const row of r.rows) {
        this.live.delete(row.id);
        await this.pool.query(
          `UPDATE capture_sessions SET status='failed', finished_at=now(),
                  error_text='sem resposta do agent após o fim previsto da captura (conexão com o agent caiu?)'
            WHERE id=$1 AND status='running'`,
          [row.id],
        );
        this.gateway.forwardDone(row.id, { ok: false, error: 'sem resposta do agent após o fim previsto da captura' });
      }
      await this.pool.query(
        `UPDATE capture_sessions SET status='expired', finished_at=now(),
                error_text=coalesce(error_text, 'não iniciou')
          WHERE status IN ('pending','approved') AND created_at < now() - interval '10 minutes'`,
      );
    } catch (e: any) {
      this.logger.warn(`vigia de capturas falhou: ${e?.message}`);
    }
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
    // Estado real do .pcap (o que a tela mostra): salvo, expirado pela retenção,
    // arquivo sumido do disco (ex.: volume de capturas recriado) ou nunca salvo.
    await Promise.all(r.rows.map(async (row: any) => {
      row.live = this.live.has(row.id);
      if (row.kind === 'ping' || row.status !== 'completed') return;
      if (row.pcap_stored) {
        const ok = await fsp.stat(this.pcapPath(row.id)).then((st) => st.isFile() && st.size > 0).catch(() => false);
        row.pcap_state = ok ? 'stored' : 'missing';
      } else {
        const ageDays = row.finished_at ? (Date.now() - new Date(row.finished_at).getTime()) / 86_400_000 : 0;
        row.pcap_state = ageDays >= PCAP_RETENTION_DAYS ? 'expired' : 'not_saved';
      }
    }));
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
    // Checa o agent ANTES de gravar: antes a sessão era criada como 'pending', o pedido
    // era recusado por agent offline e a linha ficava pendurada para sempre.
    if (!this.control.isOnline(opts.serverId)) {
      throw new ForbiddenException('o agent deste servidor está offline: a captura não foi iniciada');
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
    // Captura NÃO exige mais aprovação: quem tem capture:request (acesso à tela)
    // já dispara direto. Qualquer tipo (sip/tcpdump/ping) inicia na hora,
    // auto-aprovado pelo próprio solicitante. O front conecta no /ws/captures
    // logo após receber o id; o buffer de catch-up do gateway cobre a corrida
    // do WS vs. o agent já começar a mandar bytes.
    const s = await this.getOrThrow(id);
    try {
      await this.startSession(s, opts.userId);
    } catch (e: any) {
      await this.pool.query(
        `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1`,
        [id, `não foi possível iniciar: ${e?.message ?? e}`],
      );
      throw e;
    }
    return { id, autoStarted: true };
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
    if (!this.live.has(id)) {
      // Órfã (backend reiniciou): não há o que parar no agent; só encerra o registro.
      await this.pool.query(
        `UPDATE capture_sessions SET status='failed', error_text='encerrada manualmente (captura não estava mais em andamento)', finished_at=now() WHERE id=$1 AND status='running'`,
        [id],
      );
      this.gateway.forwardDone(id, { ok: false, error: 'captura não estava mais em andamento' });
      return { ok: true, orphan: true };
    }
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
    this.live.add(id);
    const friendly = (e: any) => {
      const m = String(e?.message ?? e);
      if (/agent timeout after/.test(m)) {
        return `o agent não confirmou o fim da captura em ${s.duration_seconds + 30}s (conexão com o agent caiu ou o servidor está sobrecarregado)`;
      }
      if (/agent offline/.test(m)) return 'o agent deste servidor está offline';
      return m;
    };
    const args = {
      sessionId: id, kind: s.kind, iface: s.iface, filterExpr: s.filter_expr ?? undefined,
      targetHost: s.target_host ?? undefined, durationSeconds: s.duration_seconds, maxPackets: s.max_packets,
    };

    if (s.kind === 'ping') {
      // Texto curto, sem stream — resolve direto na resposta do invoke().
      this.control.invoke(s.server_id, 'capture.run', args, { timeoutMs })
        .then(async (result: any) => {
          this.live.delete(id);
          await this.pool.query(
            `UPDATE capture_sessions SET status=$2, result_text=$3, error_text=$4, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, result?.ok ? 'completed' : 'failed', result?.resultText ?? null, result?.error ?? null],
          );
          this.gateway.forwardDone(id, { ok: !!result?.ok, resultText: result?.resultText, error: result?.error });
        })
        .catch(async (e: any) => {
          this.live.delete(id);
          this.logger.warn(`capture.run (ping) falhou (session ${id.slice(0, 8)}): ${e.message}`);
          await this.pool.query(
            `UPDATE capture_sessions SET status='failed', error_text=$2, finished_at=now() WHERE id=$1 AND status='running'`,
            [id, friendly(e)],
          );
          this.gateway.forwardDone(id, { ok: false, error: friendly(e) });
        });
      return { ok: true, status: 'running' };
    }

    // sip/tcpdump: streaming ao vivo pra quem assiste (gateway) E gravação
    // incremental em disco (persistência de 7 dias). Cada chunk é escrito
    // direto num WriteStream — sem acumular o .pcap inteiro em memória.
    const filePath = this.pcapPath(id);
    let fileStream: ReturnType<typeof createWriteStream> | null = null;
    let wroteBytes = 0;
    let saveError: string | null = null;
    // IMPORTANTE: abre o arquivo ANTES de disparar a captura (await). Se isso
    // fosse assíncrono/paralelo, os primeiros chunks — inclusive o CABEÇALHO
    // global do .pcap — chegavam antes do stream existir e se perdiam.
    //
    // Abre com fsp.open (o erro de permissão/disco cai AQUI, no try) e só então cria o
    // WriteStream sobre o fd, COM listener de 'error'. Antes era createWriteStream(path)
    // sem listener: o EACCES chegava assíncrono como 'error' não tratado e DERRUBAVA O
    // BACKEND INTEIRO (502 para todos) — foi o que aconteceu com o backend rodando como
    // usuário 'node' e a pasta ./capturas_sip pertencendo ao root.
    try {
      await fsp.mkdir(CAPTURE_STORAGE_DIR, { recursive: true });
      const fh = await fsp.open(filePath, 'w');
      fileStream = createWriteStream(filePath, { fd: fh.fd, autoClose: true });
      fileStream.on('error', (e: any) => {
        // Ex.: disco cheio no meio da captura. A captura segue ao vivo; só para de salvar.
        saveError = `não foi possível gravar o .pcap: ${e?.code ?? e?.message}`;
        this.logger.error(`captura ${id.slice(0, 8)}: ${saveError}`);
        try { fileStream?.destroy(); } catch { /* ignore */ }
        fileStream = null;
      });
    } catch (e: any) {
      saveError = e?.code === 'EACCES'
        ? `sem permissão para gravar em ${CAPTURE_STORAGE_DIR} (no host: chown -R 1000:1000 ./capturas_sip)`
        : `não foi possível abrir o arquivo do .pcap: ${e?.code ?? e?.message}`;
      this.logger.error(`captura ${id.slice(0, 8)}: ${saveError} — seguindo só ao vivo`);
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
        this.live.delete(id);
        const status = result?.ok ? 'completed' : 'failed';
        // Fecha o arquivo e decide se mantém: só persiste captura ok e não-vazia.
        const stored = !saveError && await this.finalizePcap(fileStream, filePath, !!result?.ok && wroteBytes > 0);
        if (saveError) await this.finalizePcap(fileStream, filePath, false);
        await this.pool.query(
          `UPDATE capture_sessions SET status=$2, packet_count=$3, file_size_bytes=$4, error_text=$5, pcap_stored=$6, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, status, result?.packetCount ?? null, result?.fileSizeBytes ?? wroteBytes ?? null, result?.error ?? saveError ?? null, stored],
        );
        this.gateway.forwardDone(id, {
          ok: !!result?.ok, packetCount: result?.packetCount, fileSizeBytes: result?.fileSizeBytes, error: result?.error,
        });
      })
      .catch(async (e: any) => {
        this.live.delete(id);
        this.logger.warn(`capture.run falhou (session ${id.slice(0, 8)}): ${e.message}`);
        // Mantém o que já foi gravado em disco se veio algo (captura parcial ainda é útil).
        const stored = !saveError && await this.finalizePcap(fileStream, filePath, wroteBytes > 0);
        await this.pool.query(
          `UPDATE capture_sessions SET status='failed', error_text=$2, pcap_stored=$3, file_size_bytes=$4, finished_at=now() WHERE id=$1 AND status='running'`,
          [id, friendly(e) + (stored ? ' — o que foi capturado até a falha foi salvo' : ''), stored, wroteBytes || null],
        );
        this.gateway.forwardDone(id, { ok: false, error: friendly(e) });
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
    if (stream && !stream.destroyed) await new Promise<void>((res) => { stream.end(() => res()); stream.once('error', () => res()); });
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
