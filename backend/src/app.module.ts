import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { DbModule } from './db/db.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
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
import { HealthModule } from './health/health.module';
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
    AuditModule,
    AuthModule,
    UsersModule,
    RolesModule,
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
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    BootstrapService,
  ],
})
export class AppModule {}
