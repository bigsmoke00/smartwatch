import { Module } from '@nestjs/common';
import { ScriptsService } from './scripts.service';
import { ScriptsController } from './scripts.controller';
import { DockerManagerModule } from '../docker-manager/docker-manager.module';

@Module({
  imports: [DockerManagerModule],
  providers: [ScriptsService],
  controllers: [ScriptsController],
  exports: [ScriptsService],
})
export class ScriptsModule {}
