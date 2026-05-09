import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { PermissionsGuard } from '../auth/permissions.guard';

@Global()
@Module({
  providers: [
    RolesService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  controllers: [RolesController],
  exports: [RolesService],
})
export class RolesModule {}
