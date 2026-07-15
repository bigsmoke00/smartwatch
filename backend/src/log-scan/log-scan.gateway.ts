import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { RolesService } from '../roles/roles.service';

/**
 * Gateway de visualização EM TEMPO REAL de scans de log sob demanda (ex.:
 * busca por call UUID no unity.log do FreeSWITCH).
 *
 * Por pedido explícito do usuário: nada do conteúdo escaneado fica salvo no
 * backend, nem temporariamente em disco/banco. LogScanService.startScan()
 * dispara o agent via invokeStream/'logscan.run' e cada batch de linhas (ou o
 * resumo agregado, no modo listagem) chega aqui via forwardChunk() e é
 * repassado na hora pro(s) socket(s) que estiverem assistindo essa sessão.
 *
 * Diferente do CaptureGateway, aqui não existe uma tabela de sessões no
 * banco (o scan é 100% efêmero, sem fluxo de aprovação) — por isso a
 * autorização do socket é só "o usuário tem a permissão logs:read", a mesma
 * exigida pra disparar o scan via HTTP.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' },
  namespace: '/ws/logscan',
})
export class LogScanGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('LogScanGateway');
  @WebSocketServer() server!: Server;

  // sessionId -> sockets assistindo (normalmente só 1, mas nada impede mais
  // de uma aba/usuário acompanhando o mesmo scan).
  private uiSockets = new Map<string, Socket[]>();

  // Buffer de catch-up pequeno — só pra cobrir a corrida natural entre a
  // conexão do WS e o agent já começar a mandar batches. Não é replay: some
  // no forwardDone() e tem teto de itens (não de tempo/persistência).
  private chunkBuffers = new Map<string, any[]>();
  private static readonly MAX_BUFFER_CHUNKS = 500;

  constructor(
    private readonly jwt: JwtService,
    private readonly roles: RolesService,
  ) {}

  forwardChunk(sessionId: string, data: any) {
    const buf = this.chunkBuffers.get(sessionId) ?? [];
    if (buf.length < LogScanGateway.MAX_BUFFER_CHUNKS) {
      buf.push(data);
      this.chunkBuffers.set(sessionId, buf);
    }
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('chunk', data);
    }
  }

  forwardDone(sessionId: string, meta: { ok: boolean; filesScanned?: number; truncated?: boolean; mode?: string; matchCount?: number; callCount?: number; error?: string }) {
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('done', meta);
    }
    this.uiSockets.delete(sessionId);
    this.chunkBuffers.delete(sessionId);
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token;
      const sessionId = client.handshake.auth?.sessionId;
      if (!token || !sessionId) throw new Error('token + sessionId required');
      const payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET ?? 'dev-secret',
      });
      const perms = await this.roles.permissionsOf(payload.sub);
      if (!perms.has('logs:read')) throw new Error('sem permissão para acompanhar este scan');

      (client.data as any).sessionId = sessionId;
      const list = this.uiSockets.get(sessionId) ?? [];
      list.push(client);
      this.uiSockets.set(sessionId, list);

      client.emit('watching', {});
      // catch-up: repassa o que já foi emitido antes dessa conexão existir
      const buffered = this.chunkBuffers.get(sessionId) ?? [];
      for (const data of buffered) client.emit('chunk', data);
    } catch (e: any) {
      this.logger.warn(`logscan ws auth failed: ${e.message}`);
      client.emit('error', { message: e.message });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const sessionId = (client.data as any).sessionId as string | undefined;
    if (!sessionId) return;
    const list = this.uiSockets.get(sessionId);
    if (!list) return;
    const idx = list.indexOf(client);
    if (idx >= 0) list.splice(idx, 1);
    if (!list.length) this.uiSockets.delete(sessionId);
  }
}
