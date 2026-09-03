import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { PermissionsGuard } from '../auth/permissions.guard';
import { EnvironmentsModule } from '../environments/environments.module';

@Global()
@Module({
  // Importa EnvironmentsModule explicitamente: o PermissionsGuard (APP_GUARD
  // deste módulo) injeta o EnvironmentsService para resolver o header
  // X-Environment. Sem esse import, a resolução dependia da ordem de registro
  // dos módulos @Global e podia falhar no boot (Nest can't resolve deps).
  imports: [EnvironmentsModule],
  providers: [
    RolesService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  controllers: [RolesController],
  exports: [RolesService],
})
export class RolesModule {}
