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

  // sessionId -> chunks já emitidos NESTA captura em andamento, só em memória,
  // só pra dar "catch-up" pra quem conectar depois do primeiro byte (ex.:
  // aprovador que ainda não tinha clicado "assistir" quando aprovou, ou o
  // solicitante abrindo a tela um instante depois). Sem isso, quem entra
  // atrasado perde o cabeçalho global do .pcap e o arquivo final fica
  // corrompido/incompatível com Wireshark. É descartado no forwardDone() —
  // não é persistência, só compensa a corrida natural de uma conexão
  // WebSocket vs. o agent já começar a mandar bytes.
  private chunkBuffers = new Map<string, string[]>();
  private chunkBufferBytes = new Map<string, number>();
  private static readonly MAX_BUFFER_BYTES = 64 * 1024 * 1024; // folga sobre o limite de 50MB do agent

  constructor(
    private readonly jwt: JwtService,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly roles: RolesService,
  ) {}

  forwardChunk(sessionId: string, b64: string) {
    const buf = this.chunkBuffers.get(sessionId) ?? [];
    const usedBytes = this.chunkBufferBytes.get(sessionId) ?? 0;
    if (usedBytes < CaptureGateway.MAX_BUFFER_BYTES) {
      buf.push(b64);
      this.chunkBuffers.set(sessionId, buf);
      this.chunkBufferBytes.set(sessionId, usedBytes + b64.length);
    }
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('chunk', b64);
    }
  }

  forwardDone(sessionId: string, meta: { ok: boolean; packetCount?: number; fileSizeBytes?: number; resultText?: string; error?: string }) {
    for (const s of this.uiSockets.get(sessionId) ?? []) {
      if (s.connected) s.emit('done', meta);
    }
    this.uiSockets.delete(sessionId);
    this.chunkBuffers.delete(sessionId);
    this.chunkBufferBytes.delete(sessionId);
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
        // catch-up: se a captura já estava rodando antes dessa conexão,
        // repassa o que já foi emitido (inclui o cabeçalho global do pcap)
        // pra esse cliente não ficar com um arquivo incompleto/inválido.
        const buffered = this.chunkBuffers.get(sessionId) ?? [];
        for (const b64 of buffered) client.emit('chunk', b64);
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
