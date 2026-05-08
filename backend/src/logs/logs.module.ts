import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LogsService } from './logs.service';
import { LogsController } from './logs.controller';
import { LogsGateway } from './logs.gateway';
import { LogsRepository } from './logs.repository';
import { ApiKeyGuard } from './api-key.guard';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [
    ServersModule,
    JwtModule.register({ secret: process.env.JWT_SECRET ?? 'dev-secret' }),
  ],
  providers: [LogsService, LogsRepository, LogsGateway, ApiKeyGuard],
  controllers: [LogsController],
  exports: [LogsRepository, LogsService],
})
export class LogsModule {}
