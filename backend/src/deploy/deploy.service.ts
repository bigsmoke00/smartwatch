import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { request } from 'undici';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

type Kind = 'deploy' | 'rollback';
interface EnvChange { key: string; value: string }

export interface DeployApp {
  id: string;
  name: string;
  sistema: string;
  componente: string;
  environment: string;
  server_id: string;
  working_dir: string;
  strategy: string;
  config: any;
  image_repo: string | null;
  enabled: boolean;
}

// Deploy pode demorar (docker pull de imagem grande). Timeout generoso.
const EXEC_TIMEOUT_MS = 10 * 60_000;
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SCRIPT_PRIORITY = ['deploy.sh', 'start.sh', 'up.sh', 'run.sh'];

@Injectable()
export class DeployService {
  private readonly logger = new Logger('DeployService');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
  ) {}

  // ============================================================
  // CRUD de aplicações (opcional — usado no disparo manual e como catálogo)
  // ============================================================
  async listApps() {
    const r = await this.pool.query(
      `SELECT a.*, s.name AS server_name
       FROM deploy_apps a JOIN servers s ON s.id = a.server_id
       ORDER BY a.sistema, a.componente, a.environment`,
    );
    return r.rows;
  }

  async createApp(input: any, actorId: string | null) {
    const r = await this.pool.query(
      `INSERT INTO deploy_apps
         (name, sistema, componente, environment, server_id, working_dir, strategy, config, image_repo, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
      [
        input.name, input.sistema, input.componente, input.environment ?? 'production',
        input.serverId, input.workingDir, input.strategy ?? 'compose_env',
        JSON.stringify(input.config ?? {}), input.imageRepo ?? null, actorId,
      ],
    );
    return r.rows[0];
  }

  async updateApp(id: string, patch: any) {
    const map: Record<string, string> = {
      name: 'name', sistema: 'sistema', componente: 'componente', environment: 'environment',
      serverId: 'server_id', workingDir: 'working_dir', strategy: 'strategy', imageRepo: 'image_repo',
      enabled: 'enabled',
    };
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); params.push(patch[k]); }
    }
    if (patch.config !== undefined) { sets.push(`config=$${i++}::jsonb`); params.push(JSON.stringify(patch.config)); }
    if (!sets.length) return this.getApp(id);
    sets.push(`updated_at=now()`);
    params.push(id);
    const r = await this.pool.query(`UPDATE deploy_apps SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, params);
    if (!r.rowCount) throw new NotFoundException('aplicação não encontrada');
    return r.rows[0];
  }

  async deleteApp(id: string) {
    await this.pool.query(`DELETE FROM deploy_apps WHERE id=$1`, [id]);
    return { ok: true };
  }

  private async getApp(id: string): Promise<DeployApp> {
    const r = await this.pool.query(`SELECT * FROM deploy_apps WHERE id=$1`, [id]);
    if (!r.rowCount) throw new NotFoundException('aplicação não encontrada');
    return r.rows[0];
  }

  // ============================================================
  // Histórico
  // ============================================================
  async listExecutions(limit = 100) {
    const r = await this.pool.query(
      `SELECT id, kind, source, gmud_id, numero_protocolo, sistema, componente, environment,
              version, previous_version, server_host, working_dir, detected_mode, status,
              pipeline_id, error_text, callback_status, started_at, completed_at, created_at
       FROM deploy_executions ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }

  async getExecution(id: string) {
    const r = await this.pool.query(`SELECT * FROM deploy_executions WHERE id=$1`, [id]);
    if (!r.rowCount) throw new NotFoundException('execução não encontrada');
    return r.rows[0];
  }

  // ============================================================
  // Webhook do SmartOne (ida)
  // ============================================================
  async handleSmartOneWebhook(raw: any) {
    const p = normalizePayload(raw);
    const kind: Kind = p.event === 'gmud_rollback_started' ? 'rollback' : 'deploy';
    const version = kind === 'rollback' ? (p.versaoAnterior ?? p.versao) : p.versao;

    // Resolve o servidor pelo host informado (name/hostname/ip).
    const server = p.servidor ? await this.resolveServerByHost(p.servidor) : null;

    const ins = await this.pool.query(
      `INSERT INTO deploy_executions
         (kind, source, gmud_id, numero_protocolo, sistema, componente, environment,
          version, previous_version, callback_url, server_host, working_dir, envs, status)
       VALUES ($1,'smartone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'received')
       RETURNING id`,
      [
        kind, p.gmudId ?? null, p.numeroProtocolo ?? null, p.sistema ?? null, p.componente ?? null,
        p.ambiente ?? null, kind === 'deploy' ? version : null, kind === 'rollback' ? version : null,
        p.callbackUrl ?? null, p.servidor ?? null, p.diretorio ?? null, JSON.stringify(p.envs),
      ],
    );
    const execId: string = ins.rows[0].id;
    await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$1 WHERE id=$1`, [execId]);

    // Validações que barram a execução com erro claro + callback.
    if (!p.servidor) return this.bail(execId, 'payload sem "servidor"', p.callbackUrl);
    if (!server) return this.bail(execId, `servidor "${p.servidor}" não encontrado no SmartWatch`, p.callbackUrl);
    if (!p.diretorio) return this.bail(execId, 'payload sem "diretorio"', p.callbackUrl);
    if (!version) return this.bail(execId, 'payload sem versão', p.callbackUrl);

    this.runAdaptivePipeline(execId, server.id, p.diretorio, version, p.envs, kind, p.callbackUrl)
      .catch((e) => this.logger.error(`pipeline ${execId}: ${e?.message}`));
    return { pipeline_id: execId, status: 'received', server: server.name };
  }

  private async bail(execId: string, message: string, callbackUrl?: string | null) {
    await this.pool.query(
      `UPDATE deploy_executions SET status='error', error_text=$2, completed_at=now() WHERE id=$1`,
      [execId, message.slice(0, 4000)],
    );
    await this.sendCallback(callbackUrl, execId, 'error', message);
    return { pipeline_id: execId, status: 'error', message };
  }

  private async resolveServerByHost(host: string): Promise<{ id: string; name: string } | null> {
    const h = host.trim();
    const r = await this.pool.query(
      `SELECT id, name FROM servers
       WHERE deleted_at IS NULL AND (
         lower(name) = lower($1) OR lower(coalesce(hostname,'')) = lower($1) OR host(ip) = $1
       )
       LIMIT 1`,
      [h],
    );
    return r.rows[0] ?? null;
  }

  // ============================================================
  // Disparo manual (frontend) — usa o servidor/diretório do cadastro
  // ============================================================
  async triggerManual(appId: string, opts: { version: string; kind?: Kind }, userId: string) {
    const app = await this.getApp(appId);
    const kind: Kind = opts.kind ?? 'deploy';
    if (!opts.version) throw new BadRequestException('informe a versão');
    const ins = await this.pool.query(
      `INSERT INTO deploy_executions
         (kind, source, sistema, componente, environment, version, previous_version,
          working_dir, envs, requested_by, status)
       VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,'[]'::jsonb,$8,'received') RETURNING id`,
      [
        kind, app.sistema, app.componente, app.environment,
        kind === 'deploy' ? opts.version : null, kind === 'rollback' ? opts.version : null,
        app.working_dir, userId,
      ],
    );
    const execId: string = ins.rows[0].id;
    await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$1 WHERE id=$1`, [execId]);
    this.runAdaptivePipeline(execId, app.server_id, app.working_dir, opts.version, [], kind, null)
      .catch((e) => this.logger.error(`pipeline manual ${execId}: ${e?.message}`));
    return { pipeline_id: execId, status: 'received' };
  }

  // ============================================================
  // Pipeline adaptativo: detecta compose vs script e aplica
  // ============================================================
  private async runAdaptivePipeline(
    execId: string, serverId: string, workingDir: string, version: string,
    envs: EnvChange[], kind: Kind, callbackUrl?: string | null,
  ) {
    const steps: { name: string; ok: boolean; output?: string }[] = [];
    const addStep = (name: string, ok: boolean, output?: string) =>
      steps.push({ name, ok, output: (output ?? '').slice(0, 8000) });
    let mode = '';
    await this.pool.query(`UPDATE deploy_executions SET status='running', started_at=now() WHERE id=$1`, [execId]);

    try {
      if (!this.ctrl.isOnline(serverId)) throw new Error('agent do servidor está offline');

      const ls = await this.ctrl.invoke<any>(serverId, 'fs.listDir', { path: workingDir })
        .catch((e) => { throw new Error(`não consegui listar ${workingDir}: ${e?.message ?? e}`); });
      const items = Array.isArray(ls?.items) ? ls.items : [];
      const files = new Set(items.filter((i: any) => i.type !== 'dir').map((i: any) => i.name));
      const composeName = COMPOSE_FILES.find((n) => files.has(n));
      const scriptName = SCRIPT_PRIORITY.find((n) => files.has(n))
        ?? items.filter((i: any) => i.type !== 'dir' && String(i.name).endsWith('.sh')).map((i: any) => i.name)[0];
      addStep(`inspecionar ${workingDir}`, true, `arquivos: ${items.map((i: any) => i.name).join(', ') || '(vazio)'}`);

      if (composeName) {
        mode = 'compose';
        const composePath = joinPath(workingDir, composeName);
        const envPath = joinPath(workingDir, '.env');
        if (envs.length) await this.upsertEnvFile(serverId, envPath, envs, addStep);
        await this.applyVersionCompose(serverId, composePath, envPath, version, addStep);
        // docker compose (v2) ou docker-compose (v1) — detecta na hora.
        const cmd =
          'if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi; ' +
          '$DC pull && $DC up -d';
        await this.runShellStep(serverId, workingDir, cmd, addStep);
      } else if (scriptName) {
        mode = 'script';
        const scriptPath = joinPath(workingDir, scriptName);
        const envObj: Record<string, string> = {};
        for (const e of envs) envObj[e.key] = e.value;
        const r = await this.ctrl.invoke<any>(
          serverId, 'fs.execute',
          { path: scriptPath, args: [version], cwd: workingDir, env: envObj, timeoutMs: EXEC_TIMEOUT_MS },
          { timeoutMs: EXEC_TIMEOUT_MS + 10_000 },
        );
        const out = `$ ${scriptName} ${version}\n${r.stdout ?? ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
        addStep(`executar ${scriptName} ${version}`, (r.exitCode ?? 0) === 0, out);
        if ((r.exitCode ?? 0) !== 0) throw new Error(`script saiu com código ${r.exitCode}`);
      } else {
        throw new Error(`nenhum docker-compose nem script .sh encontrado em ${workingDir}`);
      }

      const log = renderLog(steps);
      await this.pool.query(
        `UPDATE deploy_executions SET status='success', detected_mode=$2, steps=$3::jsonb, log=$4, completed_at=now() WHERE id=$1`,
        [execId, mode, JSON.stringify(steps), log],
      );
      await this.sendCallback(callbackUrl, execId, 'success', `${kind} concluído (versão ${version}, modo ${mode})`);
    } catch (e: any) {
      const log = renderLog(steps);
      await this.pool.query(
        `UPDATE deploy_executions SET status='error', detected_mode=$2, steps=$3::jsonb, log=$4, error_text=$5, completed_at=now() WHERE id=$1`,
        [execId, mode || null, JSON.stringify(steps), log, String(e?.message ?? e).slice(0, 4000)],
      );
      await this.sendCallback(callbackUrl, execId, 'error', String(e?.message ?? e));
    }
  }

  private async upsertEnvFile(
    serverId: string, path: string, envs: EnvChange[], addStep: (n: string, ok: boolean, o?: string) => void,
  ) {
    const before = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path }).catch(() => null);
    let content = before?.content ?? '';
    for (const { key, value } of envs) content = upsertEnvVar(content, key, value);
    await this.ctrl.invoke(serverId, 'fs.writeFile', { path, content });
    addStep(`aplicar ${envs.length} env(s) em ${path}`, true, envs.map((e) => `${e.key}=${e.value}`).join('\n'));
  }

  /** Aplica a versão no compose "adaptativamente": var de env na imagem, tag literal única, ou fallback TAG/VERSION. */
  private async applyVersionCompose(
    serverId: string, composePath: string, envPath: string, version: string,
    addStep: (n: string, ok: boolean, o?: string) => void,
  ) {
    const c = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path: composePath }).catch(() => null);
    if (!c) throw new Error(`não consegui ler ${composePath}`);
    const content: string = c.content ?? '';

    // 1) imagem usa uma variável na tag: image: repo:${VAR}  -> seta VAR no .env
    const mVar = content.match(/image:\s*["']?[\w./-]+:\$\{([A-Za-z0-9_]+)(?::-[^}]*)?\}/);
    if (mVar) {
      await this.upsertEnvFile(serverId, envPath, [{ key: mVar[1], value: version }], addStep);
      addStep(`versão via variável \${${mVar[1]}} do compose`, true);
      return;
    }

    // 2) tag literal e um único repositório -> reescreve a tag no compose
    const lits = [...content.matchAll(/image:\s*["']?([\w./-]+):([\w.\-]+)["']?/g)];
    const repos = new Set(lits.map((m) => m[1]));
    if (lits.length && repos.size === 1) {
      const repo = lits[0][1];
      const next = content.replace(new RegExp(`(${escapeRe(repo)}):[\\w.\\-]+`, 'g'), `$1:${version}`);
      await this.ctrl.invoke(serverId, 'fs.writeFile', { path: composePath, content: next });
      addStep(`ajustar imagem ${repo}:${version} em ${composePath}`, true);
      return;
    }

    // 3) fallback: variável de versão conhecida já presente no .env
    const envBefore = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path: envPath }).catch(() => null);
    const envContent: string = envBefore?.content ?? '';
    const known = ['TAG', 'VERSION', 'IMAGE_TAG', 'APP_VERSION'].find((v) =>
      new RegExp(`^\\s*(?:export\\s+)?${v}=`, 'm').test(envContent),
    );
    if (known) {
      await this.upsertEnvFile(serverId, envPath, [{ key: known, value: version }], addStep);
      addStep(`versão via variável ${known} do .env`, true);
      return;
    }

    throw new Error(
      `não identifiquei onde aplicar a versão em ${composePath}: sem image:\${VAR}, ` +
      `sem tag literal única e sem TAG/VERSION no .env. Ajuste o compose pra usar \${TAG} ou envie a versão como env.`,
    );
  }

  private async runShellStep(
    serverId: string, workingDir: string, cmd: string, addStep: (n: string, ok: boolean, o?: string) => void,
  ) {
    const full = `cd '${workingDir.replace(/'/g, `'\\''`)}' && ${cmd}`;
    const r = await this.ctrl.invoke<any>(
      serverId, 'fs.execute',
      { path: '/bin/sh', args: ['-c', full], timeoutMs: EXEC_TIMEOUT_MS },
      { timeoutMs: EXEC_TIMEOUT_MS + 10_000 },
    );
    const out = `$ ${cmd}\n${r.stdout ?? ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
    addStep('subir containers (docker compose up -d)', (r.exitCode ?? 0) === 0, out);
    if ((r.exitCode ?? 0) !== 0) throw new Error(`comando de deploy saiu com código ${r.exitCode}`);
  }

  // ============================================================
  // Callback ao SmartOne (volta)
  // ============================================================
  private async sendCallback(
    callbackUrl: string | null | undefined, execId: string, status: 'success' | 'error', message: string,
  ) {
    if (!callbackUrl) return;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'SmartWatch/1.0' };
      const tok = process.env.SMARTONE_CALLBACK_TOKEN;
      if (tok) headers['authorization'] = `Bearer ${tok}`;
      const body = JSON.stringify({ status, message, pipeline_id: execId, completed_at: new Date().toISOString() });
      const res = await request(callbackUrl, { method: 'POST', headers, body });
      await this.pool.query(`UPDATE deploy_executions SET callback_status=$2 WHERE id=$1`,
        [execId, `enviado (HTTP ${res.statusCode})`]);
    } catch (e: any) {
      await this.pool.query(`UPDATE deploy_executions SET callback_status=$2 WHERE id=$1`,
        [execId, `falha ao notificar: ${String(e?.message ?? e).slice(0, 300)}`]);
      this.logger.error(`callback ao SmartOne falhou (${execId}): ${e?.message}`);
    }
  }
}

