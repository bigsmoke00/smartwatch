import { Global, Module } from '@nestjs/common';
import { Pool } from 'pg';

export const PG_POOL = 'PG_POOL';

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
