import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { createHmac, timingSafeEqual } from 'crypto';
import { PG_POOL } from '../db/db.module';

export interface WorkflowRunRow {
  ts: string;
  repoFullName: string;
  runId: number;
  workflowName?: string;
  branch?: string;
  event?: string;
  actor?: string;
  status?: string;
  conclusion?: string;
  url?: string;
  durationSec?: number;
  raw?: any;
}

@Injectable()
export class GithubActionsService {
  private readonly logger = new Logger('GithubActionsService');
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async listRepos() {
    const r = await this.pool.query(
      `SELECT id, full_name AS "fullName", enabled, created_at AS "createdAt"
       FROM github_repos ORDER BY full_name`,
    );
    return r.rows;
  }

  async createRepo(fullName: string, webhookSecret: string) {
    const r = await this.pool.query(
      `INSERT INTO github_repos(full_name, webhook_secret)
       VALUES ($1,$2)
       ON CONFLICT (full_name) DO UPDATE SET webhook_secret=EXCLUDED.webhook_secret
       RETURNING id`,
      [fullName, webhookSecret],
    );
    return r.rows[0];
  }

  async deleteRepo(id: string) {
    await this.pool.query(`DELETE FROM github_repos WHERE id=$1`, [id]);
    return { ok: true };
  }

  /** Verifica X-Hub-Signature-256 (HMAC). */
  async verifyWebhook(repoFullName: string, signature: string, rawBody: Buffer): Promise<boolean> {
    if (!signature?.startsWith('sha256=')) return false;
    const r = await this.pool.query(
      `SELECT webhook_secret FROM github_repos WHERE full_name=$1 AND enabled=true`,
      [repoFullName],
    );
    if (!r.rowCount || !r.rows[0].webhook_secret) return false;
    const expected = 'sha256=' + createHmac('sha256', r.rows[0].webhook_secret)
      .update(rawBody).digest('hex');
    if (expected.length !== signature.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }

  /** Ingest do payload de workflow_run. */
  async ingestWorkflowRun(payload: any) {
    if (payload?.action !== 'completed' && payload?.action !== 'requested' && payload?.action !== 'in_progress') {
      // Ignora outros actions
      return { ok: true, ignored: true };
    }
    const wr = payload.workflow_run;
    if (!wr) return { ok: false, message: 'no workflow_run' };

    const ts = wr.run_started_at || wr.created_at || new Date().toISOString();
    const dur = wr.run_started_at && wr.updated_at
      ? Math.round((Date.parse(wr.updated_at) - Date.parse(wr.run_started_at)) / 1000)
      : null;

    await this.pool.query(
      `INSERT INTO github_workflow_runs(ts, repo_full_name, run_id, workflow_name, branch,
                                        event, actor, status, conclusion, url, duration_sec, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        ts,
        payload.repository?.full_name,
        wr.id,
        wr.name,
        wr.head_branch,
        wr.event,
        wr.actor?.login,
        wr.status,
        wr.conclusion,
        wr.html_url,
        dur,
        JSON.stringify(wr),
      ],
    );
    return { ok: true };
  }

  async listRuns(filters: {
    repo?: string;
    branch?: string;
    conclusion?: string;
    days?: number;
  }) {
    const where: string[] = [`ts >= now() - ($1 || ' days')::interval`];
    const params: any[] = [filters.days ?? 14];
    let i = 2;
    if (filters.repo) { where.push(`repo_full_name = $${i++}`); params.push(filters.repo); }
    if (filters.branch) { where.push(`branch = $${i++}`); params.push(filters.branch); }
    if (filters.conclusion) { where.push(`conclusion = $${i++}`); params.push(filters.conclusion); }
    const r = await this.pool.query(
      `SELECT ts, repo_full_name AS "repoFullName", run_id AS "runId",
              workflow_name AS "workflowName", branch, event, actor,
              status, conclusion, url, duration_sec AS "durationSec"
       FROM github_workflow_runs
       WHERE ${where.join(' AND ')}
       ORDER BY ts DESC LIMIT 200`,
      params,
    );
    return r.rows;
  }

  async summary(days = 14) {
    const r = await this.pool.query(
      `SELECT
         conclusion,
         count(*)::int AS n,
         avg(duration_sec)::float AS avg_duration
       FROM github_workflow_runs
       WHERE ts >= now() - ($1 || ' days')::interval
         AND status = 'completed'
       GROUP BY conclusion`,
      [days],
    );
    return r.rows.map((x) => ({
      conclusion: x.conclusion,
      count: Number(x.n),
      avgDurationSec: x.avg_duration ? Math.round(x.avg_duration) : null,
    }));
  }
}
