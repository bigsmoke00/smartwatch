import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

// Redis já existe no docker-compose (serviço "redis", REDIS_HOST/REDIS_PORT no
// .env.example) mas até agora nada no backend usava de fato — ioredis estava
// só como dependência solta no package.json. Esse módulo abre uma única
// conexão compartilhada (singleton, via DI) pra qualquer serviço que precise
// de cache persistente entre instâncias do backend (ex.: pg-monitor "Saúde").
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis =>
        new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
          // Não derruba o boot do backend se o Redis ainda não estiver de pé
          // (ex.: ordem de subida no compose) — tenta de novo em background.
          retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
          maxRetriesPerRequest: 2,
          lazyConnect: false,
        }),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
