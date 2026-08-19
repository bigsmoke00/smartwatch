import { requireSecret } from '../common/env-secret';
import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { LogDoc } from './logs.repository';

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN?.split(',') ?? '*' },
  namespace: '/ws/logs',
})
export class LogsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger('LogsGateway');
  @WebSocketServer() server!: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ||
        (client.handshake.headers.authorization || '').replace('Bearer ', '');
      if (!token) throw new Error('No token');
      const payload = await this.jwt.verifyAsync(token, {
        secret: requireSecret('JWT_SECRET'),
      });
      (client.data as any).user = payload;
    } catch {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {}

  @SubscribeMessage('subscribe')
  subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { serverId?: string },
  ) {
    const room = data.serverId ? `server:${data.serverId}` : 'server:all';
    for (const r of client.rooms) {
      if (r !== client.id && r.startsWith('server:')) client.leave(r);
    }
    client.join(room);
    return { ok: true, room };
  }

  emitBatch(docs: LogDoc[]) {
    if (!docs.length) return;
    const byServer = new Map<string, LogDoc[]>();
    for (const d of docs) {
      const arr = byServer.get(d.serverId) ?? [];
      arr.push(d);
      byServer.set(d.serverId, arr);
    }
    for (const [serverId, arr] of byServer) {
      this.server.to(`server:${serverId}`).emit('logs', arr);
    }
    this.server.to('server:all').emit('logs', docs);
  }
}
