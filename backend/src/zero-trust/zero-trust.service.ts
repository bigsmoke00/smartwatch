import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';
import { TerminalGateway } from './terminal.gateway';

interface OsLoginResolution {
  osUsername: string;
  allowSudo: boolean;
  allowReadwrite: boolean;
  source: 'mapping' | 'mapping_default' | 'fallback_email';
}

@Injectable()
export class ZeroTrustService implements OnModuleInit {
  private readonly logger = new Logger('ZeroTrustService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
    private readonly term: TerminalGateway,
  ) {}

  /** Conecta TerminalGateway ↔ ControlGateway (forwarding de output/comandos). */
  onModuleInit() {
    this.ctrl.registerTerminalForwarders(
      (sid, b64) => this.term.forwardOutput(sid, b64),
      (sid, reason) => this.handleAgentClosed(sid, reason),
      (sid, command, ts) => this.term.recordCommand(sid, command, ts),
    );
  }

  private async handleAgentClosed(sessionId: string, reason: string) {
    this.term.forwardClosed(sessionId, reason);
    await this.generateTranscript(sessionId, reason).catch((e) =>
      this.logger.warn(`transcript (closed) ${sessionId}: ${e.message}`),
    );
  }

  // ---------- Mapeamento usuário da plataforma → usuário do SO ----------

  /**
   * Resolve qual usuário do SO a pessoa deve usar num servidor:
   *   1) mapeamento específico pra esse user_id + server_id
   *   2) mapeamento "default" do user_id (server_id IS NULL)
   *   3) fallback: tudo antes do @ no email (comportamento "de hoje")
   */
  async resolveOsLogin(userId: string, serverId: string, email: string): Promise<OsLoginResolution> {
    const r = await this.pool.query(
      `SELECT os_username, allow_sudo, allow_readwrite, server_id
       FROM user_server_logins
       WHERE user_id=$1 AND (server_id=$2 OR server_id IS NULL)
       ORDER BY server_id IS NULL ASC
       LIMIT 1`,
      [userId, serverId],
    );
    if (r.rowCount) {
      const row = r.rows[0];
      return {
        osUsername: row.os_username,
        allowSudo: row.allow_sudo,
        allowReadwrite: row.allow_readwrite,
        source: row.server_id ? 'mapping' : 'mapping_default',
      };
    }
    return {
      osUsername: email.split('@')[0],
      allowSudo: false,
      allowReadwrite: true,
      source: 'fallback_email',
    };
  }

  async resolveForCurrentUser(userId: string, serverId: string) {
    const u = await this.pool.query(`SELECT email FROM users WHERE id=$1`, [userId]);
    if (!u.rowCount) throw new NotFoundException('user not found');
    return this.resolveOsLogin(userId, serverId, u.rows[0].email);
  }

  async listLogins(userId?: string) {
    const r = await this.pool.query(
      `SELECT l.id, l.user_id AS "userId", l.server_id AS "serverId", l.os_username AS "osUsername",
              l.allow_sudo AS "allowSudo", l.allow_readwrite AS "allowReadwrite",
              l.created_at AS "createdAt", l.updated_at AS "updatedAt",
              u.email AS "userEmail", srv.name AS "serverName"
       FROM user_server_logins l
       JOIN users u ON u.id = l.user_id
       LEFT JOIN servers srv ON srv.id = l.server_id
       ${userId ? 'WHERE l.user_id=$1' : ''}
       ORDER BY u.email ASC, srv.name ASC NULLS FIRST`,
      userId ? [userId] : [],
    );
    return r.rows;
  }

