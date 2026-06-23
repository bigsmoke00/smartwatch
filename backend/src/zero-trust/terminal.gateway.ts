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
 *
 * IMPORTANTE (correção de segurança): target/modo/sudo/usuário do SO NUNCA
 * são lidos do payload de auth do cliente — vêm sempre da linha já
 * persistida em `terminal_sessions` (decidida em requestSession()/approve(),
 * com checagem contra `user_server_logins`). O cliente só manda token +
 * sessionId; tudo o resto seria uma forma trivial de escalar privilégio
 * (bastava abrir o DevTools e mandar sudo:true).
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
  ) {}

  /** API: backend chama para ouvir output do agent. */
  async forwardOutput(sessionId: string, base64Data: string) {
    const ui = this.uiSockets.get(sessionId);
    if (ui?.connected) ui.emit('output', base64Data);
    await this.pool.query(
      `INSERT INTO terminal_session_events(session_id, direction, data) VALUES ($1,'output',$2)`,
      [sessionId, base64Data],
    ).catch(() => {});
  }

  /** Comando capturado pelo agent via HISTFILE — log legível, separado do dump bruto. */
  async recordCommand(sessionId: string, command: string, ts?: string) {
    const trimmed = command.trim();
    if (!trimmed) return;
    await this.pool.query(
      `INSERT INTO terminal_session_commands(session_id, command, ts) VALUES ($1,$2, COALESCE($3::timestamptz, clock_timestamp()))`,
      [sessionId, trimmed, ts ?? null],
    ).catch((e) => this.logger.warn(`recordCommand ${sessionId}: ${e.message}`));
    await this.touchActivity(sessionId);
  }

  async forwardClosed(sessionId: string, reason: string) {
    const ui = this.uiSockets.get(sessionId);
    if (ui?.connected) ui.emit('closed', { reason });
    this.uiSockets.delete(sessionId);
    await this.pool.query(
      `UPDATE terminal_sessions SET status='closed', closed_at=now(), closed_reason=COALESCE(closed_reason,$2)
       WHERE id=$1 AND status IN ('active','approved')`,
      [sessionId, reason],
    ).catch(() => {});
  }

  /** Chamado pelo ZeroTrustService (TTL/idle cron, ou fechamento manual). */
  forceClose(sessionId: string, reason: string) {
    const ui = this.uiSockets.get(sessionId);
    if (ui?.connected) {
      ui.emit('closed', { reason });
      ui.disconnect(true);
    }
    this.uiSockets.delete(sessionId);
  }

  private async touchActivity(sessionId: string) {
    await this.pool.query(
      `UPDATE terminal_sessions SET last_activity_at=now() WHERE id=$1`,
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

      // Valida sessão: aprovada, não expirada, do próprio user. Tudo que
      // importa pra decidir COMO o shell roda vem dessa linha — nunca do
      // payload mandado pelo cliente no handshake.
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

      await this.pool.query(
        `UPDATE terminal_sessions SET status='active', last_activity_at=now() WHERE id=$1`,
        [sessionId],
      );

      if (sess.target === 'container' && !sess.container_id) {
        client.emit('error', { message: 'containerId required for target=container' });
        client.disconnect(true);
        return;
      }

      try {
        await this.ctrl.invoke(sess.server_id, 'term.start', {
          sessionId,
          target: sess.target,
          containerId: sess.container_id,
          command: sess.command,
          shell: sess.command,
          readonly: sess.mode === 'readonly',
          sudo: !!sess.sudo_granted,
          targetUser: sess.target_user,
          cols: 100, rows: 30,
        }, { timeoutMs: 10_000 });
        client.emit('ready', {
          sessionId, target: sess.target,
          targetUser: sess.target_user, mode: sess.mode,
          sudoGranted: sess.sudo_granted, expiresAt: sess.expires_at,
        });
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
      const r = await this.pool.query(`SELECT server_id FROM terminal_sessions WHERE id=$1`, [sessionId]);
      const serverId = r.rows[0]?.server_id;
      if (serverId) {
        this.ctrl.invoke(serverId, 'term.close', { sessionId }).catch(() => {});
      }
      await this.pool.query(
        `UPDATE terminal_sessions SET status='closed', closed_at=now(), closed_reason=COALESCE(closed_reason,'desconectado')
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
    await this.pool.query(
      `INSERT INTO terminal_session_events(session_id, direction, data) VALUES ($1,'input',$2)`,
      [sessionId, data],
    ).catch(() => {});
    await this.touchActivity(sessionId);
    this.ctrl.invoke(serverId, 'term.input', { sessionId, data }).catch(() => {});
  }
}
