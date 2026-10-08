import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { ServersService } from '../servers/servers.service';

interface PendingReq {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
  socketId: string;
  op: string;
  sessionId?: string;
  streams?: Array<(data: any) => void>;
}

/** Diagnóstico do canal de controle por servidor (exibido na UI quando o agent está offline). */
export interface AgentLinkDiag {
  online: boolean;
  connections: number;
  connectedAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  authError: string | null;
  authErrorAt: string | null;
  lastReplyAt: string | null;
}

// Erros de autenticação "de verdade" (chave inválida/revogada/IP fora da allowlist).
// Qualquer outro erro na validação (banco lento, pool esgotado, timeout) é transitório.
function isAuthError(e: any): boolean {
  return e instanceof UnauthorizedException;
}

// Operações que abrem/usam uma sessão de longa duração no agent: a sessão fica presa ao
// socket que a abriu (com agent duplicado, input/stop iam para o socket errado).
const SESSION_OPEN_OPS = new Set(['term.start', 'capture.run', 'logscan.run']);
const SESSION_OPS_PREFIX = /^(term|capture|logscan)\./;

const AUTH_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 30_000, 60_000];

/**
 * Canal de controle agent ↔ backend (socket.io, namespace /ws/control).
 *
 * O agent autentica com a API key no handshake. Correções importantes (ver
 * docs/diagnostico-agent-offline.md):
 *  - erro TRANSITÓRIO na validação (ex.: banco saturado) NÃO derruba mais o socket:
 *    o backend tenta validar de novo com backoff. Antes, ele dava disconnect e o
 *    socket.io-client NÃO reconecta sozinho após "io server disconnect" → o agent
 *    ficava offline pra sempre mesmo rodando;
 *  - corrida de reconexão: um handshake antigo que termina depois de um novo não
 *    sobrescreve mais o socket vivo com um morto;
 *  - vários sockets por servidor (agent duplicado com a mesma chave não "derruba" o outro);
 *  - pedidos pendentes são rejeitados na hora quando o socket cai (antes ficavam
 *    pendurados até o timeout);
 *  - respostas só são aceitas do socket que recebeu o pedido;
 *  - eventos de sockets não autenticados são ignorados.
 * O limite de tamanho de mensagem (maxHttpBufferSize) é definido no AppIoAdapter (main.ts).
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws/control',
})
export class ControlGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('ControlGateway');
  @WebSocketServer() server!: Server;

  /** serverId -> sockets autenticados (o último é o preferido). */
  private serverSockets = new Map<string, Socket[]>();
  private pending = new Map<string, PendingReq>();
  private diag = new Map<string, Omit<AgentLinkDiag, 'online' | 'connections'>>();
  /** sessionId -> socket que abriu a sessão (terminal, captura, scan de logs). */
  private sessionSocket = new Map<string, Socket>();

  constructor(private readonly servers: ServersService) {
    // Chave revogada / servidor removido: derruba na hora os sockets abertos desse servidor.
    this.servers.onKeysRevoked((serverId) => {
      for (const sock of this.serverSockets.get(serverId) ?? []) sock.disconnect(true);
    });
  }

  private touchDiag(serverId: string, patch: Partial<Omit<AgentLinkDiag, 'online' | 'connections'>>) {
    const cur = this.diag.get(serverId) ?? {
      connectedAt: null, disconnectedAt: null, disconnectReason: null,
      authError: null, authErrorAt: null, lastReplyAt: null,
    };
    this.diag.set(serverId, { ...cur, ...patch });
  }

  async handleConnection(client: Socket) {
    // O motivo da queda (ping timeout, transport close, server disconnect...) só vem neste evento.
    client.once('disconnect', (reason: string) => this.onSocketClosed(client, reason));
    const apiKey = client.handshake.auth?.apiKey as string | undefined;
    // Último hop do X-Forwarded-For = o que o NOSSO proxy adicionou (igual ao 'trust proxy 1'
    // do Express). O primeiro valor é controlado pelo cliente e não serve para allowlist.
    const xff = (client.handshake.headers['x-forwarded-for'] as string | undefined)?.split(',').map((x) => x.trim()).filter(Boolean);
    const ip = xff?.length ? xff[xff.length - 1] : client.handshake.address;
    if (!apiKey) {
      this.logger.warn(`control: conexão sem apiKey (${ip})`);
      client.disconnect(true);
      return;
    }

    for (let attempt = 0; ; attempt++) {
      if (!client.connected) return; // o agent desistiu/reconectou enquanto validávamos
      try {
        const srv = await this.servers.validateApiKey(apiKey, ip);
        if (!client.connected) return; // corrida: handshake antigo terminou depois de o socket cair
        (client.data as any).serverId = srv.id;
        (client.data as any).serverName = srv.name;
        const list = (this.serverSockets.get(srv.id) ?? []).filter((s) => s.connected && s.id !== client.id);
        if (list.length) {
          this.logger.warn(
            `agent ${srv.name}: ${list.length + 1} conexões simultâneas com a mesma API key (agent duplicado?)`,
          );
        }
        list.push(client);
        this.serverSockets.set(srv.id, list);
        this.touchDiag(srv.id, { connectedAt: new Date().toISOString(), authError: null });
        this.logger.log(`agent connected: ${srv.name} (${srv.id.slice(0, 8)})${attempt ? ` após ${attempt + 1} tentativas` : ''}`);
        return;
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (isAuthError(e)) {
          this.logger.warn(`control auth recusada (${ip}): ${msg}`);
          this.recordAuthErrorByPrefix(apiKey, msg);
          client.disconnect(true);
          return;
        }
        const delay = AUTH_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          this.logger.error(`control: validação falhou ${attempt + 1}x (${ip}): ${msg} — desistindo`);
          this.recordAuthErrorByPrefix(apiKey, `falha transitória persistente: ${msg}`);
          client.disconnect(true);
          return;
        }
        this.logger.warn(`control: validação transitória falhou (${ip}): ${msg} — nova tentativa em ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /** Guarda o erro de auth no diag do servidor dono da chave (se der pra descobrir pelo prefixo). */
  private recordAuthErrorByPrefix(apiKey: string, message: string) {
    this.servers.serverIdForKeyPrefix(apiKey.split('.')[0])
      .then((sid) => { if (sid) this.touchDiag(sid, { authError: message, authErrorAt: new Date().toISOString() }); })
      .catch(() => undefined);
  }

  handleDisconnect(_client: Socket) {
    // tratado em onSocketClosed (precisa do motivo da queda)
  }

  private onSocketClosed(client: Socket, reason: string) {
    const sid = (client.data as any).serverId as string | undefined;
    if (sid) {
      const list = (this.serverSockets.get(sid) ?? []).filter((s) => s.id !== client.id && s.connected);
      if (list.length) this.serverSockets.set(sid, list);
      else this.serverSockets.delete(sid);
      this.touchDiag(sid, { disconnectedAt: new Date().toISOString(), disconnectReason: String(reason) });
      this.logger.warn(`agent disconnected: ${(client.data as any).serverName ?? sid.slice(0, 8)} (${reason})`);
    }
    // Os vínculos de sessão desse socket NÃO são apagados aqui: pedidos seguintes da sessão
    // devem falhar ("o agent que abriu esta sessão desconectou") em vez de ir para outro socket.
    // Teto de memória: descarta vínculos de sockets já fechados quando o mapa cresce demais.
    if (this.sessionSocket.size > 5000) {
      for (const [sessId, sock] of this.sessionSocket) if (!sock.connected) this.sessionSocket.delete(sessId);
    }
    // Pedidos em voo nesse socket falham na hora (não ficam esperando o timeout).
    for (const [reqId, p] of this.pending) {
      if (p.socketId === client.id) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
        p.reject(new Error(`agent desconectou durante a operação ${p.op} (${reason})`));
      }
    }
  }

  private socketFor(serverId: string): Socket | undefined {
    const list = this.serverSockets.get(serverId) ?? [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].connected) return list[i];
    return undefined;
  }

  /** Envia op ao agent do server e aguarda reply (timeout default 30s). */
  invoke<T = any>(serverId: string, op: string, args: any = {}, opts?: { timeoutMs?: number }): Promise<T> {
    return this.send<T>(serverId, op, args, opts?.timeoutMs ?? 30_000);
  }

  /** Para chamadas com streaming (ex: pull com progresso). */
  invokeStream<T = any>(
    serverId: string, op: string, args: any, onChunk: (chunk: any) => void, timeoutMs = 120_000,
  ): Promise<T> {
    return this.send<T>(serverId, op, args, timeoutMs, onChunk);
  }

  private send<T>(serverId: string, op: string, args: any, timeoutMs: number, onChunk?: (c: any) => void): Promise<T> {
    const sessionId: string | undefined = SESSION_OPS_PREFIX.test(op) ? args?.sessionId : undefined;
    const pinned = sessionId && !SESSION_OPEN_OPS.has(op) ? this.sessionSocket.get(sessionId) : undefined;
    if (pinned && (!pinned.connected || (pinned.data as any)?.serverId !== serverId)) {
      return Promise.reject(new Error('o agent que abriu esta sessão desconectou'));
    }
    const sock = pinned ?? this.socketFor(serverId);
    if (!sock) {
      const d = this.diag.get(serverId);
      const why = d?.authError
        ? `: ${d.authError}`
        : d?.disconnectReason ? ` (última queda: ${d.disconnectReason})` : '';
      return Promise.reject(new Error(`agent offline${why}`));
    }
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`agent timeout after ${timeoutMs}ms (${op})`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer, socketId: sock.id, op, sessionId, ...(onChunk ? { streams: [onChunk] } : {}) });
      if (sessionId && SESSION_OPEN_OPS.has(op)) this.sessionSocket.set(sessionId, sock);
      sock.emit('docker:invoke', { reqId, op, args });
    });
  }

  /** Evento de sessão só vale se vier do socket que abriu a sessão. */
  private ownsSession(client: Socket, sessionId: string): boolean {
    const s = this.sessionSocket.get(sessionId);
    return !!s && s.id === client.id;
  }

  isOnline(serverId: string) {
    return !!this.socketFor(serverId);
  }

  status(serverId: string): AgentLinkDiag {
    const d = this.diag.get(serverId);
    return {
      online: this.isOnline(serverId),
      connections: (this.serverSockets.get(serverId) ?? []).filter((s) => s.connected).length,
      connectedAt: d?.connectedAt ?? null,
      disconnectedAt: d?.disconnectedAt ?? null,
      disconnectReason: d?.disconnectReason ?? null,
      authError: d?.authError ?? null,
      authErrorAt: d?.authErrorAt ?? null,
      lastReplyAt: d?.lastReplyAt ?? null,
    };
  }

  /** Resumo de todos os servidores com canal aberto (diagnóstico). */
  onlineServerIds(): string[] {
    return [...this.serverSockets.keys()].filter((id) => this.isOnline(id));
  }

  private authed(client: Socket): string | null {
    return ((client.data as any)?.serverId as string) ?? null;
  }

  @SubscribeMessage('docker:reply')
  onReply(
    @ConnectedSocket() client: Socket,
    @MessageBody() msg: { reqId: string; ok: boolean; result?: any; error?: string },
  ) {
    const sid = this.authed(client);
    const p = msg?.reqId ? this.pending.get(msg.reqId) : undefined;
    if (!sid || !p || p.socketId !== client.id) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.reqId);
    this.touchDiag(sid, { lastReplyAt: new Date().toISOString() });
    // capture.run / logscan.run só respondem quando a sessão termina: solta o vínculo.
    if (p.sessionId && (p.op === 'capture.run' || p.op === 'logscan.run')) this.sessionSocket.delete(p.sessionId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'agent error'));
  }

  @SubscribeMessage('docker:stream')
  onStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() msg: { reqId: string; data: any },
  ) {
    const p = msg?.reqId ? this.pending.get(msg.reqId) : undefined;
    if (!this.authed(client) || !p?.streams || p.socketId !== client.id) return;
    for (const cb of p.streams) cb(msg.data);
  }

  // ============ Terminal output forwarding (Zero Trust) ============
  private termOutputHandler?: (sessionId: string, b64: string) => void;
  private termClosedHandler?: (sessionId: string, reason: string) => void;
  private termCommandHandler?: (sessionId: string, command: string, ts?: string) => void;

  registerTerminalForwarders(
    onOutput: (sessionId: string, b64: string) => void,
    onClosed: (sessionId: string, reason: string) => void,
    onCommand?: (sessionId: string, command: string, ts?: string) => void,
  ) {
    this.termOutputHandler = onOutput;
    this.termClosedHandler = onClosed;
    this.termCommandHandler = onCommand;
  }

  @SubscribeMessage('term:command')
  onTermCommand(
    @ConnectedSocket() client: Socket,
    @MessageBody() msg: { sessionId: string; command: string; ts?: string },
  ) {
    if (!this.authed(client) || !this.ownsSession(client, msg?.sessionId)) return;
    this.termCommandHandler?.(msg.sessionId, msg.command, msg.ts);
  }

  @SubscribeMessage('term:output')
  onTermOutput(
    @ConnectedSocket() client: Socket,
    @MessageBody() msg: { sessionId: string; data: string },
  ) {
    if (!this.authed(client) || !this.ownsSession(client, msg?.sessionId)) return;
    this.termOutputHandler?.(msg.sessionId, msg.data);
  }

  @SubscribeMessage('term:closed')
  onTermClosed(
    @ConnectedSocket() client: Socket,
    @MessageBody() msg: { sessionId: string; reason: string },
  ) {
    if (!this.authed(client) || !this.ownsSession(client, msg?.sessionId)) return;
    this.sessionSocket.delete(msg.sessionId);
    this.termClosedHandler?.(msg.sessionId, msg.reason);
  }
}
