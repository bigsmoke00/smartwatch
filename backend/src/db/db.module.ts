import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

// Importante: este módulo NÃO deve importar nada de `../db-maintenance` (ou
// de qualquer outro módulo que importe PG_POOL daqui) — isso cria um import
// circular que, em CommonJS, faz PG_POOL chegar `undefined` no @Inject do
// outro lado (já aconteceu: DbMaintenanceService ficava sem dependência
// resolvida no boot, derrubando o backend). DbModule é @Global(), então
// qualquer módulo pode importar PG_POOL de aqui livremente, só não o
// inverso.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: (): Pool =>
        new Pool({
          host: process.env.POSTGRES_HOST,
          port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
          user: process.env.POSTGRES_USER,
          password: process.env.POSTGRES_PASSWORD,
          database: process.env.POSTGRES_DB,
          max: parseInt(process.env.PG_POOL_MAX ?? '20', 10),
          idleTimeoutMillis: 30_000,
          // ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
        }),
    },
  ],
  exports: [PG_POOL],
})
export class DbModule {}
