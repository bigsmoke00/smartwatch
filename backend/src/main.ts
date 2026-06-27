import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  app.setGlobalPrefix('api');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const swagger = new DocumentBuilder()
    .setTitle('LogWatch API')
    .setDescription('Plataforma de gerenciamento e visualização de logs/infra')
    .setVersion('0.2.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, swagger));

  const port = parseInt(process.env.PORT ?? '4000', 10);
  await app.listen(port, '0.0.0.0');

  // Node 18+ mata a conexão sozinho se o servidor não terminar de enviar os
  // headers da resposta em 60s (`headersTimeout`, proteção padrão contra
  // slow-loris) ou não fechar a request inteira em 5min (`requestTimeout`).
  // A busca de logs (/logs) pode legitimamente passar disso numa janela de
  // tempo grande com volume alto — antes disso o socket caía sozinho
  // ("ECONNRESET"/"socket hang up") no meio da query, e a tela de Logs
  // ficava com o overlay "Atualizando para o novo filtro…" presa em cima
  // dos dados antigos até a request falhar. Aumentando esses timeouts dá
  // tempo da query (mesmo pesada) terminar e responder normalmente.
  const httpServer = app.getHttpServer();
  httpServer.headersTimeout = 120_000;  // 2min (padrão Node: 60s)
  httpServer.requestTimeout = 600_000;  // 10min (padrão Node: 5min)
  httpServer.keepAliveTimeout = 65_000; // > timeout típico de proxy (60s), evita corrida na reutilização da conexão

  new Logger('Bootstrap').log(`LogWatch backend listening on :${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
