import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { PgMonitorService } from '../pg-monitor/pg-monitor.service';

export interface DbQueryRequestRow {
  id: string;
  clusterId: string;
  database: string | null;
  kind: 'read' | 'write';
  sqlText: string;
  reason: string;
  contextQuery: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  executedBy: string | null;
  executedAt: string | null;
  rowCount: number | null;
  resultSample: any;
  errorText: string | null;
  createdAt: string;
}

const ROW_CAP = 500; // nunca devolve mais que isso pra UI/sample (não limita o que o UPDATE afeta no servidor)
const READ_STATEMENT_TIMEOUT_MS = 15_000;
const WRITE_STATEMENT_TIMEOUT_MS = 30_000;

/**
 * N1 roda SELECT/WITH ad-hoc direto (db:query, sem aprovação — é leitura).
 * Pra qualquer outra coisa (UPDATE/INSERT/DELETE/etc.), o N1 só pode
 * REGISTRAR um pedido (db:write_request); quem aprova (db:write_approve) é
 * quem executa (db:write_execute) — nunca o solicitante. Mesmo motor de
 * pedido→aprovação do Terminal Web (zero-trust), aplicado a banco.
 */
@Injectable()
export class DbAccessService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly pgMonitor: PgMonitorService,
  ) {}

  listClusters() {
    return this.pgMonitor.listClustersBasic();
  }

  listDatabases(clusterId: string) {
    return this.pgMonitor.listDatabasesForCluster(clusterId);
  }

  private assertReadOnly(sql: string) {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql.trim())) {
      throw new ForbiddenException('Só SELECT/WITH são permitidos em leitura direta — para UPDATE/INSERT/DELETE, abra um pedido de escrita.');
    }
    // Bloqueia truques óbvios de múltiplas instruções (";" seguido de outra coisa que não é fim de string/comentário).
    const withoutTrailingSemi = sql.trim().replace(/;\s*$/, '');
    if (withoutTrailingSemi.includes(';')) {
      throw new ForbiddenException('Apenas uma instrução por execução.');
    }
  }

  /** Leitura direta — sem aprovação. Registrada em db_query_requests só para auditoria/histórico. */
  async runReadOnlyQuery(opts: {
    clusterId: string; database?: string; sql: string; userId: string;
  }) {
    this.assertReadOnly(opts.sql);
    const { client } = await this.pgMonitor.getAdhocClient(opts.clusterId, opts.database);
    const startedAt = Date.now();
    try {
      const rows = await client.queryRawWithTimeout<any>(opts.sql, READ_STATEMENT_TIMEOUT_MS);
      const sample = rows.slice(0, ROW_CAP);
      await this.pool.query(
        `INSERT INTO db_query_requests
           (cluster_id, database, kind, sql_text, reason, status, requested_by, requested_by_email,
            executed_by, executed_at, row_count, result_sample)
         VALUES ($1,$2,'read',$3,'leitura direta','executed',$4,
                 (SELECT email FROM users WHERE id=$4),
                 $4, now(), $5, $6::jsonb)`,
        [opts.clusterId, opts.database ?? null, opts.sql, opts.userId, rows.length, JSON.stringify(sample)],
      );
      return { rows: sample, rowCount: rows.length, truncated: rows.length > ROW_CAP, tookMs: Date.now() - startedAt };
    } catch (e: any) {
      await this.pool.query(
        `INSERT INTO db_query_requests
           (cluster_id, database, kind, sql_text, reason, status, requested_by, requested_by_email, error_text)
         VALUES ($1,$2,'read',$3,'leitura direta','failed',$4,(SELECT email FROM users WHERE id=$4),$5)`,
        [opts.clusterId, opts.database ?? null, opts.sql, opts.userId, e.message],
      );
      throw new BadRequestException(e.message);
    } finally {
      await client.end();
    }
  }

  async listRequests(opts: { mine?: boolean; userId?: string; pending?: boolean; clusterId?: string }) {
    const conds: string[] = [];
    const params: any[] = [];
    if (opts.mine && opts.userId) { params.push(opts.userId); conds.push(`q.requested_by = $${params.length}`); }
    if (opts.pending) conds.push(`q.status = 'pending'`);
    if (opts.clusterId) { params.push(opts.clusterId); conds.push(`q.cluster_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await this.pool.query(
      `SELECT q.*, c.name AS cluster_name,
              COALESCE(ru.email, q.requested_by_email) AS requested_by_email,
              au.email AS approved_by_email, eu.email AS executed_by_email
       FROM db_query_requests q
       JOIN pg_clusters c ON c.id = q.cluster_id
       LEFT JOIN users ru ON ru.id = q.requested_by
       LEFT JOIN users au ON au.id = q.approved_by
       LEFT JOIN users eu ON eu.id = q.executed_by
       ${where}
       ORDER BY q.created_at DESC
       LIMIT 200`,
      params,
    );
    return r.rows;
  }

  async requestWrite(opts: {
    clusterId: string; database?: string; sql: string; reason: string; contextQuery?: string; userId: string;
  }) {
    if (/^\s*(SELECT|WITH)\b/i.test(opts.sql.trim())) {
      throw new BadRequestException('Isto é uma leitura — use a execução direta (db:query), não precisa de aprovação.');
    }
    const r = await this.pool.query(
      `INSERT INTO db_query_requests
         (cluster_id, database, kind, sql_text, reason, context_query, status, requested_by, requested_by_email)
       VALUES ($1,$2,'write',$3,$4,$5,'pending',$6,(SELECT email FROM users WHERE id=$6)) RETURNING id`,
      [opts.clusterId, opts.database ?? null, opts.sql, opts.reason, opts.contextQuery ?? null, opts.userId],
    );
    return { id: r.rows[0].id };
  }

  private async getOrThrow(id: string) {
    const r = await this.pool.query(`SELECT * FROM db_query_requests WHERE id=$1`, [id]);
    if (!r.rowCount) throw new NotFoundException('pedido não encontrado');
    return r.rows[0];
  }

  async reject(id: string, approverId: string) {
    const req = await this.getOrThrow(id);
    if (req.status !== 'pending') throw new BadRequestException('pedido não está pendente');
    await this.pool.query(
      `UPDATE db_query_requests SET status='rejected', approved_by=$2, approved_at=now() WHERE id=$1`,
      [id, approverId],
    );
    return { ok: true };
  }

  /**
   * Aprovar JÁ EXECUTA — por design (mesmo princípio do Terminal Web: quem
   * aprova é quem assume a responsabilidade pela ação, dentro de uma sessão
   * controlada e auditada). Evita um UPDATE "aprovado" ficar pendurado sem
   * ninguém para executá-lo, e deixa claro no transcript quem efetivamente
   * tocou no banco.
   */
  async approveAndExecute(id: string, approverId: string) {
    const req = await this.getOrThrow(id);
    if (req.status !== 'pending') throw new BadRequestException('pedido não está pendente');
    if (req.kind !== 'write') throw new BadRequestException('pedido não é de escrita');

    await this.pool.query(
      `UPDATE db_query_requests SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`,
      [id, approverId],
    );

    const { client } = await this.pgMonitor.getAdhocClient(req.cluster_id, req.database ?? undefined);
    try {
      const r = await client.withTransaction(
        (query) => query(req.sql_text),
        WRITE_STATEMENT_TIMEOUT_MS,
      );
      await this.pool.query(
        `UPDATE db_query_requests
           SET status='executed', executed_by=$2, executed_at=now(), row_count=$3
         WHERE id=$1`,
        [id, approverId, r.rowCount ?? 0],
      );
      return { ok: true, rowCount: r.rowCount ?? 0 };
    } catch (e: any) {
      await this.pool.query(
        `UPDATE db_query_requests SET status='failed', executed_by=$2, executed_at=now(), error_text=$3 WHERE id=$1`,
        [id, approverId, e.message],
      );
      throw new BadRequestException(`Execução falhou (revertida): ${e.message}`);
    } finally {
      await client.end();
    }
  }
}