  async upsertLogin(input: {
    userId: string; serverId?: string | null; osUsername: string;
    allowSudo?: boolean; allowReadwrite?: boolean; createdBy: string;
  }) {
    // POSIX permite ponto em login name (ex: geraldo.cruz) — regex de useradd
    // de várias distros aceita [a-z_][a-z0-9_.-]*[$]?, então liberamos ponto também.
    if (!/^[a-z_][a-z0-9._-]{0,31}$/.test(input.osUsername)) {
      throw new BadRequestException('usuário do SO inválido (use letras minúsculas, números, ".", "_" e "-")');
    }
    const r = await this.pool.query(
      `INSERT INTO user_server_logins(user_id, server_id, os_username, allow_sudo, allow_readwrite, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, server_id) DO UPDATE SET
         os_username=EXCLUDED.os_username, allow_sudo=EXCLUDED.allow_sudo,
         allow_readwrite=EXCLUDED.allow_readwrite, updated_at=now()
       RETURNING id`,
      [input.userId, input.serverId ?? null, input.osUsername,
       input.allowSudo ?? false, input.allowReadwrite ?? true, input.createdBy],
    );
    return r.rows[0];
  }

  async deleteLogin(id: string) {
    await this.pool.query(`DELETE FROM user_server_logins WHERE id=$1`, [id]);
    return { ok: true };
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
              s.idle_timeout_minutes AS "idleTimeoutMinutes",
              s.command, s.target, s.container_id AS "containerId", s.mode,
              s.sudo_requested AS "sudoRequested", s.sudo_granted AS "sudoGranted",
              s.target_user AS "targetUser",
              s.expires_at AS "expiresAt", s.closed_at AS "closedAt",
              s.last_activity_at AS "lastActivityAt", s.closed_reason AS "closedReason",
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
    ttlMinutes?: number; idleTimeoutMinutes?: number; command?: string;
    target?: 'host' | 'container'; containerId?: string;
    mode?: 'readonly' | 'readwrite'; sudoRequested?: boolean;
  }) {
    const u = await this.pool.query(`SELECT email FROM users WHERE id=$1`, [input.requestedBy]);
    if (!u.rowCount) throw new NotFoundException('user not found');
    const login = await this.resolveOsLogin(input.requestedBy, input.serverId, u.rows[0].email);

    const target = input.target === 'container' ? 'container' : 'host';
    if (target === 'container' && !input.containerId) {
      throw new BadRequestException('containerId obrigatório para target=container');
    }
    let mode: 'readonly' | 'readwrite' = input.mode === 'readonly' ? 'readonly' : 'readwrite';
    // Mapeamento pode restringir a pessoa a só-leitura nesse servidor mesmo
    // que ela peça leitura/escrita — não confiamos só na escolha do form.
    if (mode === 'readwrite' && !login.allowReadwrite) mode = 'readonly';
    // sudo nunca faz sentido junto com readonly.
    const sudoRequested = mode === 'readwrite' && !!input.sudoRequested;

    const r = await this.pool.query(
      `INSERT INTO terminal_sessions(
         server_id, requested_by, reason, ttl_minutes, idle_timeout_minutes, command,
         target, container_id, mode, sudo_requested, target_user
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, status`,
      [
        input.serverId, input.requestedBy, input.reason, input.ttlMinutes ?? 30,
        input.idleTimeoutMinutes ?? 15, input.command ?? '/bin/bash',
        target, target === 'container' ? input.containerId : null,
        mode, sudoRequested, login.osUsername,
      ],
    );
    return r.rows[0];
  }

  async approve(sessionId: string, approverId: string) {
    const s = await this.pool.query(
      `SELECT requested_by, server_id, mode, sudo_requested FROM terminal_sessions
       WHERE id=$1 AND status='pending'`,
      [sessionId],
    );
    if (!s.rowCount) throw new NotFoundException('session not pending');
    const sess = s.rows[0];

    // Reavalia o grant de sudo na hora da aprovação (não na hora do pedido) —
    // assim uma mudança no mapeamento entre o request e o approve já vale.
    let sudoGranted = false;
    if (sess.sudo_requested && sess.mode === 'readwrite') {
      const u = await this.pool.query(`SELECT email FROM users WHERE id=$1`, [sess.requested_by]);
      const login = await this.resolveOsLogin(sess.requested_by, sess.server_id, u.rows[0]?.email ?? '');
      sudoGranted = login.allowSudo;
    }

    const r = await this.pool.query(
      `UPDATE terminal_sessions
         SET status='approved', approved_by=$2, sudo_granted=$3,
             expires_at = now() + (ttl_minutes || ' minutes')::interval
       WHERE id=$1 AND status='pending' RETURNING id`,
      [sessionId, approverId, sudoGranted],
    );
    if (!r.rowCount) throw new NotFoundException('session not pending');
    return { ok: true, sudoGranted };
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

  async listCommands(sessionId: string) {
    const r = await this.pool.query(
      `SELECT ts, command FROM terminal_session_commands
       WHERE session_id=$1 ORDER BY ts ASC LIMIT 5000`,
      [sessionId],
    );
    return r.rows;
  }

  /**
   * Gera (ou retorna já gerado) o "arquivo de fácil visualização" da sessão:
   * cabeçalho com quem/onde/como + lista cronológica de comandos executados.
   * Texto puro, pensado pra abrir/baixar direto, sem precisar decodificar nada.
   */
  async getTranscript(sessionId: string): Promise<string> {
    const r = await this.pool.query(`SELECT transcript, status FROM terminal_sessions WHERE id=$1`, [sessionId]);
    if (!r.rowCount) throw new NotFoundException('session not found');
    if (r.rows[0].transcript) return r.rows[0].transcript;
    if (r.rows[0].status === 'active') return this.generateTranscript(sessionId, null, false);
    return this.generateTranscript(sessionId, r.rows[0].status, true);
  }

  async generateTranscript(sessionId: string, closeReason: string | null, persist = true): Promise<string> {
    const s = await this.pool.query(
      `SELECT s.*, u1.email AS requested_by_email, u2.email AS approved_by_email, srv.name AS server_name
       FROM terminal_sessions s
       LEFT JOIN users u1 ON u1.id = s.requested_by
       LEFT JOIN users u2 ON u2.id = s.approved_by
       LEFT JOIN servers srv ON srv.id = s.server_id
       WHERE s.id=$1`,
      [sessionId],
    );
    if (!s.rowCount) throw new NotFoundException('session not found');
    const sess = s.rows[0];
    const cmds = await this.listCommands(sessionId);

    const lines: string[] = [];
    lines.push('========================================================');
    lines.push(' LOGWATCH — REGISTRO DE SESSAO DE TERMINAL (ZERO TRUST)');
    lines.push('========================================================');
    lines.push(`Sessao:           ${sess.id}`);
    lines.push(`Servidor:         ${sess.server_name ?? sess.server_id}`);
    lines.push(`Alvo:             ${sess.target}${sess.container_id ? ' (' + sess.container_id + ')' : ''}`);
    lines.push(`Solicitante:      ${sess.requested_by_email ?? sess.requested_by}`);
    lines.push(`Usuario no SO:    ${sess.target_user}`);
    lines.push(`Modo:             ${sess.mode === 'readonly' ? 'Somente leitura' : 'Leitura e escrita'}`);
    lines.push(`Sudo solicitado:  ${sess.sudo_requested ? 'sim' : 'nao'}`);
    lines.push(`Sudo concedido:   ${sess.sudo_granted ? 'sim' : 'nao'}`);
    lines.push(`Aprovado por:     ${sess.approved_by_email ?? '—'}`);
    lines.push(`Motivo:           ${sess.reason}`);
    lines.push(`Criada em:        ${sess.created_at?.toISOString?.() ?? sess.created_at}`);
    lines.push(`Expira em:        ${sess.expires_at ? (sess.expires_at.toISOString?.() ?? sess.expires_at) : '—'}`);
    lines.push(`Encerrada em:     ${sess.closed_at ? (sess.closed_at.toISOString?.() ?? sess.closed_at) : '(sessao ainda ativa)'}`);
    lines.push(`Motivo encerram.: ${closeReason ?? sess.closed_reason ?? '—'}`);
    lines.push('');
    lines.push('--------------------------------------------------------');
    lines.push(` COMANDOS EXECUTADOS (${cmds.length})`);
    lines.push('--------------------------------------------------------');
    if (!cmds.length) {
      lines.push('(nenhum comando capturado — sessao pode ter usado shell sem');
      lines.push(' suporte a HISTFILE, ou foi encerrada antes do primeiro Enter)');
    } else {
      for (const c of cmds) {
        const ts = c.ts?.toISOString?.() ?? c.ts;
        lines.push(`[${ts}]  ${c.command}`);
      }
    }
    lines.push('');
    lines.push('--------------------------------------------------------');
    lines.push(' Este arquivo e gerado automaticamente. O dump bruto de');
    lines.push(' I/O (incluindo telas de programas interativos) continua');
    lines.push(' disponivel via API em /terminal/sessions/:id/recording.');
    lines.push('--------------------------------------------------------');

    const text = lines.join('\n');
    if (persist) {
      await this.pool.query(
        `UPDATE terminal_sessions SET transcript=$2 WHERE id=$1`,
        [sessionId, text],
      ).catch(() => {});
    }
    return text;
  }

  // ---------- Controle de tempo (TTL absoluto + ociosidade) ----------
  /**
   * Antes disso, `expires_at` só era checado uma vez (na hora de abrir o
   * WebSocket) — uma sessão já conectada ficava aberta pra sempre. Esse
   * cron derruba sessões ativas que passaram do TTL absoluto OU que estão
   * ociosas (sem input) por mais que idle_timeout_minutes.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async sweepExpiredSessions() {
    const r = await this.pool.query(
      `SELECT id, 'expirado (tempo maximo da sessao atingido)' AS reason
         FROM terminal_sessions
         WHERE status IN ('active','approved') AND expires_at IS NOT NULL AND expires_at <= now()
       UNION ALL
       SELECT id, 'encerrado por inatividade' AS reason
         FROM terminal_sessions
         WHERE status='active' AND last_activity_at IS NOT NULL
           AND last_activity_at <= now() - (idle_timeout_minutes || ' minutes')::interval`,
    );
    for (const row of r.rows) {
      await this.forceCloseSession(row.id, row.reason).catch((e) =>
        this.logger.warn(`sweep close ${row.id}: ${e.message}`),
      );
    }
  }

  async forceCloseSession(sessionId: string, reason: string) {
    const s = await this.pool.query(`SELECT server_id, status FROM terminal_sessions WHERE id=$1`, [sessionId]);
    if (!s.rowCount || s.rows[0].status === 'closed' || s.rows[0].status === 'expired') return;
    await this.ctrl.invoke(s.rows[0].server_id, 'term.close', { sessionId }).catch(() => {});
    await this.pool.query(
      `UPDATE terminal_sessions SET status='expired', closed_at=now(), closed_reason=$2
       WHERE id=$1 AND status IN ('active','approved')`,
      [sessionId, reason],
    );
    this.term.forceClose(sessionId, reason);
    await this.generateTranscript(sessionId, reason).catch(() => {});
  }

  /** Encerramento manual pedido pelo próprio usuário (botão "Fechar"). */
  async closeSession(sessionId: string, userId: string) {
    const s = await this.pool.query(
      `SELECT server_id FROM terminal_sessions WHERE id=$1 AND requested_by=$2`,
      [sessionId, userId],
    );
    if (!s.rowCount) throw new NotFoundException('session not found');
    await this.ctrl.invoke(s.rows[0].server_id, 'term.close', { sessionId }).catch(() => {});
    await this.pool.query(
      `UPDATE terminal_sessions SET status='closed', closed_at=now(), closed_reason='encerrado pelo usuario'
       WHERE id=$1 AND status IN ('active','approved')`,
      [sessionId],
    );
    this.term.forceClose(sessionId, 'encerrado pelo usuario');
    await this.generateTranscript(sessionId, 'encerrado pelo usuario').catch(() => {});
    return { ok: true };
  }
}
