import { Global, Module } from '@nestjs/common';
import { EnvironmentsService } from './environments.service';
import { EnvironmentsController } from './environments.controller';

/**
 * Global: o EnvironmentsService e consumido pelo PermissionsGuard (que vive no
 * RolesModule) para resolver o header X-Environment em id de ambiente.
 */
@Global()
@Module({
  providers: [EnvironmentsService],
  controllers: [EnvironmentsController],
  exports: [EnvironmentsService],
})
export class EnvironmentsModule {}
