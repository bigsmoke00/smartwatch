import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Pool } from 'pg';
import { UsersService } from './users/users.service';
import { PG_POOL } from './db/db.module';

@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger('BootstrapService');

  constructor(
    private readonly users: UsersService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Verifica se as migrations rodaram
    try {
      const r = await this.pool.query(
        `SELECT count(*)::int n FROM information_schema.tables
         WHERE table_name='users' AND table_schema='public'`,
      );
      if (r.rows[0].n === 0) {
        this.logger.error(
          'Tabelas não encontradas. Rode `npm run migrate` antes de iniciar o backend.',
        );
        return;
      }
    } catch (e) {
      this.logger.error('Falha ao verificar schema', e as Error);
      return;
    }

    const email = process.env.ADMIN_EMAIL ?? 'admin@logwatch.local';
    const password = process.env.ADMIN_PASSWORD ?? 'ChangeMe!123';
    const created = await this.users.ensureAdmin(email, password);
    if (created) {
      this.logger.warn(
        `Initial admin created (${email}). CHANGE THE PASSWORD NOW.`,
      );
    }

    await this.seedLegacyPatroniCluster();
  }

  /**
   * Migra o PATRONI_NODES/PATRONI_BASIC_AUTH (env, cluster único e fixo) para
   * um registro em patroni_clusters na primeira vez que o backend sobe com a
   * tabela vazia, para não perder a config já existente em produção.
   * Depois disso, clusters são cadastrados/removidos pela UI.
   */
  private async seedLegacyPatroniCluster(): Promise<void> {
    const nodes = (process.env.PATRONI_NODES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!nodes.length) return;
    try {
      const r = await this.pool.query(`SELECT count(*)::int n FROM patroni_clusters`);
      if (r.rows[0].n > 0) return;
      await this.pool.query(
        `INSERT INTO patroni_clusters(name, description, nodes, basic_auth)
         VALUES ('legacy', 'Migrado automaticamente de PATRONI_NODES', $1, $2)`,
        [nodes, process.env.PATRONI_BASIC_AUTH || null],
      );
      this.logger.warn(
        `Cluster Patroni "legacy" criado a partir de PATRONI_NODES. ` +
          `Pode remover essa env var e gerenciar pela tela de Cluster Patroni.`,
      );
    } catch (e) {
      this.logger.error('Falha ao migrar PATRONI_NODES para patroni_clusters', e as Error);
    }
  }
}
