import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { ServersService } from '../servers/servers.service';

interface PendingReq {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
  streams?: Array<(data: any) => void>;
}

/**
 * Gateway que mantém o canal de controle agent ↔ backend.
 *
 * O agent autentica via API key na handshake (auth.apiKey). Cada agent fica
 * registrado em `serverSockets` por `serverId`. Endpoints REST do
 * docker-manager invocam `invoke(serverId, op, args)` que envia uma mensagem
 * ao agent e aguarda a resposta correlacionada por `reqId`.
 */
@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/ws/control',
})
export class ControlGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('ControlGateway');
  @WebSocketServer() server!: Server;

  private serverSockets = new Map<string, Socket>();
  private pending = new Map<string, PendingReq>();

  constructor(private readonly servers: ServersService) {}

  async handleConnection(client: Socket) {
    try {
      const apiKey = client.handshake.auth?.apiKey as string | undefined;
      if (!apiKey) throw new Error('apiKey required');
      // IP do remetente (atrás de proxy precisa de trustProxy etc)
      const ip = (client.handshake.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || client.handshake.address;
      const srv = await this.servers.validateApiKey(apiKey, ip);
      (client.data as any).serverId = srv.id;
      this.serverSockets.set(srv.id, client);
      this.logger.log(`agent connected: ${srv.name} (${srv.id.slice(0, 8)})`);
    } catch (e: any) {
      this.logger.warn(`control auth failed: ${e.message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const sid = (client.data as any).serverId as string | undefined;
    if (sid && this.serverSockets.get(sid) === client) {
      this.serverSockets.delete(sid);
    }
  }

  /** Envia op ao agent do server e aguarda reply (timeout default 30s). */
  invoke<T = any>(serverId: string, op: string, args: any = {}, opts?: { timeoutMs?: number }): Promise<T> {
    const sock = this.serverSockets.get(serverId);
    if (!sock || !sock.connected) {
      return Promise.reject(new Error('agent offline'));
    }
    const reqId = randomUUID();
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`agent timeout after ${timeoutMs}ms (${op})`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      sock.emit('docker:invoke', { reqId, op, args });
    });
  }

  /** Para chamadas com streaming (ex: pull com progresso). */
  invokeStream<T = any>(
    serverId: string,
    op: string,
    args: any,
    onChunk: (chunk: any) => void,
    timeoutMs = 120_000,
  ): Promise<T> {
    const sock = this.serverSockets.get(serverId);
    if (!sock || !sock.connected) return Promise.reject(new Error('agent offline'));
    const reqId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`agent timeout after ${timeoutMs}ms (${op})`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve,
        reject,
        timer,
        streams: [onChunk],
      });
      sock.emit('docker:invoke', { reqId, op, args });
    });
  }

  isOnline(serverId: string) {
    return !!this.serverSockets.get(serverId)?.connected;
  }

  @SubscribeMessage('docker:reply')
  onReply(
    @ConnectedSocket() _client: Socket,
    @MessageBody() msg: { reqId: string; ok: boolean; result?: any; error?: string },
  ) {
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.reqId);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || 'agent error'));
  }

  @SubscribeMessage('docker:stream')
  onStream(
    @ConnectedSocket() _client: Socket,
    @MessageBody() msg: { reqId: string; data: any },
  ) {
    const p = this.pending.get(msg.reqId);
    if (!p?.streams) return;
    for (const cb of p.streams) cb(msg.data);
  }

  // ============ Terminal output forwarding (Zero Trust) ============
  // O TerminalGateway se registra aqui pra receber output do agent.
  private termOutputHandler?: (sessionId: string, b64: string) => void;
  private termClosedHandler?: (sessionId: string, reason: string) => void;

  registerTerminalForwarders(
    onOutput: (sessionId: string, b64: string) => void,
    onClosed: (sessionId: string, reason: string) => void,
  ) {
    this.termOutputHandler = onOutput;
    this.termClosedHandler = onClosed;
  }

  @SubscribeMessage('term:output')
  onTermOutput(
    @ConnectedSocket() _client: Socket,
    @MessageBody() msg: { sessionId: string; data: string },
  ) {
    this.termOutputHandler?.(msg.sessionId, msg.data);
  }

  @SubscribeMessage('term:closed')
  onTermClosed(
    @ConnectedSocket() _client: Socket,
    @MessageBody() msg: { sessionId: string; reason: string },
  ) {
    this.termClosedHandler?.(msg.sessionId, msg.reason);
  }
}
