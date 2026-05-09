import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Executor de Terraform.
 *
 * Estratégia:
 *   1. clona o repo numa tmp dir (git clone --depth 1 -b <branch>)
 *   2. cd <repo_path>
 *   3. terraform init (-no-color)
 *   4. terraform plan -no-color -out=tfplan  (ou apply -auto-approve com plan salvo)
 *   5. captura stdout, parse de "Plan: X to add, Y to change, Z to destroy"
 *   6. limpa tmp dir
 *
 * Requer terraform e git instalados na imagem do backend (ver Dockerfile).
 *
 * Vars sensíveis vêm do vault via TF_VAR_* env.
 */
@Injectable()
export class TerraformRunner {
  private readonly logger = new Logger('TerraformRunner');

  async runPlan(opts: {
    repoUrl: string;
    branch: string;
    repoPath: string;
    env?: Record<string, string>;
  }): Promise<{
    output: string;
    add: number;
    change: number;
    destroy: number;
    success: boolean;
  }> {
    return this.runWith('plan', opts);
  }

  async runApply(opts: {
    repoUrl: string;
    branch: string;
    repoPath: string;
    env?: Record<string, string>;
  }) {
    return this.runWith('apply', opts);
  }

  private async runWith(
    kind: 'plan' | 'apply' | 'destroy',
    opts: {
      repoUrl: string;
      branch: string;
      repoPath: string;
      env?: Record<string, string>;
    },
  ) {
    const tmp = mkdtempSync(join(tmpdir(), 'tfrun-'));
    try {
      // 1. clone
      await this.exec('git', ['clone', '--depth', '1', '-b', opts.branch, opts.repoUrl, tmp], {});
      const cwd = join(tmp, opts.repoPath);

      // 2. init
      await this.exec('terraform', ['init', '-no-color', '-input=false'], { cwd, env: opts.env });

      // 3. comando principal
      let args: string[];
      if (kind === 'plan') args = ['plan', '-no-color', '-input=false', '-detailed-exitcode'];
      else if (kind === 'apply') args = ['apply', '-no-color', '-input=false', '-auto-approve'];
      else args = ['destroy', '-no-color', '-input=false', '-auto-approve'];

      const r = await this.exec('terraform', args, { cwd, env: opts.env, ignoreNonZero: true });
      const output = r.stdout + (r.stderr ? '\n--- stderr ---\n' + r.stderr : '');

      const match = output.match(/Plan:\s+(\d+)\s+to add,\s+(\d+)\s+to change,\s+(\d+)\s+to destroy/);
      const applyMatch = output.match(/Apply complete!\s+Resources:\s+(\d+)\s+added,\s+(\d+)\s+changed,\s+(\d+)\s+destroyed/);

      const m = match || applyMatch;
      // detailed-exitcode: 0 = sem mudanças, 2 = mudanças detectadas, 1 = erro
      const success = kind === 'plan' ? r.code === 0 || r.code === 2 : r.code === 0;
      return {
        output,
        add: m ? parseInt(m[1], 10) : 0,
        change: m ? parseInt(m[2], 10) : 0,
        destroy: m ? parseInt(m[3], 10) : 0,
        success,
      };
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  }

  private exec(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; ignoreNonZero?: boolean },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (b) => (stdout += b.toString()));
      child.stderr.on('data', (b) => (stderr += b.toString()));
      child.on('close', (code) => {
        if (code === 0 || opts.ignoreNonZero) resolve({ code: code ?? 0, stdout, stderr });
        else reject(new Error(`${cmd} exited with ${code}: ${stderr.slice(0, 300)}`));
      });
      child.on('error', reject);
    });
  }
}
