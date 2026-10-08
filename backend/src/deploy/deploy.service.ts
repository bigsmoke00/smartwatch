import {
  BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { request } from 'undici';
import { PG_POOL } from '../db/db.module';
import { ControlGateway } from '../docker-manager/control.gateway';

/**
 * Módulo de CD — integração SmartOne × SmartGard.
 * Contrato: docs/integracao-smartone-smartgard.md (v1.0, lado SmartOne).
 *
 * Eventos (todos no mesmo POST /api/webhooks/smartone/gmud):
 *   test_connection         -> 2xx, não executa nada
 *   gmud_pipeline_preparar  -> valida cada componente no catálogo e chama o callback de ACEITE (accepted/rejected)
 *   gmud_execution_started  -> deploy de cada componente, um callback POR componente
 *   gmud_rollback_started   -> rollback de cada componente listado (pode ser parcial), um callback por componente
 *
 * O payload não traz servidor: o alvo sai do catálogo (deploy_apps), casado pelo componente_id do
 * SmartOne (ou, na falta dele, por sistema+componente).
 */

type Kind = 'deploy' | 'rollback' | 'prepare';
interface EnvChange { key: string; value: string }
type AddStep = (name: string, ok: boolean, output?: string) => void;

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
  smartone_component_id: string | null;
  script: string | null;
  env_mode: 'block' | 'script';
}

/** Componente normalizado a partir do item de `componentes`. */
interface ComponentJob {
  componentId: string | null;
  componente: string | null;
  sistema: string | null;
  path: string | null;
  script: string | null;
  envRequired: boolean;
  envDescription: string | null;
  version: string | null;
  callbackUrl: string | null;
}

interface Target {
  app: DeployApp;
  serverId: string;
  dir: string;
  script: string | null;
}

// Deploy pode demorar (docker pull de imagem grande). Obs.: o agent também limita
// por LOGWATCH_EXEC_TIMEOUT (default 120s) — ajuste no agent do servidor-alvo.
const EXEC_TIMEOUT_MS = parseInt(process.env.DEPLOY_EXEC_TIMEOUT_MS ?? '600000', 10);
const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SCRIPT_PRIORITY = ['deploy.sh', 'start.sh', 'up.sh', 'run.sh'];

// Versão é string livre (não é semver), mas vai parar em arquivo/argumento de shell:
// só caracteres seguros.
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
// Script é um nome de arquivo dentro do diretório (sem barra, sem ..).
const SCRIPT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// Variáveis que mudam o comportamento do shell/loader e virariam execução arbitrária.
const DANGEROUS_ENV = /^(LD_[A-Z_]+|BASH_ENV|ENV|BASH_FUNC_.*|PATH|IFS|PS4|SHELLOPTS|BASHOPTS|PROMPT_COMMAND|NODE_OPTIONS|PYTHONSTARTUP|PERL5OPT|LOGWATCH_.*)$/i;

// Reenvio de callback: só em 5xx / falha de rede (contrato, seção 7.3).
const CALLBACK_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
const CALLBACK_MAX_ATTEMPTS = CALLBACK_BACKOFF_MS.length + 1;

