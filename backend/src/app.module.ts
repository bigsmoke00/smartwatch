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
import { ServersModule } from './servers/servers.module';
import { LogsModule } from './logs/logs.module';
import { MetricsModule } from './metrics/metrics.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AlertsModule } from './alerts/alerts.module';
import { AutomationModule } from './automation/automation.module';
import { InventoryModule } from './inventory/inventory.module';
import { PatroniModule } from './patroni/patroni.module';
import { SecretsModule } from './secrets/secrets.module';
import { SavedQueriesModule } from './saved-queries/saved-queries.module';
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
    ServersModule,
    LogsModule,
    MetricsModule,
    NotificationsModule,
    AlertsModule,
    AutomationModule,
    InventoryModule,
    PatroniModule,
    SecretsModule,
    SavedQueriesModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    BootstrapService,
  ],
})
export class AppModule {}
