import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ControlGateway } from '../docker-manager/control.gateway';
import { LogScanGateway } from './log-scan.gateway';

export interface LogScanParams {
  directory: string;
  filePrefix?: string;
  from: string;
  to: string;
  query?: string;
  maxMatches?: number;
}

// Teto de tempo do invokeStream — o scan em si é rápido (leitura sequencial
// de arquivo local no agent), 60s é folga generosa mesmo pra dezenas de
// arquivos de ~10MB. Se estourar, o HTTP de start() já respondeu há muito
// tempo (fire-and-forget); só o evento final via WS chega como 'error'.
const SCAN_TIMEOUT_MS = 60_000;

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
    this.control
      .invokeStream(serverId, 'logscan.run', args, (chunk: any) => {
        this.gateway.forwardChunk(sessionId, chunk);
      }, SCAN_TIMEOUT_MS)
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
