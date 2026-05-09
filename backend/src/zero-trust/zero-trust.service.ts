import {
  Inject,
  Injectable,
  NotFoundException,
  ForbiddenException,
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

  // ---------- Runbooks ----------
  async listRunbooks() {
    const r = await this.pool.query(
      `SELECT id, name, description, category, command_template AS "commandTemplate",
              variables, allowed_envs AS "allowedEnvs", allowed_tags AS "allowedTags",
              approver_required AS "approverRequired", created_at AS "createdAt"
       FROM runbooks ORDER BY name`,
    );
    return r.rows;
  }

  async createRunbook(rb: any) {
    const r = await this.pool.query(
      `INSERT INTO runbooks(name, description, category, command_template, variables,
                            allowed_envs, allowed_tags, approver_required, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) RETURNING id`,
      [
        rb.name, rb.description ?? null, rb.category ?? null,
        rb.commandTemplate, JSON.stringify(rb.variables ?? []),
        rb.allowedEnvs ?? ['staging','development','sandbox'],
        rb.allowedTags ?? [],
        !!rb.approverRequired, rb.createdBy ?? null,
      ],
    );
    return r.rows[0];
  }

  async deleteRunbook(id: string) {
    await this.pool.query(`DELETE FROM runbooks WHERE id=$1`, [id]);
    return { ok: true };
  }

  async executeRunbook(input: {
    runbookId: string; serverId: string; vars: Record<string, string>; userId: string;
  }) {
    const rb = (await this.pool.query(`SELECT * FROM runbooks WHERE id=$1`, [input.runbookId])).rows[0];
    if (!rb) throw new NotFoundException('runbook not found');
    const srv = (await this.pool.query(`SELECT * FROM servers WHERE id=$1`, [input.serverId])).rows[0];
    if (!srv) throw new NotFoundException('server not found');

    if (!rb.allowed_envs.includes(srv.environment)) {
      throw new ForbiddenException(`runbook não permite env ${srv.environment}`);
    }

    // Resolve variáveis no template
    const cmd = (rb.command_template as string).replace(/\{\{(\w+)\}\}/g, (_, k) => {
      const v = input.vars?.[k] ?? '';
      // shell-escape simples (single-quote)
      return `'${String(v).replace(/'/g, `'\\''`)}'`;
    });

    // Executa via fs-ops (sh -c). Para forçar uso do shell, chamamos /bin/sh no agent
    // via op host.shellExec? Aqui reaproveitamos fs.execute apontando pra /bin/sh
    // — mas isso exige /bin/sh estar em ALLOWED_PATHS. Alternativa: criamos op
    // específica term.run. Para simplicidade, usamos /bin/sh -c diretamente via
    // executeScript com path = /bin/sh + args = ['-c', cmd].
    const t0 = Date.now();
    let result: any;
    try {
      result = await this.ctrl.invoke(input.serverId, 'fs.execute', {
        path: '/bin/sh', args: ['-c', cmd], timeoutMs: 120_000,
      }, { timeoutMs: 130_000 });
    } catch (e: any) {
      result = { exitCode: -1, stdout: '', stderr: e.message, durationMs: Date.now() - t0 };
    }

    await this.pool.query(
      `INSERT INTO runbook_executions(runbook_id, server_id, executed_by, vars, resolved_command,
                                      exit_code, stdout, stderr, duration_ms)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)`,
      [
        input.runbookId, input.serverId, input.userId, JSON.stringify(input.vars ?? {}),
        cmd, result.exitCode,
        (result.stdout ?? '').slice(0, 200_000),
        (result.stderr ?? '').slice(0, 200_000),
        result.durationMs,
      ],
    );
    return result;
  }

  async listRunbookExecutions(runbookId?: string) {
    const sql = runbookId
      ? `SELECT * FROM runbook_executions WHERE runbook_id=$1 ORDER BY ts DESC LIMIT 100`
      : `SELECT * FROM runbook_executions ORDER BY ts DESC LIMIT 100`;
    const r = await this.pool.query(sql, runbookId ? [runbookId] : []);
    return r.rows;
  }

  // ---------- Bastion (registro de SSH) ----------
  async logBastionSession(s: {
    userId?: string; userEmail?: string; sourceIp?: string;
    targetHost: string; targetUser: string; targetPort?: number;
    durationSec?: number; bytesIn?: number; bytesOut?: number;
  }) {
    const r = await this.pool.query(
      `INSERT INTO bastion_sessions(user_id, user_email, source_ip, target_host,
                                    target_user, target_port, duration_sec,
                                    bytes_in, bytes_out, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now()) RETURNING id`,
      [
        s.userId ?? null, s.userEmail ?? null, s.sourceIp ?? null,
        s.targetHost, s.targetUser, s.targetPort ?? 22,
        s.durationSec ?? null, s.bytesIn ?? null, s.bytesOut ?? null,
      ],
    );
    return r.rows[0];
  }

  async listBastionSessions(filter: { userId?: string; targetHost?: string; days?: number } = {}) {
    const where: string[] = [`ts >= now() - ($1 || ' days')::interval`];
    const params: any[] = [filter.days ?? 30];
    let i = 2;
    if (filter.userId) { where.push(`user_id=$${i++}`); params.push(filter.userId); }
    if (filter.targetHost) { where.push(`target_host=$${i++}`); params.push(filter.targetHost); }
    const r = await this.pool.query(
      `SELECT * FROM bastion_sessions WHERE ${where.join(' AND ')}
       ORDER BY ts DESC LIMIT 200`,
      params,
    );
    return r.rows;
  }
}
