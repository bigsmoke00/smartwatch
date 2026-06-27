import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

const execFileAsync = promisify(execFile);

/**
 * Reclama o espaço em disco perdido por bloat do MVCC (DELETE/UPDATE não
 * devolvem espaço pro SO sozinhos — só VACUUM FULL ou pg_repack fazem isso).
 *
 * Por que pg_repack e não VACUUM FULL: o pg_repack reconstrói a tabela em
 * background e faz uma troca atômica no final (segundos), sem o lock
 * ACCESS EXCLUSIVE de longa duração do VACUUM FULL — a ingestão de logs não
 * para durante a rotina.
 *
 * Por que isso roda DENTRO do backend (e não num sidecar/scheduler externo
 * como ofelia): a app já carrega as credenciais do próprio banco (mesmas
 * env vars do DbModule) e essa rotina precisa sobreviver à futura migração
 * do Postgres de container Docker para uma instância compilada standalone —
 * conectar via host:port comum (como qualquer client psql) é o que torna
 * isso portável, sem depender de `docker exec` ou de hostname de container.
 *
 * Segurança: a senha NUNCA aparece em argv/log — só é passada via `env` do
 * subprocesso (mesmo padrão de um .pgpass), e nenhum stdout/stderr é
 * persistido em lugar nenhum além do log de aplicação (não vai pra tabela
 * de auditoria).
 */
@Injectable()
export class DbMaintenanceService {
  private readonly logger = new Logger(DbMaintenanceService.name);
  private running = false;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runPgRepack() {
    if (this.running) {
      this.logger.warn('pg_repack: execução anterior ainda em andamento, pulando este ciclo');
      return;
    }
    this.running = true;
    const startedAt = Date.now();
    try {
      await this.ensureExtension();

      const host = process.env.POSTGRES_HOST ?? 'postgres';
      const port = process.env.POSTGRES_PORT ?? '5432';
      const user = process.env.POSTGRES_USER ?? '';
      const database = process.env.POSTGRES_DB ?? '';
      const password = process.env.POSTGRES_PASSWORD ?? '';

      this.logger.log(`pg_repack: iniciando manutenção noturna em ${database}@${host}:${port}`);

      // --no-superuser-check: o usuário da app normalmente não é superuser.
      // Tabelas sem chave primária/índice único caem no modo --no-order, que
      // trava igual VACUUM FULL — aceitável aqui pois roda fora do horário
      // de pico (3h) e é melhor que nunca reclamar o espaço.
      const { stdout, stderr } = await execFileAsync(
        'pg_repack',
        ['-h', host, '-p', port, '-U', user, '-d', database, '--no-superuser-check', '-j', '2'],
        {
          env: { ...process.env, PGPASSWORD: password },
          timeout: 2 * 60 * 60 * 1000, // 2h de teto de segurança
        },
      );

      if (stdout?.trim()) this.logger.log(`pg_repack stdout: ${stdout.trim()}`);
      if (stderr?.trim()) this.logger.warn(`pg_repack stderr: ${stderr.trim()}`);

      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      this.logger.log(`pg_repack: concluído em ${elapsedSec}s`);
    } catch (e: any) {
      // e.cmd pode conter os argumentos (sem senha, ela só vai via env) —
      // ainda assim logamos só a mensagem, nunca o objeto de erro inteiro.
      this.logger.error(`pg_repack: falhou — ${e?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  private async ensureExtension() {
    // Idempotente — só cria na primeira vez (volumes já existentes não vêm
    // com a extensão criada, mesmo já tendo os arquivos da extensão na
    // imagem do Postgres).
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_repack;');
  }
}
