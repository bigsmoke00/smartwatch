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
  }
}
