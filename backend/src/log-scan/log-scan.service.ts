import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ControlGateway } from '../docker-manager/control.gateway';
import { LogScanGateway } from './log-scan.gateway';

export interface LogScanParams {
  directory: string;
  filePrefix?: string;
  from: string;
  to: string;
  // '' (string vazia) é diferente de omitido — ver agent/src/log-scan.ts.
  // Omitido = modo listagem (chamadas recentes); presente (mesmo vazio) =
  // modo busca/streaming, inclusive "abrir tudo" sem termo nenhum.
  query?: string;
  // Filtro por "Regex (PASS)"/"Regex (FAIL)" literal nas linhas — combinável
  // (AND) com query. Ver comentário equivalente em agent/src/log-scan.ts.
  status?: 'pass' | 'fail';
  maxMatches?: number;
}

// Teto de tempo do invokeStream. Escalar por HORA (versão anterior) fazia
// pouca diferença dentro do teto de 10min da tela /unity (2/5/10min geram
// quase o mesmo orçamento, ~60-62s) — e na prática esse volume já é curto
// demais: o SIP-Server de produção gera um volume de trace ABSURDO (300-400
// mil linhas em só 2-10 minutos, modo "abrir tudo"/sem filtro), então mesmo
// as linhas chegando certinho via streaming, o invokeStream como um todo (só
// resolve quando o agent manda o "docker:reply" final, depois de varrer TODOS
// os arquivos selecionados) estourava o timeout por pouco — visto em
// produção: 60.8s não bastou pra ~350k linhas, 61.7s não bastou pra ~420k.
// Escala agora por MINUTO de janela pedida, com piso bem mais alto: cobre
// esse volume com folga sem deixar uma sessão realmente travada rodando pra
// sempre (teto ainda existe, só que generoso — mesma ordem de grandeza do
// teto de janela da própria tela, 10min).
const SCAN_TIMEOUT_MIN_MS = 3 * 60_000;
const SCAN_TIMEOUT_MAX_MS = 10 * 60_000;
const SCAN_TIMEOUT_MS_PER_MINUTE = 30_000;

function computeScanTimeoutMs(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return SCAN_TIMEOUT_MIN_MS;
  }
  const windowMinutes = (toMs - fromMs) / 60_000;
  const scaled = SCAN_TIMEOUT_MIN_MS + windowMinutes * SCAN_TIMEOUT_MS_PER_MINUTE;
  return Math.min(SCAN_TIMEOUT_MAX_MS, Math.max(SCAN_TIMEOUT_MIN_MS, scaled));
}

/**
 * Scan de log sob demanda (ex.: busca de call UUID no unity.log do
 * FreeSWITCH) — por pedido explícito do usuário, NADA fica salvo no banco.
 * startScan() dispara o agent via invokeStream('logscan.run') e retorna um
 * sessionId IMEDIATAMENTE; o browser conecta em /ws/logscan com esse
 * sessionId e assiste os batches por conta própria (mesmo modelo de
 * CaptureService/CaptureGateway, só sem tabela de sessões no banco — aqui não
 * existe fluxo de aprovação, o scan começa na hora pra quem tem logs:read).
 */
@Injectable()
export class LogScanService {
  private readonly logger = new Logger('LogScanService');

  // sessionId -> serverId, só pra permitir POST /log-scan/:sessionId/stop sem
  // precisar do serverId na URL. Limpo assim que o scan termina (done/error).
  private sessionServers = new Map<string, string>();

  constructor(
    private readonly control: ControlGateway,
    private readonly gateway: LogScanGateway,
  ) {}

  startScan(serverId: string, params: LogScanParams): { sessionId: string } {
    if (!this.control.isOnline(serverId)) {
      throw new ForbiddenException('agent deste servidor está offline');
    }
    const sessionId = randomUUID();
    this.sessionServers.set(sessionId, serverId);

    const args = { sessionId, ...params };
    const timeoutMs = computeScanTimeoutMs(params.from, params.to);
    this.control
      .invokeStream(serverId, 'logscan.run', args, (chunk: any) => {
        this.gateway.forwardChunk(sessionId, chunk);
      }, timeoutMs)
      .then((result: any) => {
        this.gateway.forwardDone(sessionId, { ok: true, ...result });
      })
      .catch((e: any) => {
        this.logger.warn(`logscan.run falhou (session ${sessionId.slice(0, 8)}): ${e.message}`);
        this.gateway.forwardDone(sessionId, { ok: false, error: e.message });
      })
      .finally(() => {
        this.sessionServers.delete(sessionId);
      });

    return { sessionId };
  }

  /** Parada manual (botão na UI). Se a sessão já terminou, é um no-op silencioso. */
  async stop(sessionId: string): Promise<{ ok: boolean; stopped: boolean }> {
    const serverId = this.sessionServers.get(sessionId);
    if (!serverId) return { ok: true, stopped: false };
    try {
      await this.control.invoke(serverId, 'logscan.stop', { sessionId }, { timeoutMs: 10_000 });
    } catch {
      // Se o agent não respondeu, o próprio invokeStream do scan ainda encerra
      // sozinho pelo timeout — mesmo padrão de CaptureService.stop().
    }
    return { ok: true, stopped: true };
  }
}
