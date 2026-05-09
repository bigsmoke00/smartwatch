import { Injectable, Logger } from '@nestjs/common';
import { request } from 'undici';

/**
 * Cliente HTTP fino para a API REST do GitHub.
 *
 * Em produção, considere usar @octokit/rest para validações e tipos:
 *   npm i @octokit/rest
 *
 * Aqui usamos undici para evitar dependência de SDK e cobrir os endpoints
 * que precisamos para o Terraform Control Plane:
 *   - criar branch
 *   - commit de arquivo (plan output) numa branch
 *   - abrir PR
 *   - mergear PR
 *   - listar arquivos do repo (path)
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger('GithubClient');
  private readonly base = 'https://api.github.com';
  private readonly token = process.env.GITHUB_TOKEN || '';

  private headers() {
    if (!this.token) throw new Error('GITHUB_TOKEN não configurado');
    return {
      authorization: `Bearer ${this.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'LogWatch/1.0',
      'content-type': 'application/json',
    };
  }

  private async req(method: string, path: string, body?: any) {
    const res = await request(`${this.base}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      throw new Error(`GitHub ${method} ${path} → ${res.statusCode}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Cria PR com mudança em arquivo (usado para "registrar plan" no PR). */
  async createPlanPR(opts: {
    repo: string;          // org/repo
    base: string;          // ex: main
    branch: string;        // nova branch
    path: string;          // caminho do arquivo (ex: .terraform/plans/xxx.txt)
    content: string;       // conteúdo do arquivo (utf-8)
    commitMessage: string;
    prTitle: string;
    prBody: string;
  }) {
    const [owner, repo] = opts.repo.split('/');

    // 1. SHA do head da base
    const refData = await this.req('GET', `/repos/${owner}/${repo}/git/ref/heads/${opts.base}`);
    const baseSha = refData.object.sha;

    // 2. Cria branch
    await this.req('POST', `/repos/${owner}/${repo}/git/refs`, {
      ref: `refs/heads/${opts.branch}`,
      sha: baseSha,
    }).catch((e) => {
      // Se branch já existe, segue
      if (!String(e.message).includes('Reference already exists')) throw e;
    });

    // 3. Commita arquivo na branch
    const contentB64 = Buffer.from(opts.content, 'utf-8').toString('base64');
    // Verifica se já existe pra obter sha
    let existingSha: string | undefined;
    try {
      const f = await this.req(
        'GET',
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(opts.path)}?ref=${opts.branch}`,
      );
      existingSha = f?.sha;
    } catch {
      /* não existe — ok */
    }
    await this.req('PUT', `/repos/${owner}/${repo}/contents/${encodeURIComponent(opts.path)}`, {
      message: opts.commitMessage,
      content: contentB64,
      branch: opts.branch,
      sha: existingSha,
    });

    // 4. Abre PR
    const pr = await this.req('POST', `/repos/${owner}/${repo}/pulls`, {
      title: opts.prTitle,
      body: opts.prBody,
      head: opts.branch,
      base: opts.base,
    });
    return { number: pr.number as number, url: pr.html_url as string, sha: pr.head.sha as string };
  }

  async mergePR(repo: string, prNumber: number, mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash') {
    const [owner, r] = repo.split('/');
    return this.req('PUT', `/repos/${owner}/${r}/pulls/${prNumber}/merge`, {
      merge_method: mergeMethod,
    });
  }

  async commentPR(repo: string, prNumber: number, body: string) {
    const [owner, r] = repo.split('/');
    return this.req('POST', `/repos/${owner}/${r}/issues/${prNumber}/comments`, { body });
  }
}
