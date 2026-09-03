import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { EnvironmentsModule } from './environments/environments.module';
import { ServersModule } from './servers/servers.module';
import { LogsModule } from './logs/logs.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlertsModule } from './alerts/alerts.module';
import { PatroniModule } from './patroni/patroni.module';
import { SecretsModule } from './secrets/secrets.module';
import { SavedQueriesModule } from './saved-queries/saved-queries.module';
import { FinopsModule } from './finops/finops.module';
import { CredentialRotationModule } from './credential-rotation/credential-rotation.module';
import { DockerManagerModule } from './docker-manager/docker-manager.module';
import { ScriptsModule } from './scripts/scripts.module';
import { LogExportModule } from './log-export/log-export.module';
import { ZeroTrustModule } from './zero-trust/zero-trust.module';
import { PgMonitorModule } from './pg-monitor/pg-monitor.module';
import { DbAccessModule } from './db-access/db-access.module';
import { CaptureModule } from './capture/capture.module';
import { LogScanModule } from './log-scan/log-scan.module';
import { HealthModule } from './health/health.module';
import { DbMaintenanceModule } from './db-maintenance/db-maintenance.module';
import { DeployModule } from './deploy/deploy.module';
import { MonitorModule } from './monitor/monitor.module';
import { CertModule } from './cert-watch/cert.module';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: process.env.NODE_ENV !== 'production'
          ? { target: 'pino-pretty', options: { singleLine: true } }
          : undefined,
        /**
         * Loga requisições bem-sucedidas (2xx/3xx) em "debug" — só aparecem
         * se LOG_LEVEL=debug. Erros (4xx/5xx) continuam visíveis em "warn"/
         * "error" mesmo com LOG_LEVEL=info (padrão), pra não esconder
         * problemas reais (ex.: 401 de login, payload too large) no meio do
         * tráfego de rotina dos agents (ingest/heartbeat/metrics).
         */
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'debug';
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            '*.password',
            '*.passwordHash',
            '*.secret',
            '*.totpSecret',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 30 },
      { name: 'long', ttl: 60_000, limit: 600 },
    ]),

    DbModule,
    RedisModule,
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
    EnvironmentsModule,
    ServersModule,
    LogsModule,
    MetricsModule,
    NotificationsModule,
    AlertsModule,
    PatroniModule,
    SecretsModule,
    SavedQueriesModule,
    FinopsModule,
    CredentialRotationModule,
    DockerManagerModule,
    ScriptsModule,
    LogExportModule,
    ZeroTrustModule,
    PgMonitorModule,
    DbAccessModule,
    CaptureModule,
    LogScanModule,
    HealthModule,
    DbMaintenanceModule,
    DeployModule,
    MonitorModule,
    CertModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    BootstrapService,
  ],
})
export class AppModule {}
