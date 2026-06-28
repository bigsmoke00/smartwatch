import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PG_POOL } from './db.module';

/**
 * VACUUM FULL noturno (3h) de TODA a base — não só `logs`.
 *
 * Contexto: vários módulos guardam histórico em hypertables (logs,
 * audit_events, script_executions, terminal_session_events, pg_metrics,
 * etc.) e algumas tabelas normais também acumulam bloat com o tempo. Boa
 * parte usa retention_policy nativa do TimescaleDB (drop_chunks — devolve
 * o espaço ao SO na hora), mas `logs` em particular usa DELETE manual por
 * servidor (retenção configurável por servidor, ver migration 019), e
 * DELETE não devolve espaço ao SO até alguém reescrever a tabela/chunk.
 *
 * Testamos pg_repack em produção pra resolver isso e o TimescaleDB rejeita
 * (chunks não aceitam o `ALTER TABLE ... ENABLE ALWAYS TRIGGER` que o
 * pg_repack precisa pra funcionar sem lock — "operation not supported on
 * chunk tables"). Não é erro de instalação, é incompatibilidade conhecida
 * entre pg_repack e hypertables. Por isso usamos VACUUM (FULL, ANALYZE)
 * direto — funciona em qualquer tabela normal e em chunk de hypertable.
 *
 * VACUUM FULL toma lock exclusivo NA TABELA/CHUNK (não no banco todo)
 * durante a execução — por isso:
 *   - só processamos chunks cujo intervalo de tempo já terminou há pelo
 *     menos 2 dias, pra nunca travar o chunk atual de nenhuma hypertable
 *     (que ainda recebe inserts em tempo real);
 *   - tabelas normais (schema public, não-hypertable) são tipicamente
 *     pequenas (config/cadastro), processadas uma por vez, lock breve.
 *
 * DESLIGADO por padrão — LOGWATCH_VACUUM_FULL_ENABLED=true pra ativar.
 */
@Injectable()
export class DbMaintenanceService {
  private readonly logger = new Logger(DbMaintenanceService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Cron('0 3 * * *')
  async runFullVacuum() {
    if (process.env.LOGWATCH_VACUUM_FULL_ENABLED !== 'true') return;
    return this.vacuumAll();
  }

  async vacuumAll() {
    const targets = await this.pool.query<{ target: string }>(
      `SELECT chunk_schema || '.' || chunk_name AS target
         FROM timescaledb_information.chunks
        WHERE range_end < now() - interval '2 days'
       UNION ALL
       SELECT schemaname || '.' || tablename AS target
         FROM pg_tables
        WHERE schemaname = 'public'
       ORDER BY 1`,
    );
    if (!targets.rowCount) {
      this.logger.log('VACUUM FULL: nenhuma tabela/chunk elegível encontrada');
      return { ok: 0, failed: 0 };
    }

    let ok = 0;
    let failed = 0;
    for (const t of targets.rows) {
      const [schema, name] = t.target.split('.');
      const table = `"${schema}"."${name}"`;
      try {
        await this.pool.query(`VACUUM (FULL, ANALYZE) ${table}`);
        ok++;
      } catch (e: any) {
        failed++;
        this.logger.error(`VACUUM FULL falhou em ${table}: ${e?.message ?? e}`);
      }
    }
    this.logger.log(`VACUUM FULL: ${ok} tabela(s)/chunk(s) ok, ${failed} falha(s)`);
    return { ok, failed };
  }
}
