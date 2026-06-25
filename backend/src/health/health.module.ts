import {
  Controller,
  Get,
  Inject,
  Module,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Pool } from 'pg';
import * as prom from 'prom-client';
import { Public } from '../auth/public.decorator';
import { PG_POOL } from '../db/db.module';
// Versão do backend — importada direto do package.json (resolveJsonModule),
// fonte única que não desatualiza sozinha como um literal hardcoded faria.
// Funciona em dev (src/health -> ../../package.json -> backend/package.json)
// e em produção (dist/health -> ../../package.json -> backend/package.json,
// já que o Dockerfile copia package.json lado a lado com dist/).
import pkg from '../../package.json';

const BACKEND_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0-unknown';

const registry = new prom.Registry();
prom.collectDefaultMetrics({ register: registry });

export const httpRequestsTotal = new prom.Counter({
  name: 'logwatch_http_requests_total',
  help: 'HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [registry],
});
export const logsIngested = new prom.Counter({
  name: 'logwatch_logs_ingested_total',
  help: 'Total log lines ingested',
  registers: [registry],
});
export const dbPoolWaiting = new prom.Gauge({
  name: 'logwatch_pg_waiting',
  help: 'Postgres pool waiting clients',
  registers: [registry],
});

@Controller()
class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Public()
  @Get('health')
  async health() {
    let pgOk = false;
    try {
      await this.pool.query('SELECT 1');
      pgOk = true;
    } catch {}
    return {
      status: pgOk ? 'ok' : 'degraded',
      version: BACKEND_VERSION,
      uptime: process.uptime(),
      pg: pgOk,
      ts: Date.now(),
    };
  }

  @Public()
  @Get('readyz')
  readyz() {
    return { ok: true };
  }

  @Public()
  @Get('metrics')
  async metrics(@Res() res: Response) {
    dbPoolWaiting.set(this.pool.waitingCount);
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
