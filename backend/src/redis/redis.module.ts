import { Global, Logger, Module } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

const logger = new Logger('RedisModule');

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
      useFactory: (): Redis => {
        const client = new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
          // Não derruba o boot do backend se o Redis ainda não estiver de pé
          // (ex.: ordem de subida no compose, ou ambiente sem Redis algum)
          // — tenta de novo em background, sem nunca travar quem chama.
          retryStrategy: (attempt) => Math.min(attempt * 500, 5000),
          connectTimeout: 3000,
          // Falha rápido em vez de enfileirar/esperar reconexão: quem chama
          // (pg-monitor) já trata erro do Redis como "sem cache" e cai pro
          // cálculo em tempo real — não pode deixar a requisição HTTP
          // esperando o Redis tentar se reconectar.
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
          lazyConnect: false,
        });
        // ioredis (como todo EventEmitter) derruba o processo se 'error' for
        // emitido sem nenhum listener — isso por si só já causaria 500/crash
        // no ambiente sem Redis. Loga em debug (é esperado falhar/retry se o
        // serviço não existir nesse ambiente) e nunca deixa subir.
        client.on('error', (err) => logger.debug(`Redis: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule {}
