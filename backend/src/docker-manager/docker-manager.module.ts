import { Module } from '@nestjs/common';
import { ControlGateway } from './control.gateway';
import { DockerManagerController } from './docker-manager.controller';
import { ServersModule } from '../servers/servers.module';

@Module({
  imports: [ServersModule],
  providers: [ControlGateway],
  controllers: [DockerManagerController],
  exports: [ControlGateway],
})
export class DockerManagerModule {}
