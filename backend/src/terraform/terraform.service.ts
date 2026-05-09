import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { TerraformRunner } from './terraform.runner';
import { GithubClient } from './github.client';
import { SecretsService } from '../secrets/secrets.service';

@Injectable()
export class TerraformService {
  private readonly logger = new Logger('TerraformService');
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly runner: TerraformRunner,
    private readonly github: GithubClient,
    private readonly secrets: SecretsService,
  ) {}

  // ---------------- Workspaces CRUD
  async listWorkspaces() {
    const r = await this.pool.query(
      `SELECT id, name, description, repo_url AS "repoUrl", repo_path AS "repoPath",
              branch, cloud, vars_secret AS "varsSecret", created_at AS "createdAt"
       FROM terraform_workspaces ORDER BY name`,
    );
    return r.rows;
  }

  async createWorkspace(w: any) {
    const r = await this.pool.query(
      `INSERT INTO terraform_workspaces(name, description, repo_url, repo_path, branch, cloud, vars_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [w.name, w.description ?? null, w.repoUrl, w.repoPath ?? '.', w.branch ?? 'main', w.cloud ?? null, w.varsSecret ?? null],
    );
    return r.rows[0];
  }

  async deleteWorkspace(id: string) {
    await this.pool.query(`DELETE FROM terraform_workspaces WHERE id=$1`, [id]);
    return { ok: true };
  }

  // ---------------- Runs
  async listRuns(workspaceId?: string) {
    const r = workspaceId
      ? await this.pool.query(
          `SELECT * FROM terraform_runs WHERE workspace_id=$1 ORDER BY ts DESC LIMIT 100`,
          [workspaceId],
        )
      : await this.pool.query(
          `SELECT * FROM terraform_runs ORDER BY ts DESC LIMIT 100`,
        );
    return r.rows;
  }

  async getRun(id: string) {
    const r = await this.pool.query(
      `SELECT * FROM terraform_runs WHERE id=$1 ORDER BY ts DESC LIMIT 1`,
      [id],
    );
    if (!r.rowCount) throw new NotFoundException();
    return r.rows[0];
  }

  /** Dispara plan numa branch nova + abre PR no GitHub. */
  async triggerPlan(workspaceId: string, userId: string) {
    const ws = await this.pool.query(
      `SELECT * FROM terraform_workspaces WHERE id=$1`,
      [workspaceId],
    );
    if (!ws.rowCount) throw new NotFoundException('workspace not found');
    const w = ws.rows[0];

    // Insere run pending
    const runId = (await this.pool.query(
      `INSERT INTO terraform_runs(workspace_id, workspace_name, kind, status, triggered_by)
       VALUES ($1,$2,'plan','pending',$3) RETURNING id`,
      [w.id, w.name, userId],
    )).rows[0].id;

    // Em background: roda plan, atualiza status, cria PR
    void this.runPlanInBackground(runId, w);

    return { runId, status: 'pending' };
  }

  private async runPlanInBackground(runId: string, w: any) {
    const t0 = Date.now();
    await this.pool.query(`UPDATE terraform_runs SET status='running' WHERE id=$1`, [runId]);
    try {
      const env = await this.buildEnv(w.vars_secret);
      const result = await this.runner.runPlan({
        repoUrl: w.repo_url,
        branch: w.branch,
        repoPath: w.repo_path,
        env,
      });

      const status = result.success ? 'succeeded' : 'failed';
      const dur = Math.round((Date.now() - t0) / 1000);
      await this.pool.query(
        `UPDATE terraform_runs
           SET status=$2, output=$3, add_count=$4, change_count=$5, destroy_count=$6, duration_sec=$7
         WHERE id=$1`,
        [runId, status, result.output.slice(0, 200_000), result.add, result.change, result.destroy, dur],
      );

      if (status === 'succeeded') {
        // Cria PR com o output do plan registrado
        try {
          const repo = w.repo_url
            .replace(/^https?:\/\/github\.com\//, '')
            .replace(/\.git$/, '');
          const branch = `logwatch-plan-${runId.slice(0, 8)}`;
          const path = `.logwatch/plans/${runId}.txt`;
          const pr = await this.github.createPlanPR({
            repo,
            base: w.branch,
            branch,
            path,
            content: result.output,
            commitMessage: `terraform plan run ${runId.slice(0, 8)}`,
            prTitle: `[LogWatch] Terraform plan: ${w.name}`,
            prBody: this.formatPrBody(result),
          });
          await this.pool.query(
            `UPDATE terraform_runs SET pr_number=$2, pr_url=$3, commit_sha=$4 WHERE id=$1`,
            [runId, pr.number, pr.url, pr.sha],
          );
        } catch (e: any) {
          this.logger.warn(`PR creation failed for run ${runId}: ${e.message}`);
        }
      }
    } catch (e: any) {
      await this.pool.query(
        `UPDATE terraform_runs SET status='failed', output=$2 WHERE id=$1`,
        [runId, `RUN ERROR: ${e.message}`],
      );
    }
  }

  /** Aprova manualmente um plan (mergeia o PR e dispara apply). */
  async approveRun(planRunId: string, userId: string) {
    const run = await this.getRun(planRunId);
    if (run.kind !== 'plan' || run.status !== 'succeeded') {
      throw new Error('Run não está apto para aprovação');
    }
    const ws = (await this.pool.query(
      `SELECT * FROM terraform_workspaces WHERE id=$1`,
      [run.workspace_id],
    )).rows[0];

    // 1. mergeia o PR (se existir)
    if (run.pr_number) {
      try {
        const repo = ws.repo_url
          .replace(/^https?:\/\/github\.com\//, '')
          .replace(/\.git$/, '');
        await this.github.mergePR(repo, run.pr_number);
      } catch (e: any) {
        this.logger.warn(`merge failed: ${e.message}`);
      }
    }

    // 2. cria apply run + dispara em background
    const applyId = (await this.pool.query(
      `INSERT INTO terraform_runs(workspace_id, workspace_name, kind, status, triggered_by)
       VALUES ($1,$2,'apply','pending',$3) RETURNING id`,
      [ws.id, ws.name, userId],
    )).rows[0].id;
    void this.runApplyInBackground(applyId, ws);
    return { applyRunId: applyId };
  }

  private async runApplyInBackground(runId: string, w: any) {
    const t0 = Date.now();
    await this.pool.query(`UPDATE terraform_runs SET status='running' WHERE id=$1`, [runId]);
    try {
      const env = await this.buildEnv(w.vars_secret);
      const result = await this.runner.runApply({
        repoUrl: w.repo_url,
        branch: w.branch,
        repoPath: w.repo_path,
        env,
      });
      const dur = Math.round((Date.now() - t0) / 1000);
      await this.pool.query(
        `UPDATE terraform_runs
           SET status=$2, output=$3, add_count=$4, change_count=$5, destroy_count=$6, duration_sec=$7
         WHERE id=$1`,
        [runId, result.success ? 'succeeded' : 'failed', result.output.slice(0, 200_000), result.add, result.change, result.destroy, dur],
      );
    } catch (e: any) {
      await this.pool.query(
        `UPDATE terraform_runs SET status='failed', output=$2 WHERE id=$1`,
        [runId, `APPLY ERROR: ${e.message}`],
      );
    }
  }

  private async buildEnv(varsSecretName: string | null): Promise<Record<string, string>> {
    if (!varsSecretName) return {};
    try {
      const raw = await this.secrets.get(varsSecretName);
      // Espera JSON: { "AWS_ACCESS_KEY_ID": "...", "TF_VAR_db_pass": "..." }
      const parsed = JSON.parse(raw);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') env[k] = v;
      }
      return env;
    } catch (e: any) {
      this.logger.warn(`buildEnv: ${e.message}`);
      return {};
    }
  }

  private formatPrBody(result: { add: number; change: number; destroy: number; output: string }): string {
    const summary = `**Plan summary:** ${result.add} to add, ${result.change} to change, ${result.destroy} to destroy.`;
    const head = result.output
      .split('\n')
      .slice(-200)
      .join('\n');
    return `${summary}\n\n<details><summary>Plan output (last 200 lines)</summary>\n\n\`\`\`\n${head}\n\`\`\`\n\n</details>\n\n_Approve via LogWatch UI to apply this plan._`;
  }
}
