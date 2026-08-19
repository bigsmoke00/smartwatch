import { requireSecret } from '../common/env-secret';
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LogScanService } from './log-scan.service';
import { LogScanGateway } from './log-scan.gateway';
import { LogScanController } from './log-scan.controller';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';
import { RolesModule } from '../roles/roles.module';

@Module({
  imports: [
    DockerManagerModule, // dá acesso ao ControlGateway (canal agent <-> backend)
    RolesModule, // LogScanGateway checa logs:read na autenticação do WS
    JwtModule.register({ secret: requireSecret('JWT_SECRET') }),
  ],
  providers: [LogScanService, LogScanGateway],
  controllers: [LogScanController],
})
export class LogScanModule {}
