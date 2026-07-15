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

// Teto de tempo do invokeStream. 60s fixo se mostrou curto demais na prática:
// unity.log rotaciona a cada poucos minutos (~10MB/rotação), então uma janela
// de 12h já significa ler mais de uma centena desses arquivos linha a linha
// (leitura sequencial no agent, sem paralelismo) — passa fácil de 60s mesmo
// com o agent saudável. Em modo LISTAGEM (sem query, usado por "chamadas
// recentes") isso é ainda mais crítico: só existe UM onChunk, no final do
// scan inteiro (ver agent/src/log-scan.ts) — se estourar o timeout, o usuário
// não vê NADA, mesmo que o agent estivesse a poucos arquivos de terminar.
// Escalamos o timeout com o tamanho da janela pedida em vez de um valor fixo:
// piso de 60s (janelas curtas, minutos), teto de 5min (perto do limite de 48h
// da tela /unity) — long enough pra não cortar scans grandes de agents
// saudáveis, sem deixar uma sessão pendurada indefinidamente se o agent
// realmente estiver travado.
const SCAN_TIMEOUT_MIN_MS = 60_000;
const SCAN_TIMEOUT_MAX_MS = 5 * 60_000;
const SCAN_TIMEOUT_MS_PER_HOUR = 10_000;

function computeScanTimeoutMs(from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return SCAN_TIMEOUT_MIN_MS;
  }
  const windowHours = (toMs - fromMs) / 3_600_000;
  const scaled = SCAN_TIMEOUT_MIN_MS + windowHours * SCAN_TIMEOUT_MS_PER_HOUR;
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
