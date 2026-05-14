import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

function safeArray<T>(v: unknown): T[] { return Array.isArray(v) ? (v as T[]) : []; }

interface FileStat {
  path: string;
  size: number | null;
  sha256?: string;
  mtime?: string | null;
}

@Injectable()
export class ScriptsService {
  private readonly logger = new Logger('ScriptsService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
  ) {}

  // ---------- Filesystem proxy ----------
  async listDir(serverId: string, path: string) {
    const r: any = await this.ctrl.invoke(serverId, 'fs.listDir', { path });
    // Anexa "lastEditor" em cada item do tipo file (busca apenas paths
    // que existem em script_files — overhead irrelevante).
    const items: any[] = safeArray(r?.items);
    const filePaths = items.filter((it) => it?.type === 'file').map((it) => it.path);
    if (filePaths.length) {
      const editorsQ = await this.pool.query(
        `SELECT sf.path,
                v.author_email AS "lastEditor",
                v.ts           AS "lastEditedAt"
         FROM script_files sf
         LEFT JOIN LATERAL (
           SELECT author_email, ts FROM script_versions
           WHERE file_id = sf.id ORDER BY ts DESC LIMIT 1
         ) v ON true
         WHERE sf.server_id = $1 AND sf.path = ANY($2::text[])`,
        [serverId, filePaths],
      );
      const idx = new Map<string, { lastEditor?: string; lastEditedAt?: string }>(
        editorsQ.rows.map((row) => [row.path, { lastEditor: row.lastEditor, lastEditedAt: row.lastEditedAt }]),
      );
      for (const it of items) {
        const m = idx.get(it.path);
        if (m) { it.lastEditor = m.lastEditor; it.lastEditedAt = m.lastEditedAt; }
      }
    }
    return { ...r, items };
  }

  async readFile(serverId: string, path: string) {
    const r = await this.ctrl.invoke<FileStat & { content: string }>(serverId, 'fs.readFile', { path });
    // Sincroniza tabela script_files (cache de metadados)
    const file = await this.upsertFileRecord(serverId, r);
    // Anexa último editor (autor da versão mais recente)
    const last = await this.pool.query(
      `SELECT author_email AS "lastEditor", ts AS "lastEditedAt", comment
       FROM script_versions WHERE file_id=$1 ORDER BY ts DESC LIMIT 1`,
      [file.id],
    );
    return {
      ...r,
      lastEditor: last.rows[0]?.lastEditor ?? null,
      lastEditedAt: last.rows[0]?.lastEditedAt ?? null,
      lastComment: last.rows[0]?.comment ?? null,
    };
  }

