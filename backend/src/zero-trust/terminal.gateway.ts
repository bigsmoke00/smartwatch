import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

/**
 * Gateway WS para terminal web (xterm.js).
 *
 * Cliente conecta em /ws/terminal com JWT no auth + sessionId aprovado.
 * Backend valida sessão, abre stream no agent (via ControlGateway), e
 * faz proxy bidirecional. Cada chunk de I/O é gravado em terminal_session_events.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' },
  namespace: '/ws/terminal',
})
export class TerminalGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('TerminalGateway');
  @WebSocketServer() server!: Server;

  // sessionId → uiSocket
  private uiSockets = new Map<string, Socket>();

  constructor(
    private readonly jwt: JwtService,
    private readonly ctrl: ControlGateway,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {
    this.bindAgentOutputForwarding();
  }

  /** Recebe `term:output` do agent (via ControlGateway) e repassa para o uiSocket. */
  private bindAgentOutputForwarding() {
    // Hack: ControlGateway expõe acesso ao Server interno através do `server`
    // mas não temos handler direto p/ "term:output". Alternativa: o agent
    // emite no mesmo namespace control, então registramos via namespace adapter.
    // Para simplicidade, iremos plugar via ControlGateway no lifecycle do invoke.
    // (Ver onAgentTermOutput chamado pelo ControlGateway abaixo.)
  }

  /** API: backend chama para ouvir output do agent. */
  async forwardOutput(sessionId: string, base64Data: string) {
    const ui = this.uiSockets.get(sessionId);
    if (ui?.connected) ui.emit('output', base64Data);
    // grava no histórico
    await this.pool.query(
      `INSERT INTO terminal_session_events(session_id, direction, data) VALUES ($1,'output',$2)`,
      [sessionId, base64Data],
    ).catch(() => {});
  }

  async forwardClosed(sessionId: string, reason: string) {
    const ui = this.uiSockets.get(sessionId);
    if (ui?.connected) ui.emit('closed', { reason });
    await this.pool.query(
      `UPDATE terminal_sessions SET status='closed', closed_at=now()
       WHERE id=$1 AND status IN ('active','approved')`,
      [sessionId],
    ).catch(() => {});
  }

  async handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token;
      const sessionId = client.handshake.auth?.sessionId;
      if (!token || !sessionId) throw new Error('token + sessionId required');
      const payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_SECRET ?? 'dev-secret',
      });

      // Valida sessão: aprovada, não expirada, do próprio user
      const r = await this.pool.query(
        `SELECT * FROM terminal_sessions
         WHERE id=$1 AND requested_by=$2 AND status IN ('approved','active')
           AND (expires_at IS NULL OR expires_at > now())`,
        [sessionId, payload.sub],
      );
      if (!r.rowCount) throw new Error('session not approved or expired');
      const sess = r.rows[0];

      (client.data as any).user = payload;
      (client.data as any).sessionId = sessionId;
      this.uiSockets.set(sessionId, client);

      // Marca como ativa
      await this.pool.query(
        `UPDATE terminal_sessions SET status='active' WHERE id=$1`,
        [sessionId],
      );

      // Pede ao agent que abra o exec. O ControlGateway escutará as
      // mensagens term:output emitidas pelo agent (registradas no construtor).
      // Para o agent saber em qual container, sess.metadata pode trazer
      // containerId; para simplificar, esperamos que UI já ofereça a escolha.
      const containerId = client.handshake.auth?.containerId as string | undefined;
      const target = (client.handshake.auth?.target as string) ?? (containerId ? 'container' : 'host');
      const readonly = client.handshake.auth?.readonly === true || client.handshake.auth?.readonly === 'true';
      const sudo = client.handshake.auth?.sudo === true || client.handshake.auth?.sudo === 'true';

      if (target === 'container' && !containerId) {
        client.emit('error', { message: 'containerId required for target=container' });
        client.disconnect(true);
        return;
      }

      try {
        await this.ctrl.invoke(sess.server_id, 'term.start', {
          sessionId, target, containerId,
          command: sess.command, shell: sess.command,
          readonly, sudo,
          cols: 100, rows: 30,
        }, { timeoutMs: 10_000 });
        client.emit('ready', { sessionId, target });
      } catch (e: any) {
        client.emit('error', { message: e.message });
        client.disconnect(true);
      }
    } catch (e: any) {
      this.logger.warn(`term auth failed: ${e.message}`);
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const sessionId = (client.data as any).sessionId;
    if (sessionId) {
      this.uiSockets.delete(sessionId);
      // sinaliza ao agent
      const r = await this.pool.query(`SELECT server_id FROM terminal_sessions WHERE id=$1`, [sessionId]);
      const serverId = r.rows[0]?.server_id;
      if (serverId) {
        this.ctrl.invoke(serverId, 'term.close', { sessionId }).catch(() => {});
      }
      await this.pool.query(
        `UPDATE terminal_sessions SET status='closed', closed_at=now()
         WHERE id=$1 AND status IN ('active','approved')`,
        [sessionId],
      ).catch(() => {});
    }
  }

  @SubscribeMessage('resize')
  async onResize(@ConnectedSocket() client: Socket, @MessageBody() data: { cols: number; rows: number }) {
    const sessionId = (client.data as any).sessionId;
    if (!sessionId) return;
    const r = await this.pool.query(`SELECT server_id FROM terminal_sessions WHERE id=$1`, [sessionId]);
    const serverId = r.rows[0]?.server_id;
    if (!serverId) return;
    this.ctrl.invoke(serverId, 'term.resize', { sessionId, cols: data.cols, rows: data.rows }).catch(() => {});
  }

  @SubscribeMessage('input')
  async onInput(@ConnectedSocket() client: Socket, @MessageBody() data: string) {
    const sessionId = (client.data as any).sessionId;
    if (!sessionId) return;
    const r = await this.pool.query(`SELECT server_id FROM terminal_sessions WHERE id=$1`, [sessionId]);
    const serverId = r.rows[0]?.server_id;
    if (!serverId) return;
    // Grava input
    await this.pool.query(
      `INSERT INTO terminal_session_events(session_id, direction, data) VALUES ($1,'input',$2)`,
      [sessionId, data],
    ).catch(() => {});
    this.ctrl.invoke(serverId, 'term.input', { sessionId, data }).catch(() => {});
  }
}
