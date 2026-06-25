import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { RolesService } from '../roles/roles.service';

/**
 * Gateway de visualização EM TEMPO REAL de capturas de rede/SIP.
 *
 * Por pedido explícito do usuário: nada do .pcap fica salvo no backend, nem
 * temporariamente. O cliente conecta aqui com token+sessionId, e enquanto a
 * captura estiver rodando (CaptureService.approve() chamando
 * invokeStream/'capture.run' no agent), cada chunk chega aqui via
 * forwardChunk() e é repassado na hora pro(s) socket(s) que estiverem
 * assistindo essa sessão. Quem assembla o arquivo final e oferece "salvar"
 * é o navegador (Blob), nunca o servidor.
 *
 * Consequência directa do design: se ninguém estiver conectado aqui no
 * momento em que a captura rodar, o conteúdo se perde — não tem replay.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' },
  namespace: '/ws/captures',
})
export class CaptureGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('CaptureGateway');
  @WebSocketServer() server!: Server;

  // sessionId -> sockets assistindo (pode ter mais de um: solicitante + aprovador, por exemplo)
  private uiSockets = new Map<string, Socket[]>();

  constructor(
    private readonly jwt: JwtService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly roles: RolesService,
  ) {}

  forwardChunk(sessionId: string, b64: string) {
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('chunk', b64);
    }
  }

  forwardDone(sessionId: string, meta: { ok: boolean; packetCount?: number; fileSizeBytes?: number; resultText?: string; error?: string }) {
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('done', meta);
    }
    this.uiSockets.delete(sessionId);
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token;
      const sessionId = client.handshake.auth?.sessionId;
      if (!token || !sessionId) throw new Error('token + sessionId required');
      const payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET ?? 'dev-secret',
      });

      const r = await this.pool.query(`SELECT * FROM capture_sessions WHERE id=$1`, [sessionId]);
      if (!r.rowCount) throw new Error('sessão de captura não encontrada');
      const sess = r.rows[0];

      const perms = await this.roles.permissionsOf(payload.sub);
      const canWatch = sess.requested_by === payload.sub || perms.has('capture:approve');
      if (!canWatch) throw new Error('sem permissão para acompanhar esta sessão');

      (client.data as any).sessionId = sessionId;
      const list = this.uiSockets.get(sessionId) ?? [];
      list.push(client);
      this.uiSockets.set(sessionId, list);

      if (['completed', 'failed', 'rejected', 'expired'].includes(sess.status)) {
        client.emit('info', {
          message: 'esta sessão já terminou — a captura é só em tempo real, não fica salva no servidor',
          status: sess.status,
        });
      } else {
        client.emit('watching', { status: sess.status, kind: sess.kind });
      }
    } catch (e: any) {
      this.logger.warn(`captures ws auth failed: ${e.message}`);
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