@Injectable()
export class DeployService implements OnApplicationBootstrap {
  private readonly logger = new Logger('DeployService');
  /** Uma execução por vez no mesmo servidor+diretório (evita duas GMUDs editando o mesmo .env). */
  private readonly locks = new Map<string, Promise<unknown>>();
  private callbackSweepRunning = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly ctrl: ControlGateway,
  ) {}

  // ============================================================
  // Boot: execuções órfãs (backend reiniciou no meio) viram erro + callback
  // ============================================================
  async onApplicationBootstrap() {
    try {
      const r = await this.pool.query(
        `SELECT id, kind, callback_url, pipeline_id FROM deploy_executions
          WHERE status IN ('received','running')`,
      );
      for (const e of r.rows) {
        const msg = 'Execução interrompida: o SmartGard reiniciou durante a pipeline. Refaça a ação.';
        await this.pool.query(
          `UPDATE deploy_executions SET status='error', error_text=$2, completed_at=now() WHERE id=$1`,
          [e.id, msg],
        );
        const body = e.kind === 'prepare'
          ? { status: 'rejected', message: msg, pipeline_id: e.pipeline_id }
          : { status: 'error', message: msg, pipeline_id: e.pipeline_id, completed_at: new Date().toISOString() };
        await this.queueCallback(e.id, e.callback_url, body);
      }
      if (r.rowCount) this.logger.warn(`${r.rowCount} execução(ões) órfã(s) marcada(s) como erro no boot`);
    } catch (e: any) {
      // tabela ainda não migrada / banco indisponível: não derruba o boot
      this.logger.error(`sweep de órfãs no boot falhou: ${e?.message}`);
    }
  }

  // ============================================================
  // CRUD de aplicações (catálogo)
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
    this.validateAppInput(input);
    const r = await this.pool.query(
      `INSERT INTO deploy_apps
         (name, sistema, componente, environment, server_id, working_dir, strategy, config, image_repo,
          created_by, smartone_component_id, script, env_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13) RETURNING *`,
      [
        input.name, input.sistema, input.componente, input.environment ?? 'production',
        input.serverId, normDir(input.workingDir), input.strategy ?? 'compose_env',
        JSON.stringify(input.config ?? {}), input.imageRepo ?? null, actorId,
        blankToNull(input.smartoneComponentId), blankToNull(input.script), input.envMode ?? 'block',
      ],
    ).catch((e) => { throw friendlyDbError(e); });
    return r.rows[0];
  }

  async updateApp(id: string, patch: any) {
    this.validateAppInput(patch);
    const map: Record<string, string> = {
      name: 'name', sistema: 'sistema', componente: 'componente', environment: 'environment',
      serverId: 'server_id', strategy: 'strategy', imageRepo: 'image_repo', enabled: 'enabled',
      envMode: 'env_mode',
    };
    const sets: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) { sets.push(`${col}=$${i++}`); params.push(patch[k]); }
    }
    if (patch.workingDir !== undefined) { sets.push(`working_dir=$${i++}`); params.push(normDir(patch.workingDir)); }
    if (patch.smartoneComponentId !== undefined) { sets.push(`smartone_component_id=$${i++}`); params.push(blankToNull(patch.smartoneComponentId)); }
    if (patch.script !== undefined) { sets.push(`script=$${i++}`); params.push(blankToNull(patch.script)); }
    if (patch.config !== undefined) { sets.push(`config=$${i++}::jsonb`); params.push(JSON.stringify(patch.config)); }
    if (!sets.length) return this.getApp(id);
    sets.push(`updated_at=now()`);
    params.push(id);
    const r = await this.pool.query(`UPDATE deploy_apps SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, params)
      .catch((e) => { throw friendlyDbError(e); });
    if (!r.rowCount) throw new NotFoundException('aplicação não encontrada');
    return r.rows[0];
  }

  private validateAppInput(input: any) {
    if (input.script != null && String(input.script).trim() && !SCRIPT_RE.test(String(input.script).trim())) {
      throw new BadRequestException('script inválido: informe só o nome do arquivo (ex.: unity.sh), sem caminho');
    }
    if (input.envMode != null && !['block', 'script'].includes(input.envMode)) {
      throw new BadRequestException('envMode deve ser "block" ou "script"');
    }
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
      `SELECT id, kind, source, gmud_id, numero_protocolo, sistema, componente, component_id, environment,
              version, previous_version, server_host, working_dir, script, detected_mode, status,
              pipeline_id, error_text, callback_status, callback_state, started_at, completed_at, created_at
       FROM deploy_executions ORDER BY created_at DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 500)],
    );
    return r.rows;
  }

  async getExecution(id: string) {
    const r = await this.pool.query(`SELECT * FROM deploy_executions WHERE id=$1`, [id]);
    if (!r.rowCount) throw new NotFoundException('execução não encontrada');
    // O token de uso único da callback_url permite fechar a GMUD no SmartOne: não expõe na tela.
    const row = r.rows[0];
    row.callback_url = maskToken(row.callback_url);
    delete row.callback_body;
    return row;
  }

  // ============================================================
  // Webhook do SmartOne (entrada única)
  // ============================================================
  async handleSmartOneWebhook(raw: any) {
    const event = String(raw?.event ?? '');

    if (event === 'test_connection') {
      return { ok: true, status: 'connected', sistema: 'SmartGard', received_at: new Date().toISOString() };
    }

    const known = ['gmud_pipeline_preparar', 'gmud_execution_started', 'gmud_rollback_started'];
    if (!known.includes(event)) {
      // Evento novo/desconhecido: confirma recebimento e não executa nada.
      return { ok: true, status: 'ignored', message: `evento "${event || '(vazio)'}" não tratado pelo SmartGard` };
    }

    if (Array.isArray(raw?.componentes)) {
      if (event === 'gmud_pipeline_preparar') return this.handlePrepare(raw);
      return this.handleRun(raw, event === 'gmud_rollback_started' ? 'rollback' : 'deploy');
    }

    // Formato antigo (payload plano com servidor/diretorio livres). Permite rodar .sh em
    // QUALQUER diretório liberado de QUALQUER servidor só com o token, então fica DESLIGADO
    // por padrão. Habilite só para teste manual: DEPLOY_LEGACY_WEBHOOK=true.
    if (process.env.DEPLOY_LEGACY_WEBHOOK !== 'true') {
      return {
        ok: false, status: 'error',
        message: 'payload sem "componentes": o formato antigo (servidor/diretorio) está desativado neste SmartGard',
      };
    }
    if (event === 'gmud_pipeline_preparar') {
      return { ok: true, status: 'ignored', message: 'preparação exige o array "componentes"' };
    }
    return this.handleLegacy(raw);
  }

  // ------------------------------------------------------------ preparar
  private async handlePrepare(raw: any) {
    const gmud = gmudMeta(raw);
    const comps = (raw.componentes as any[]).map((c) => normComponent(c, 'prepare'));
    const callbackUrl = safeUrl(raw.callback_url);

    const ins = await this.pool.query(
      `INSERT INTO deploy_executions
         (kind, source, gmud_id, numero_protocolo, sistema, componente, callback_url, status)
       VALUES ('prepare','smartone',$1,$2,$3,$4,$5,'received')
       ON CONFLICT (callback_url) WHERE callback_url IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        gmud.gmudId, gmud.protocolo, uniqJoin(comps.map((c) => c.sistema)),
        `${comps.length} componente(s)`, callbackUrl,
      ],
    );
    if (!ins.rowCount) {
      return { ok: true, status: 'duplicate', message: 'preparação já recebida para esta callback_url' };
    }
    const execId: string = ins.rows[0].id;
    const pipelineId = shortId(execId);
    await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$2 WHERE id=$1`, [execId, pipelineId]);

    this.runPrepare(execId, pipelineId, comps, callbackUrl)
      .catch((e) => this.logger.error(`preparação ${execId}: ${e?.message}`));
    return { ok: true, status: 'received', pipeline_id: pipelineId, componentes: comps.length };
  }

  private async runPrepare(execId: string, pipelineId: string, comps: ComponentJob[], callbackUrl: string | null) {
    const steps: { name: string; ok: boolean; output?: string }[] = [];
    const problems: string[] = [];
    await this.pool.query(`UPDATE deploy_executions SET status='running', started_at=now() WHERE id=$1`, [execId]);

    for (const c of comps) {
      const label = `${c.componente ?? '?'}${c.componentId ? ` (${c.componentId})` : ''}`;
      try {
        const t = await this.resolveTarget(c);
        const problem = await this.checkTarget(t, c, 'deploy');
        if (problem) throw new Error(problem);
        steps.push({
          name: `${label}: ok`, ok: true,
          output: `servidor ${t.app.name} · ${t.dir} · ${t.script ? `script ${t.script}` : 'detecção automática'} · versão ${c.version ?? '?'}`,
        });
      } catch (e: any) {
        problems.push(`Componente '${c.componente ?? '?'}'${c.componentId ? ` (${c.componentId})` : ''}: ${e?.message ?? e}`);
        steps.push({ name: `${label}: recusado`, ok: false, output: String(e?.message ?? e) });
      }
    }

    const accepted = problems.length === 0;
    const message = accepted
      ? `Pipeline preparada: ${comps.length} componente(s) validado(s) no SmartGard.`
      : problems.join(' | ').slice(0, 2000);
    await this.pool.query(
      `UPDATE deploy_executions SET status=$2, steps=$3::jsonb, log=$4, error_text=$5, completed_at=now() WHERE id=$1`,
      [execId, accepted ? 'success' : 'error', JSON.stringify(steps), renderLog(steps), accepted ? null : message],
    );
    await this.queueCallback(execId, callbackUrl, {
      status: accepted ? 'accepted' : 'rejected', message, pipeline_id: pipelineId,
    });
  }

  // ------------------------------------------------------------ execução / rollback
  private async handleRun(raw: any, kind: 'deploy' | 'rollback') {
    const gmud = gmudMeta(raw);
    const comps = (raw.componentes as any[]).map((c) => normComponent(c, kind));
    const accepted: { componente_id: string | null; componente: string | null; pipeline_id: string; execId: string; job: ComponentJob }[] = [];
    const duplicates: string[] = [];

    for (const c of comps) {
      const ins = await this.pool.query(
        `INSERT INTO deploy_executions
           (kind, source, gmud_id, numero_protocolo, sistema, componente, component_id,
            version, previous_version, callback_url, working_dir, script, env_description, envs, status)
         VALUES ($1,'smartone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'[]'::jsonb,'received')
         ON CONFLICT (callback_url) WHERE callback_url IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          kind, gmud.gmudId, gmud.protocolo, c.sistema, c.componente, c.componentId,
          kind === 'deploy' ? c.version : null, kind === 'rollback' ? c.version : null,
          c.callbackUrl, c.path, c.script, c.envDescription,
        ],
      );
      if (!ins.rowCount) { duplicates.push(c.componente ?? c.componentId ?? '?'); continue; }
      const execId: string = ins.rows[0].id;
      const pipelineId = shortId(execId);
      await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$2 WHERE id=$1`, [execId, pipelineId]);
      accepted.push({ componente_id: c.componentId, componente: c.componente, pipeline_id: pipelineId, execId, job: c });
    }

    // Componentes da mesma GMUD rodam em sequência, na ordem em que vieram.
    (async () => {
      for (const a of accepted) {
        await this.runComponent(a.execId, a.pipeline_id, a.job, kind, gmud)
          .catch((e) => this.logger.error(`componente ${a.execId}: ${e?.message}`));
      }
    })();

    return {
      ok: true,
      status: 'received',
      pipelines: accepted.map((a) => ({ componente_id: a.componente_id, componente: a.componente, pipeline_id: a.pipeline_id })),
      ...(duplicates.length ? { duplicados: duplicates } : {}),
    };
  }

  private async runComponent(
    execId: string, pipelineId: string, c: ComponentJob, kind: 'deploy' | 'rollback', gmud: GmudMeta,
  ) {
    const steps: { name: string; ok: boolean; output?: string }[] = [];
    const addStep: AddStep = (name, ok, output) => steps.push({ name, ok, output: (output ?? '').slice(0, 8000) });
    const t0 = Date.now();
    let mode = '';
    await this.pool.query(`UPDATE deploy_executions SET status='running', started_at=now() WHERE id=$1`, [execId]);

    try {
      const t = await this.resolveTarget(c);
      await this.pool.query(
        `UPDATE deploy_executions SET app_id=$2, server_host=$3, working_dir=$4, script=$5, environment=$6 WHERE id=$1`,
        [execId, t.app.id, t.app.name, t.dir, t.script, t.app.environment],
      );
      const problem = await this.checkTarget(t, c, kind);
      if (problem) throw new Error(problem);

      const extraEnv: Record<string, string> = {
        GMUD_ID: gmud.gmudId ?? '',
        GMUD_PROTOCOLO: gmud.protocolo ?? '',
        GMUD_ACTION: kind,
        COMPONENTE: c.componente ?? '',
        COMPONENTE_ID: c.componentId ?? '',
        VERSAO: c.version ?? '',
        ...(c.envRequired && c.envDescription ? { GMUD_ENV_DESCRIPTION: c.envDescription } : {}),
      };

      mode = await this.withLock(`${t.serverId}|${t.dir}`, () =>
        this.executeInDir(t.serverId, t.dir, c.version as string, [], addStep, {
          forcedScript: t.script, extraEnv,
        }),
      );

      const secs = Math.round((Date.now() - t0) / 1000);
      const what = kind === 'rollback' ? 'Rollback concluído' : 'Deploy concluído';
      const message = `${what}: ${c.componente} ${c.version} (${mode === 'script' ? `script ${t.script ?? ''}` : 'docker compose'}, ${secs}s).`;
      await this.finish(execId, 'success', mode, steps, null);
      await this.queueCallback(execId, c.callbackUrl, {
        status: 'success', message, pipeline_id: pipelineId, completed_at: new Date().toISOString(),
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 2000);
      await this.finish(execId, 'error', mode, steps, msg);
      await this.queueCallback(execId, c.callbackUrl, {
        status: 'error', message: `${c.componente ?? 'Componente'}: ${msg}`, pipeline_id: pipelineId,
        completed_at: new Date().toISOString(),
      });
    }
  }

  /** Acha o alvo no catálogo: componente_id do SmartOne > sistema+componente. */
  private async resolveTarget(c: ComponentJob): Promise<Target> {
    let app: DeployApp | null = null;
    if (c.componentId) {
      const r = await this.pool.query(
        `SELECT * FROM deploy_apps WHERE smartone_component_id=$1 LIMIT 1`, [c.componentId],
      );
      app = r.rows[0] ?? null;
    }
    if (!app && c.componente) {
      const r = await this.pool.query(
        `SELECT * FROM deploy_apps
          WHERE lower(componente)=lower($1) AND ($2::text IS NULL OR lower(sistema)=lower($2))`,
        [c.componente, c.sistema],
      );
      if (r.rowCount && r.rowCount > 1) {
        throw new Error(
          `há ${r.rowCount} cadastros para '${c.sistema}/${c.componente}' no SmartGard; informe o componente_id no cadastro para desambiguar`,
        );
      }
      app = r.rows[0] ?? null;
    }
    if (!app) throw new Error('não cadastrado no catálogo de Deploys do SmartGard');
    if (!app.enabled) throw new Error(`cadastro "${app.name}" está desativado no SmartGard`);

    const dir = normDir(app.working_dir);
    if (c.path && normDir(c.path) !== dir) {
      throw new Error(`diretório divergente: SmartOne enviou "${c.path}", o cadastro do SmartGard tem "${dir}"`);
    }
    // O script do cadastro manda: o SmartOne não pode trocar por outro arquivo do diretório.
    if (app.script && c.script && c.script !== app.script) {
      throw new Error(`script divergente: SmartOne enviou "${c.script}", o cadastro do SmartGard usa "${app.script}"`);
    }
    const script = app.script ?? c.script ?? null;
    if (script && !SCRIPT_RE.test(script)) throw new Error(`nome de script inválido: "${script}"`);
    return { app, serverId: app.server_id, dir, script };
  }

  /** Validações que não executam nada: versão, envs, agent, diretório, script. */
  private async checkTarget(t: Target, c: ComponentJob, kind: 'deploy' | 'rollback'): Promise<string | null> {
    if (!c.version) return kind === 'rollback' ? 'payload sem versao_anterior' : 'payload sem versão';
    if (!VERSION_RE.test(c.version)) return `versão com caracteres não suportados: "${c.version.slice(0, 60)}"`;
    if (c.envRequired && t.app.env_mode === 'block') {
      return `exige alteração de configuração que o SmartGard não aplica automaticamente (${(c.envDescription ?? 'sem descrição').slice(0, 300)}). ` +
        `Aplique manualmente e/ou configure o componente como "script aplica" no SmartGard.`;
    }
    if (!this.ctrl.isOnline(t.serverId)) return `agent do servidor "${t.app.name}" está offline`;
    const ls = await this.ctrl.invoke<any>(t.serverId, 'fs.listDir', { path: t.dir }).catch((e) => ({ error: e }));
    if ((ls as any)?.error) return `não consegui acessar ${t.dir} no servidor: ${(ls as any).error?.message ?? (ls as any).error}`;
    const files = new Set<string>(
      (Array.isArray((ls as any)?.items) ? (ls as any).items : []).filter((i: any) => i.type !== 'dir').map((i: any) => i.name),
    );
    if (t.script) {
      if (!files.has(t.script)) return `script "${t.script}" não encontrado em ${t.dir}`;
    } else if (!COMPOSE_FILES.some((n) => files.has(n)) && ![...files].some((n) => n.endsWith('.sh'))) {
      return `nenhum docker-compose nem script .sh em ${t.dir}`;
    }
    return null;
  }

  // ============================================================
  // Formato antigo (payload plano) — usado no smoke test manual
  // ============================================================
  private async handleLegacy(raw: any) {
    const p = normalizePayload(raw);
    const kind: 'deploy' | 'rollback' = p.event === 'gmud_rollback_started' ? 'rollback' : 'deploy';
    const version = kind === 'rollback' ? (p.versaoAnterior ?? p.versao) : p.versao;
    const server = p.servidor ? await this.resolveServerByHost(p.servidor) : null;
    const callbackUrl = safeUrl(p.callbackUrl);

    const ins = await this.pool.query(
      `INSERT INTO deploy_executions
         (kind, source, gmud_id, numero_protocolo, sistema, componente, environment,
          version, previous_version, callback_url, server_host, working_dir, envs, status)
       VALUES ($1,'smartone',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'received')
       ON CONFLICT (callback_url) WHERE callback_url IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        kind, p.gmudId ?? null, p.numeroProtocolo ?? null, p.sistema ?? null, p.componente ?? null,
        p.ambiente ?? null, kind === 'deploy' ? version : null, kind === 'rollback' ? version : null,
        callbackUrl, p.servidor ?? null, p.diretorio ?? null,
        JSON.stringify(p.envs.map((e) => ({ key: e.key, value: maskValue(e.key, e.value) }))),
      ],
    );
    if (!ins.rowCount) return { ok: true, status: 'duplicate', message: 'evento já recebido para esta callback_url' };
    const execId: string = ins.rows[0].id;
    const pipelineId = shortId(execId);
    await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$2 WHERE id=$1`, [execId, pipelineId]);

    const fail = async (message: string) => {
      await this.finish(execId, 'error', '', [], message);
      await this.queueCallback(execId, callbackUrl, { status: 'error', message, pipeline_id: pipelineId, completed_at: new Date().toISOString() });
      return { ok: false, pipeline_id: pipelineId, status: 'error', message };
    };
    if (!p.servidor) return fail('payload sem "servidor"');
    if (!server) return fail(`servidor "${p.servidor}" não encontrado no SmartGard`);
    if (!p.diretorio) return fail('payload sem "diretorio"');
    if (!version) return fail('payload sem versão');
    if (!VERSION_RE.test(version)) return fail(`versão com caracteres não suportados: "${version.slice(0, 60)}"`);
    const badEnv = p.envs.find((e) => !ENV_KEY_RE.test(e.key) || /[\r\n\0]/.test(e.value) || DANGEROUS_ENV.test(e.key));
    if (badEnv) return fail(`env inválida: "${badEnv.key.slice(0, 60)}" (chave fora do padrão ou valor com quebra de linha)`);

    this.runLegacy(execId, pipelineId, server.id, normDir(p.diretorio), version, p.envs, kind, callbackUrl)
      .catch((e) => this.logger.error(`pipeline ${execId}: ${e?.message}`));
    return { ok: true, pipeline_id: pipelineId, status: 'received', server: server.name };
  }

  private async runLegacy(
    execId: string, pipelineId: string, serverId: string, dir: string, version: string,
    envs: EnvChange[], kind: 'deploy' | 'rollback', callbackUrl: string | null,
  ) {
    const steps: { name: string; ok: boolean; output?: string }[] = [];
    const addStep: AddStep = (name, ok, output) => steps.push({ name, ok, output: (output ?? '').slice(0, 8000) });
    let mode = '';
    await this.pool.query(`UPDATE deploy_executions SET status='running', started_at=now() WHERE id=$1`, [execId]);
    try {
      if (!this.ctrl.isOnline(serverId)) throw new Error('agent do servidor está offline');
      mode = await this.withLock(`${serverId}|${dir}`, () => this.executeInDir(serverId, dir, version, envs, addStep, {}));
      await this.finish(execId, 'success', mode, steps, null);
      await this.queueCallback(execId, callbackUrl, {
        status: 'success', message: `${kind} concluído (versão ${version}, modo ${mode})`,
        pipeline_id: pipelineId, completed_at: new Date().toISOString(),
      });
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 2000);
      await this.finish(execId, 'error', mode, steps, msg);
      await this.queueCallback(execId, callbackUrl, { status: 'error', message: msg, pipeline_id: pipelineId, completed_at: new Date().toISOString() });
    }
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
  // Disparo manual (frontend) — usa o cadastro
  // ============================================================
  async triggerManual(appId: string, opts: { version: string; kind?: 'deploy' | 'rollback' }, userId: string) {
    const app = await this.getApp(appId);
    if (!app.enabled) throw new BadRequestException('cadastro desativado: ative antes de disparar');
    const kind = opts.kind ?? 'deploy';
    const version = String(opts.version ?? '').trim();
    if (!version) throw new BadRequestException('informe a versão');
    if (!VERSION_RE.test(version)) throw new BadRequestException('versão com caracteres não suportados');
    const ins = await this.pool.query(
      `INSERT INTO deploy_executions
         (kind, source, app_id, sistema, componente, component_id, environment, version, previous_version,
          server_host, working_dir, script, envs, requested_by, status)
       VALUES ($1,'manual',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]'::jsonb,$12,'received') RETURNING id`,
      [
        kind, app.id, app.sistema, app.componente, app.smartone_component_id, app.environment,
        kind === 'deploy' ? version : null, kind === 'rollback' ? version : null,
        app.name, normDir(app.working_dir), app.script, userId,
      ],
    );
    const execId: string = ins.rows[0].id;
    const pipelineId = shortId(execId);
    await this.pool.query(`UPDATE deploy_executions SET pipeline_id=$2 WHERE id=$1`, [execId, pipelineId]);

    (async () => {
      const steps: { name: string; ok: boolean; output?: string }[] = [];
      const addStep: AddStep = (name, ok, output) => steps.push({ name, ok, output: (output ?? '').slice(0, 8000) });
      let mode = '';
      await this.pool.query(`UPDATE deploy_executions SET status='running', started_at=now() WHERE id=$1`, [execId]);
      try {
        if (!this.ctrl.isOnline(app.server_id)) throw new Error('agent do servidor está offline');
        const dir = normDir(app.working_dir);
        mode = await this.withLock(`${app.server_id}|${dir}`, () =>
          this.executeInDir(app.server_id, dir, version, [], addStep, {
            forcedScript: app.script,
            extraEnv: { GMUD_ACTION: kind, COMPONENTE: app.componente, VERSAO: version },
          }),
        );
        await this.finish(execId, 'success', mode, steps, null);
      } catch (e: any) {
        await this.finish(execId, 'error', mode, steps, String(e?.message ?? e).slice(0, 2000));
      }
    })().catch((e) => this.logger.error(`pipeline manual ${execId}: ${e?.message}`));
    return { pipeline_id: pipelineId, status: 'received' };
  }

  // ============================================================
  // Execução no host (via agent)
  // ============================================================
  /**
   * Roda o deploy num diretório. Com `forcedScript`, executa esse script (versão como 1º argumento).
   * Sem ele, detecta: compose (aplica versão + up -d + checa containers) ou o .sh do diretório.
   * Retorna o modo usado ('script' | 'compose'); lança erro com mensagem clara em falha.
   */
  private async executeInDir(
    serverId: string, dir: string, version: string, envs: EnvChange[], addStep: AddStep,
    opts: { forcedScript?: string | null; extraEnv?: Record<string, string> },
  ): Promise<'script' | 'compose'> {
    const ls = await this.ctrl.invoke<any>(serverId, 'fs.listDir', { path: dir })
      .catch((e) => { throw new Error(`não consegui listar ${dir}: ${e?.message ?? e}`); });
    const items = Array.isArray(ls?.items) ? ls.items : [];
    const files = new Set<string>(items.filter((i: any) => i.type !== 'dir').map((i: any) => i.name));
    addStep(`inspecionar ${dir}`, true, `arquivos: ${items.map((i: any) => i.name).join(', ') || '(vazio)'}`);

    const envObj: Record<string, string> = { ...(opts.extraEnv ?? {}) };
    for (const e of envs) envObj[e.key] = e.value;

    const runScript = async (scriptName: string) => {
      const scriptPath = joinPath(dir, scriptName);
      let r = await this.exec(serverId, scriptPath, [version], dir, envObj);
      // Sem permissão de execução (+x): no modo chroot do agent vem 126; no modo direto o spawn
      // falha com EACCES (exitCode -1). Nos dois casos tenta via bash.
      if (r.exitCode === 126 || (r.exitCode === -1 && /EACCES|Permission denied/i.test(r.stderr))) {
        addStep(`${scriptName} sem permissão de execução, tentando via bash`, true, r.stderr);
        r = await this.exec(serverId, '/bin/bash', [scriptPath, version], dir, envObj);
      }
      const out = `$ ${scriptName} ${version}\n${r.stdout ?? ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
      addStep(`executar ${scriptName} ${version}`, r.exitCode === 0, out);
      if (r.exitCode === 124) throw new Error(`${scriptName} excedeu o tempo limite (verifique LOGWATCH_EXEC_TIMEOUT no agent)`);
      if (r.exitCode !== 0) throw new Error(`${scriptName} saiu com código ${r.exitCode}${lastLine(r.stderr || r.stdout)}`);
    };

    if (opts.forcedScript) {
      if (!files.has(opts.forcedScript)) throw new Error(`script "${opts.forcedScript}" não encontrado em ${dir}`);
      await runScript(opts.forcedScript);
      return 'script';
    }

    const composeName = COMPOSE_FILES.find((n) => files.has(n));
    if (composeName) {
      const composePath = joinPath(dir, composeName);
      const envPath = joinPath(dir, '.env');
      if (envs.length) await this.upsertEnvFile(serverId, envPath, envs, addStep);
      await this.applyVersionCompose(serverId, composePath, envPath, version, addStep);
      const cmd =
        'if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi; ' +
        '$DC pull && $DC up -d && sleep 5 && $DC ps';
      const r = await this.exec(serverId, '/bin/sh', ['-c', `cd ${shq(dir)} && ${cmd}`], undefined, envObj);
      const out = `$ docker compose pull && up -d && ps\n${r.stdout ?? ''}${r.stderr ? '\n[stderr]\n' + r.stderr : ''}`;
      addStep('subir containers (docker compose up -d)', r.exitCode === 0, out);
      if (r.exitCode === 124) throw new Error('docker compose excedeu o tempo limite (verifique LOGWATCH_EXEC_TIMEOUT no agent)');
      if (r.exitCode !== 0) throw new Error(`docker compose saiu com código ${r.exitCode}${lastLine(r.stderr || r.stdout)}`);
      // Health check simples: nenhum container parado/reiniciando/unhealthy após o up.
      const bad = (r.stdout ?? '').split('\n').filter((l: string) => /\b(Exit(ed)?|Restarting|unhealthy|Dead)\b/i.test(l));
      if (bad.length) throw new Error(`containers não ficaram saudáveis após o deploy: ${bad.map((l: string) => l.trim()).join(' | ').slice(0, 400)}`);
      addStep('health check (docker compose ps)', true, 'todos os containers em execução');
      return 'compose';
    }

    const scriptName = SCRIPT_PRIORITY.find((n) => files.has(n)) ?? [...files].find((n) => n.endsWith('.sh'));
    if (scriptName) {
      await runScript(scriptName);
      return 'script';
    }
    throw new Error(`nenhum docker-compose nem script .sh encontrado em ${dir}`);
  }

  private async exec(
    serverId: string, path: string, args: string[], cwd: string | undefined, env: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const r = await this.ctrl.invoke<any>(
      serverId, 'fs.execute',
      { path, args, ...(cwd ? { cwd } : {}), env, timeoutMs: EXEC_TIMEOUT_MS },
      { timeoutMs: EXEC_TIMEOUT_MS + 15_000 },
    );
    return { exitCode: r?.exitCode ?? -1, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  }

  private async upsertEnvFile(serverId: string, path: string, envs: EnvChange[], addStep: AddStep) {
    const before = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path }).catch(() => null);
    let content = before?.content ?? '';
    if (before) await this.backup(serverId, path, content, addStep);
    for (const { key, value } of envs) content = upsertEnvVar(content, key, value);
    await this.ctrl.invoke(serverId, 'fs.writeFile', { path, content });
    // Valores mascarados no log (podem ser segredos).
    addStep(`aplicar ${envs.length} env(s) em ${path}`, true, envs.map((e) => `${e.key}=${maskValue(e.key, e.value)}`).join('\n'));
  }

  /** Guarda a versão anterior do arquivo em <arquivo>.smartgard.bak antes de alterar. */
  private async backup(serverId: string, path: string, content: string, addStep: AddStep) {
    await this.ctrl.invoke(serverId, 'fs.writeFile', { path: `${path}.smartgard.bak`, content })
      .then(() => addStep(`backup ${path} -> ${path}.smartgard.bak`, true))
      .catch((e) => addStep(`backup de ${path} falhou (seguindo)`, true, String(e?.message ?? e)));
  }

  /** Aplica a versão no compose: var de env na imagem, tag literal única, ou fallback TAG/VERSION. */
  private async applyVersionCompose(
    serverId: string, composePath: string, envPath: string, version: string, addStep: AddStep,
  ) {
    const c = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path: composePath }).catch(() => null);
    if (!c) throw new Error(`não consegui ler ${composePath}`);
    const content: string = c.content ?? '';

    const mVar = content.match(/image:\s*["']?[\w./-]+:\$\{([A-Za-z0-9_]+)(?::-[^}]*)?\}/);
    if (mVar) {
      await this.upsertEnvFile(serverId, envPath, [{ key: mVar[1], value: version }], addStep);
      addStep(`versão via variável \${${mVar[1]}} do compose`, true);
      return;
    }

    const lits = [...content.matchAll(/image:\s*["']?([\w./-]+):([\w.\-]+)["']?/g)];
    const repos = new Set(lits.map((m) => m[1]));
    if (lits.length && repos.size === 1) {
      const repo = lits[0][1];
      await this.backup(serverId, composePath, content, addStep);
      const next = content.replace(new RegExp(`(${escapeRe(repo)}):[\\w.\\-]+`, 'g'), `$1:${version}`);
      await this.ctrl.invoke(serverId, 'fs.writeFile', { path: composePath, content: next });
      addStep(`ajustar imagem ${repo}:${version} em ${composePath}`, true);
      return;
    }

    const envBefore = await this.ctrl.invoke<any>(serverId, 'fs.readFile', { path: envPath }).catch(() => null);
    const envContent: string = envBefore?.content ?? '';
    const known = ['TAG', 'VERSION', 'IMAGE_TAG', 'APP_VERSION'].find((v) =>
      new RegExp(`^\\s*(?:export\\s+)?${escapeRe(v)}=`, 'm').test(envContent),
    );
    if (known) {
      await this.upsertEnvFile(serverId, envPath, [{ key: known, value: version }], addStep);
      addStep(`versão via variável ${known} do .env`, true);
      return;
    }

    throw new Error(
      `não identifiquei onde aplicar a versão em ${composePath}: sem image:\${VAR}, ` +
      `sem tag literal única e sem TAG/VERSION no .env. Ajuste o compose pra usar \${TAG} ou use um script.`,
    );
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async finish(
    execId: string, status: 'success' | 'error', mode: string,
    steps: { name: string; ok: boolean; output?: string }[], errorText: string | null,
  ) {
    await this.pool.query(
      `UPDATE deploy_executions
          SET status=$2, detected_mode=$3, steps=$4::jsonb, log=$5, error_text=$6, completed_at=now()
        WHERE id=$1`,
      [execId, status, mode || null, JSON.stringify(steps), renderLog(steps), errorText],
    );
  }

  // ============================================================
  // Callback ao SmartOne — regras da seção 7.3 do contrato
  //   2xx -> feito | 404 -> já registrado (feito, não repetir) | 400/4xx -> não repetir
  //   5xx / falha de rede -> repete com backoff (15s, 1m, 5m, 15m, 30m)
  // ============================================================
  private async queueCallback(execId: string, callbackUrl: string | null | undefined, body: any) {
    if (!callbackUrl) {
      await this.pool.query(`UPDATE deploy_executions SET callback_status='sem callback_url' WHERE id=$1`, [execId]);
      return;
    }
    await this.pool.query(
      `UPDATE deploy_executions
          SET callback_body=$2::jsonb, callback_state='pending', callback_attempts=0, callback_next_at=now()
        WHERE id=$1`,
      [execId, JSON.stringify(body)],
    );
    await this.attemptCallback(execId);
  }

  private async attemptCallback(execId: string) {
    const r = await this.pool.query(
      `UPDATE deploy_executions SET callback_next_at = now() + interval '10 minutes'
        WHERE id=$1 AND callback_state='pending'
        RETURNING callback_url, callback_body, callback_attempts`,
      [execId],
    );
    const row = r.rows[0];
    if (!row) return;
    const attempt = (row.callback_attempts ?? 0) + 1;
    let statusCode = 0;
    let resp = '';
    let netErr: string | null = null;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'SmartGard/1.0' };
      const tok = process.env.SMARTONE_CALLBACK_TOKEN;
      if (tok) headers['authorization'] = `Bearer ${tok}`;
      const res = await request(row.callback_url, {
        method: 'POST', headers, body: JSON.stringify(row.callback_body),
        headersTimeout: 20_000, bodyTimeout: 20_000,
      });
      statusCode = res.statusCode;
      resp = (await res.body.text().catch(() => '')).slice(0, 300);
    } catch (e: any) {
      netErr = String(e?.message ?? e).slice(0, 300);
    }

    let state: 'done' | 'failed' | 'pending';
    let label: string;
    if (!netErr && statusCode >= 200 && statusCode < 300) {
      state = 'done'; label = `enviado (HTTP ${statusCode})`;
    } else if (statusCode === 404) {
      state = 'done'; label = `já registrado pelo SmartOne (HTTP 404: ${resp})`;
    } else if (!netErr && statusCode >= 400 && statusCode < 500) {
      state = 'failed'; label = `recusado pelo SmartOne (HTTP ${statusCode}: ${resp})`;
    } else if (attempt >= CALLBACK_MAX_ATTEMPTS) {
      state = 'failed'; label = `falhou após ${attempt} tentativas (${netErr ?? `HTTP ${statusCode}: ${resp}`})`;
    } else {
      state = 'pending'; label = `tentativa ${attempt} falhou (${netErr ?? `HTTP ${statusCode}`}); nova tentativa agendada`;
    }

    const delay = CALLBACK_BACKOFF_MS[Math.min(attempt - 1, CALLBACK_BACKOFF_MS.length - 1)];
    await this.pool.query(
      `UPDATE deploy_executions
          SET callback_state=$2, callback_status=$3, callback_attempts=$4,
              callback_next_at = CASE WHEN $2='pending' THEN now() + ($5 || ' milliseconds')::interval ELSE NULL END
        WHERE id=$1`,
      [execId, state, label, attempt, String(delay)],
    );
    if (state === 'failed') this.logger.error(`callback ${execId}: ${label}`);
  }

  /** Reenvia callbacks pendentes (inclusive após restart do backend). */
  @Cron('*/15 * * * * *')
  async retryPendingCallbacks() {
    if (this.callbackSweepRunning) return;
    this.callbackSweepRunning = true;
    try {
      const r = await this.pool.query(
        `SELECT id FROM deploy_executions
          WHERE callback_state='pending' AND callback_next_at <= now()
          ORDER BY callback_next_at LIMIT 20`,
      );
      for (const row of r.rows) await this.attemptCallback(row.id).catch(() => undefined);
    } catch {
      /* banco indisponível / tabela não migrada: tenta no próximo ciclo */
    } finally {
      this.callbackSweepRunning = false;
    }
  }
}

// ---------- helpers ----------
interface GmudMeta { gmudId: string | null; protocolo: string | null; titulo: string | null }

function gmudMeta(raw: any): GmudMeta {
  return {
    gmudId: str(raw?.gmud_id),
    protocolo: str(raw?.numero_protocolo),
    titulo: str(raw?.titulo),
  };
}

function normComponent(c: any, kind: Kind): ComponentJob {
  const version = kind === 'rollback'
    ? str(c?.versao_anterior) ?? str(c?.versao)
    : kind === 'prepare'
      ? str(c?.versao_alvo) ?? str(c?.versao)
      : str(c?.versao) ?? str(c?.versao_alvo);
  return {
    componentId: str(c?.componente_id),
    componente: str(c?.componente),
    sistema: str(c?.sistema),
    path: str(c?.path),
    script: str(c?.script),
    envRequired: c?.env_variables_required === true,
    envDescription: str(c?.env_variables_description),
    version,
    callbackUrl: safeUrl(c?.callback_url),
  };
}

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

function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function blankToNull(v: any): string | null {
  return str(v);
}

/** Só aceita http(s) — a URL é usada exatamente como veio (já traz o token de uso único). */
function safeUrl(v: any): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? s : null;
  } catch {
    return null;
  }
}

function normDir(d: string): string {
  const s = String(d ?? '').trim();
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

function joinPath(dir: string, p: string): string {
  if (p.startsWith('/')) return p;
  return `${dir.replace(/\/$/, '')}/${p}`;
}

function shortId(uuid: string): string {
  return `SG-${uuid.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

function uniqJoin(xs: (string | null)[]): string | null {
  const s = Array.from(new Set(xs.filter(Boolean) as string[]));
  return s.length ? s.join(', ') : null;
}

function renderLog(steps: { name: string; ok: boolean; output?: string }[]): string {
  return steps.map((s) => `# ${s.ok ? 'OK' : 'ERRO'} · ${s.name}\n${s.output ?? ''}`).join('\n\n').slice(0, 200_000);
}

function lastLine(s: string): string {
  const l = (s ?? '').trim().split('\n').filter(Boolean).pop();
  return l ? `: ${l.slice(0, 300)}` : '';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shq(v: string): string {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

/** Mascara valores com cara de segredo no log/histórico. */
function maskValue(key: string, value: string): string {
  if (/(pass|secret|token|key|senha|credential|auth)/i.test(key)) return '********';
  return value.length > 80 ? `${value.slice(0, 20)}…(${value.length} chars)` : value;
}

/** Substitui (ou adiciona) a linha `KEY=valor` num arquivo .env (upsert). */
function upsertEnvVar(content: string, key: string, value: string): string {
  const re = new RegExp(`^(\\s*(?:export\\s+)?${escapeRe(key)}=).*$`, 'm');
  if (re.test(content)) return content.replace(re, (_m, p1) => `${p1}${value}`);
  const base = content === '' || content.endsWith('\n') ? content : content + '\n';
  return `${base}${key}=${value}\n`;
}

function friendlyDbError(e: any): Error {
  if (e?.code === '23505') {
    if (String(e?.constraint ?? '').includes('smartone_component')) {
      return new BadRequestException('esse componente_id do SmartOne já está em outro cadastro');
    }
    return new BadRequestException('já existe um cadastro com esse sistema + componente + ambiente');
  }
  return e;
}

function maskToken(url: string | null): string | null {
  if (!url) return url;
  return url.replace(/([?&]token=)[^&]+/i, '$1***');
}
