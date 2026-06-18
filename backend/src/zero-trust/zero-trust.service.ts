import {
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';
import { TerminalGateway } from './terminal.gateway';

@Injectable()
export class ZeroTrustService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
    private readonly term: TerminalGateway,
  ) {}

  /** Conecta TerminalGateway ↔ ControlGateway (forwarding de output). */
  onModuleInit() {
    this.ctrl.registerTerminalForwarders(
      (sid, b64) => this.term.forwardOutput(sid, b64),
      (sid, reason) => this.term.forwardClosed(sid, reason),
    );
  }

  // ---------- Sessões de terminal ----------
  async listSessions(filter: { mine?: boolean; userId?: string; pending?: boolean } = {}) {
    const where: string[] = [];
    const params: any[] = [];
    let i = 1;
    if (filter.mine && filter.userId) { where.push(`requested_by=$${i++}`); params.push(filter.userId); }
    if (filter.pending) where.push(`status='pending'`);
    const r = await this.pool.query(
      `SELECT s.id, s.server_id AS "serverId", s.requested_by AS "requestedBy",
              s.approved_by AS "approvedBy", s.reason, s.status, s.ttl_minutes AS "ttlMinutes",
              s.command, s.expires_at AS "expiresAt", s.closed_at AS "closedAt",
              s.created_at AS "createdAt",
              u1.email AS "requestedByEmail", u2.email AS "approvedByEmail",
              srv.name AS "serverName"
       FROM terminal_sessions s
       LEFT JOIN users u1 ON u1.id = s.requested_by
       LEFT JOIN users u2 ON u2.id = s.approved_by
       LEFT JOIN servers srv ON srv.id = s.server_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.created_at DESC LIMIT 100`,
      params,
    );
    return r.rows;
  }

  async requestSession(input: {
    serverId: string; requestedBy: string; reason: string;
    ttlMinutes?: number; command?: string;
  }) {
    const r = await this.pool.query(
      `INSERT INTO terminal_sessions(server_id, requested_by, reason, ttl_minutes, command)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, status`,
      [input.serverId, input.requestedBy, input.reason, input.ttlMinutes ?? 30, input.command ?? '/bin/sh'],
    );
    return r.rows[0];
  }

  async approve(sessionId: string, approverId: string) {
    const r = await this.pool.query(
      `UPDATE terminal_sessions
         SET status='approved', approved_by=$2,
             expires_at = now() + (ttl_minutes || ' minutes')::interval
       WHERE id=$1 AND status='pending' RETURNING id`,
      [sessionId, approverId],
    );
    if (!r.rowCount) throw new NotFoundException('session not pending');
    return { ok: true };
  }

  async reject(sessionId: string, approverId: string) {
    await this.pool.query(
      `UPDATE terminal_sessions SET status='rejected', approved_by=$2 WHERE id=$1 AND status='pending'`,
      [sessionId, approverId],
    );
    return { ok: true };
  }

  async sessionRecording(sessionId: string) {
    const r = await this.pool.query(
      `SELECT ts, direction, data
       FROM terminal_session_events WHERE session_id=$1
       ORDER BY ts ASC LIMIT 100000`,
      [sessionId],
    );
    return r.rows;
  }

}