// ---------- helpers ----------
interface NormPayload {
  event?: string; gmudId?: string; numeroProtocolo?: string;
  sistema?: string; componente?: string; ambiente?: string;
  servidor?: string; diretorio?: string; versao?: string; versaoAnterior?: string;
  callbackUrl?: string; envs: EnvChange[];
}

function normalizePayload(raw: any): NormPayload {
  const r = raw ?? {};
  return {
    event: r.event,
    gmudId: r.gmud_id ?? r.gmudId,
    numeroProtocolo: r.numero_protocolo ?? r.numeroProtocolo,
    sistema: r.sistema ?? r.aplicacao ?? r.application ?? r.app,
    componente: r.componente ?? r.component,
    ambiente: r.ambiente ?? r.environment ?? r.env,
    servidor: r.servidor ?? r.server ?? r.host ?? r.hostname,
    diretorio: r.diretorio ?? r.directory ?? r.dir ?? r.path ?? r.working_dir,
    versao: r.versao ?? r.version,
    versaoAnterior: r.versao_anterior ?? r.previousVersion ?? r.versaoAnterior,
    callbackUrl: r.callback_url ?? r.callbackUrl,
    envs: normalizeEnvs(r.envs ?? r.variaveis ?? r.env_changes ?? r.environmentVariables),
  };
}