  async writeFile(input: {
    serverId: string;
    path: string;
    content: string;
    actorId: string | null;
    actorEmail?: string | null;
    comment?: string;
  }) {
    const before = await this.ctrl.invoke<any>(input.serverId, 'fs.readFile', { path: input.path })
      .catch(() => null);

    const r = await this.ctrl.invoke<FileStat>(input.serverId, 'fs.writeFile', {
      path: input.path, content: input.content,
    });

    const file = await this.upsertFileRecord(input.serverId, { ...r, content: input.content });

    // Grava versão (se conteúdo mudou)
    const newSha = createHash('sha256').update(input.content, 'utf-8').digest('hex');
    if (!before || before.sha256 !== newSha) {
      await this.pool.query(
        `INSERT INTO script_versions(file_id, author_id, author_email, content, sha256, comment)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [file.id, input.actorId, input.actorEmail ?? null, input.content, newSha, input.comment ?? null],
      );
    }
    return { ...r, fileId: file.id };
  }

  async listVersions(serverId: string, path: string) {
    const file = await this.findFile(serverId, path);
    if (!file) return [];
    const r = await this.pool.query(
      `SELECT id, ts, author_email AS "authorEmail", sha256, comment
       FROM script_versions WHERE file_id=$1 ORDER BY ts DESC LIMIT 100`,
      [file.id],
    );
    return r.rows;
  }

  async getVersion(versionId: string) {
    const r = await this.pool.query(
      `SELECT id, ts, content, author_email AS "authorEmail", sha256, comment
       FROM script_versions WHERE id=$1`,
      [versionId],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  // ---------- Execution com gate de aprovação ----------
  async requestExecution(input: {
    serverId: string;
    path: string;
    args?: string;
    cwd?: string;
    requestedBy: string;
  }) {
    const env = await this.serverEnvironment(input.serverId);
    const isProd = env === 'production';

    const r = await this.pool.query(
      `INSERT INTO script_executions(server_id, path, args, cwd, requested_by, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status`,
      [input.serverId, input.path, input.args ?? null, input.cwd ?? null, input.requestedBy,
       isProd ? 'pending' : 'approved'],
    );

    const exec = r.rows[0];
    if (!isProd) {
      // Dispara já que não é prod
      void this.runExecution(exec.id);
    }
    return { id: exec.id, status: exec.status, requiresApproval: isProd };
  }

  async approveExecution(execId: string, approverId: string) {
    const r = await this.pool.query(
      `UPDATE script_executions SET status='approved', approved_by=$2
       WHERE id=$1 AND status='pending' RETURNING server_id`,
      [execId, approverId],
    );
    if (!r.rowCount) throw new NotFoundException('execution not found or not pending');
    void this.runExecution(execId);
    return { ok: true };
  }

  async rejectExecution(execId: string, approverId: string) {
    await this.pool.query(
      `UPDATE script_executions SET status='rejected', approved_by=$2
       WHERE id=$1 AND status='pending'`,
      [execId, approverId],
    );
    return { ok: true };
  }

  async listExecutions(serverId?: string) {
    const sql = serverId
      ? `SELECT * FROM script_executions WHERE server_id=$1 ORDER BY ts DESC LIMIT 100`
      : `SELECT * FROM script_executions ORDER BY ts DESC LIMIT 100`;
    const r = await this.pool.query(sql, serverId ? [serverId] : []);
    return r.rows;
  }

  async getExecution(execId: string) {
    const r = await this.pool.query(
      `SELECT * FROM script_executions WHERE id=$1 ORDER BY ts DESC LIMIT 1`,
      [execId],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  // ---------- internals ----------
  private async runExecution(execId: string) {
    const e = await this.getExecution(execId);
    await this.pool.query(`UPDATE script_executions SET status='running' WHERE id=$1`, [execId]);
    try {
      const argv = e.args ? e.args.split(/\s+/).filter(Boolean) : [];
      const r = await this.ctrl.invoke<any>(e.server_id, 'fs.execute', {
        path: e.path, args: argv, cwd: e.cwd, timeoutMs: 120_000,
      }, { timeoutMs: 130_000 });
      await this.pool.query(
        `UPDATE script_executions
           SET status=$2, exit_code=$3, stdout=$4, stderr=$5, duration_ms=$6
         WHERE id=$1`,
        [
          execId,
          r.exitCode === 0 ? 'succeeded' : 'failed',
          r.exitCode,
          (r.stdout ?? '').slice(0, 200_000),
          (r.stderr ?? '').slice(0, 200_000),
          r.durationMs,
        ],
      );
    } catch (err: any) {
      await this.pool.query(
        `UPDATE script_executions SET status='failed', stderr=$2 WHERE id=$1`,
        [execId, err.message],
      );
    }
  }

  private async serverEnvironment(serverId: string): Promise<string> {
    const r = await this.pool.query(
      `SELECT environment FROM servers WHERE id=$1`,
      [serverId],
    );
    return r.rows[0]?.environment ?? 'staging';
  }

  private async findFile(serverId: string, path: string) {
    const r = await this.pool.query(
      `SELECT id FROM script_files WHERE server_id=$1 AND path=$2`,
      [serverId, path],
    );
    return r.rows[0] ?? null;
  }

  private async upsertFileRecord(serverId: string, r: any) {
    const ins = await this.pool.query(
      `INSERT INTO script_files(server_id, path, size_bytes, sha256, last_modified, cached_content)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (server_id, path)
       DO UPDATE SET size_bytes=EXCLUDED.size_bytes, sha256=EXCLUDED.sha256,
                     last_modified=EXCLUDED.last_modified, cached_content=EXCLUDED.cached_content
       RETURNING id`,
      [serverId, r.path, r.size, r.sha256 ?? null, r.mtime ?? null,
       r.content && r.size && r.size < 1_000_000 ? r.content : null],
    );
    return ins.rows[0];
  }
}