function normalizeEnvs(raw: any): EnvChange[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((e: any) => ({
        key: String(e?.chave ?? e?.key ?? e?.name ?? e?.nome ?? '').trim(),
        value: String(e?.valor ?? e?.value ?? e?.val ?? ''),
      }))
      .filter((e) => e.key);
  }
  if (typeof raw === 'object') {
    return Object.entries(raw).map(([k, v]) => ({ key: k, value: String(v) })).filter((e) => e.key);
  }
  return [];
}

function joinPath(dir: string, p: string): string {
  if (p.startsWith('/')) return p;
  return `${dir.replace(/\/$/, '')}/${p}`;
}

function renderLog(steps: { name: string; ok: boolean; output?: string }[]): string {
  return steps.map((s) => `# ${s.ok ? 'OK' : 'ERRO'} · ${s.name}\n${s.output ?? ''}`).join('\n\n').slice(0, 200_000);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Substitui (ou adiciona) a linha `KEY=valor` num arquivo .env/.sh (upsert). */
function upsertEnvVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^(\\s*(?:export\\s+)?${escapeRe(key)}=).*$`, 'm');
  if (re.test(content)) return content.replace(re, `$1${value}`);
  const base = content === '' || content.endsWith('\n') ? content : content + '\n';
  return `${base}${key}=${value}\n`;
}
